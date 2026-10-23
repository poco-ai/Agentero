/**
 * Paper import actions: magic-wand identifier lookup, Skill install and
 * local-PDF import. Each flow enqueues a JobCenter `import` job and hosts its
 * renderer executor, so scheduling / progress / cancellation live in one place.
 */

import i18n from "@/i18n";
import { track } from "@/lib/activity";
import { isBackgroundTaskCancelledError } from "@/lib/core/background-tasks";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { logger } from "@/lib/core/logger";
import { notifyError, notifySuccess, notifyWarning } from "@/lib/core/notify";
import {
	awaitTaskSettled,
	cancelTask,
	enqueueTask,
	enqueueTaskSettled,
	reportTaskPhase,
	type TaskExecutorContext,
	throwIfTaskCancelled,
} from "@/lib/core/tasks";
import { currentLookupParentDir } from "@/lib/paper/library-actions";
import {
	libraryStore,
	refreshLibrary,
	setCitingScanDraft,
	setLibraryIoBusy,
} from "@/lib/paper/library-store";
import {
	addPapersByIdentifiers,
	discardSkillDiscovery,
	importLocalPdfs,
	installDiscoveredSkills,
	type LocalPdfImportEntry,
	type LookupBatchAddResult,
	looksLikeTitleSearchQuery,
	type PaperSearchCandidate,
	type SkillImportResult,
} from "@/lib/paper/lookup";
import { enqueuePaperLayoutAnalysis } from "@/lib/pdf/layout";
import { getSettings } from "@/lib/settings/react-store";
import {
	cleanupImportTempPaths,
	isImportTempPath,
	normalizeDroppedPath,
} from "@/lib/shell/external-file-drop";
import {
	addPaperSearchDraft,
	bumpLookupOpenSignal,
	clearPaperSearchDraft,
	layout,
	setSkillImportDraft,
	settlePaperSearchDraft,
	shiftPaperSearchDraft,
	uiStore,
} from "@/lib/shell/ui-store";
import { joinVaultPath } from "@/lib/vault";
import { getVaultPath, refreshTree } from "@/lib/vault/store";
import { toVaultRelative } from "@/lib/wiki";

/** ⇧⌘I — expand the left rail (popover owns focus) and open the wand. */
export function openMagicWand(): void {
	if (!getVaultPath()) {
		notifyError(i18n.t("sidebar:lookup.needsVault"));
		return;
	}
	if (uiStore.getState().sidebarCollapsed) {
		layout()?.setLeftCollapsed(false);
	}
	bumpLookupOpenSignal();
}

export type LookupSubmitOptions = {
	/** Vault-relative destination, e.g. `papers` or `papers/nlp`. Defaults to the current tree selection. */
	parentDir?: string;
	/** Run after one input has finished importing (store refresh is debounced via paper:imported). */
	onComplete?: (result: LookupBatchAddResult) => void | Promise<void>;
};

/** In-flight title-search jobs; closing the picker card cancels them. */
const pendingSearchJobIds = new Set<string>();

type LocalPdfDropRequest = {
	vaultPath: string;
	entries: LocalPdfImportEntry[];
	parentDir: string;
};

/** Preserve rapid consecutive drops instead of discarding them while busy. */
const localPdfDropQueue: LocalPdfDropRequest[] = [];
let localPdfDropRunning = false;
let localPdfDropIdleUnsubscribe: (() => void) | null = null;

function drainLocalPdfDropQueue(): void {
	if (localPdfDropRunning || localPdfDropQueue.length === 0) return;
	if (libraryStore.getState().ioBusy) {
		if (localPdfDropIdleUnsubscribe) return;
		const unsubscribe = libraryStore.subscribe((state) => {
			if (state.ioBusy) return;
			localPdfDropIdleUnsubscribe = null;
			unsubscribe();
			drainLocalPdfDropQueue();
		});
		localPdfDropIdleUnsubscribe = unsubscribe;
		return;
	}

	localPdfDropRunning = true;
	void (async () => {
		try {
			while (localPdfDropQueue.length > 0) {
				const request = localPdfDropQueue.shift();
				if (!request) break;
				await importLocalPdf(request);
			}
		} finally {
			localPdfDropRunning = false;
			drainLocalPdfDropQueue();
		}
	})();
}

/**
 * Results the executor produced, keyed by job id: the submitter settles its
 * `onComplete` from them. Bounded because a deduped job can have several
 * waiters and a reload leaves entries unread.
 */
const lookupResults = new Map<string, LookupBatchAddResult>();
const MAX_LOOKUP_RESULTS = 16;

function stashLookupResult(jobId: string, result: LookupBatchAddResult): void {
	lookupResults.set(jobId, result);
	while (lookupResults.size > MAX_LOOKUP_RESULTS) {
		const oldest = lookupResults.keys().next().value;
		if (oldest === undefined) break;
		lookupResults.delete(oldest);
	}
}

export async function lookupSubmit(
	texts: string[],
	opts: LookupSubmitOptions = {},
): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath) {
		throw new Error(i18n.t("sidebar:lookup.needsVault"));
	}
	if (texts.length === 0) return;
	const parentDir = opts.parentDir ?? currentLookupParentDir();

	const promises: Promise<void>[] = [];
	for (const text of texts) {
		const input = text.trim();
		if (!input) continue;
		// Open the picker immediately with shimmer when input looks like a title
		// (#438). settlePaperSearchDraft no-ops if the user already cancelled.
		const expectTitleSearch = looksLikeTitleSearchQuery(input);
		if (expectTitleSearch) {
			addPaperSearchDraft([
				{ query: input, candidates: [], parentDir, pending: true },
			]);
		}
		promises.push(
			(async () => {
				const job = await enqueueTask({
					kind: "import",
					vaultPath,
					path: parentDir,
					lane: "normal",
					params: {
						mode:
							inferLookupSource(input) === "skill" ? "skillLookup" : "lookup",
						text: input,
					},
				});
				if (expectTitleSearch) pendingSearchJobIds.add(job.id);
				try {
					await awaitTaskSettled(job);
					const result = lookupResults.get(job.id);
					if (result) await opts.onComplete?.(result);
				} finally {
					pendingSearchJobIds.delete(job.id);
				}
			})().catch((e) => {
				if (isBackgroundTaskCancelledError(e)) return;
				notifyError(`${input}: ${errorText(e)}`);
			}),
		);
	}
	await Promise.all(promises);
}

/** Executor body of a magic-wand (`mode: "lookup"`) import job. */
export async function runLookupImportJob(
	ctx: TaskExecutorContext,
): Promise<void> {
	const vaultPath = ctx.vaultPath;
	const parentDir = ctx.paperPath || "papers";
	const input = lookupJobText(ctx.params);
	if (!input) throw new Error("import job is missing its identifier");
	const settings = getSettings();
	const expectTitleSearch = looksLikeTitleSearchQuery(input);
	const isSkillLookup = lookupJobMode(ctx.params) === "skillLookup";

	await reportTaskPhase(
		ctx,
		i18n.t(
			isSkillLookup
				? "app:tasks.skillLookupFetching"
				: "app:tasks.lookupFetching",
		),
	);
	const result = await addPapersByIdentifiers({
		vaultRoot: vaultPath,
		parentDir,
		texts: [input],
		settings,
		// The job id doubles as the Host progress + cooperative-cancel task id.
		progressTaskId: ctx.jobId,
	});
	throwIfTaskCancelled(ctx);
	stashLookupResult(ctx.jobId, result);

	// Prefer the resolved paper title on the task row (never the identifier).
	const importedTitle = result.imported
		.map((paper) => paper.title?.trim())
		.find(Boolean);
	if (importedTitle) {
		await reportTaskPhase(ctx, importedTitle);
	}

	// Tree / wiki / library refresh runs via the paper:imported handler.
	if (result.skillCandidates.length > 0) {
		setSkillImportDraft(result.skillCandidates);
		await reportTaskPhase(
			ctx,
			i18n.t("sidebar:lookup.skillCandidatesFound", {
				count: result.skillCandidates.reduce(
					(total: number, discovery) => total + discovery.candidates.length,
					0,
				),
			}),
		);
	}

	if (expectTitleSearch) {
		const matched =
			result.searchCandidates.find((group) => group.query === input) ??
			result.searchCandidates[0] ??
			null;
		settlePaperSearchDraft(
			input,
			matched ? { ...matched, parentDir, pending: false } : null,
		);
		if (matched) {
			await reportTaskPhase(
				ctx,
				i18n.t("sidebar:lookup.searchCandidatesFound", {
					count: matched.candidates.length,
				}),
			);
		}
	} else if (result.searchCandidates.length > 0) {
		addPaperSearchDraft(
			result.searchCandidates.map((group) => ({ ...group, parentDir })),
		);
		await reportTaskPhase(
			ctx,
			i18n.t("sidebar:lookup.searchCandidatesFound", {
				count: result.searchCandidates.reduce(
					(total: number, group) => total + group.candidates.length,
					0,
				),
			}),
		);
	}

	// Papers that already have a PDF after import: start layout now.
	// Those still downloading enqueue layout after DownloadAssets completes —
	// do not kick layout (or it fails with "No local PDF") before the file lands.
	await finishImportedPapers(vaultPath, result, input);
}

/** Shared post-import tail of the lookup executors: tracking, layout for
 * papers that already have a PDF, and asset downloads for the rest. */
async function finishImportedPapers(
	vaultPath: string,
	result: LookupBatchAddResult,
	sourceInput: string,
): Promise<void> {
	for (const paper of result.imported) {
		const rel = (paper.path || "")
			.replace(/\\/g, "/")
			.replace(/^\/+|\/+$/g, "");
		if (rel) {
			track("paper.import", {
				path: rel,
				extra: { source: inferLookupSource(sourceInput) },
			});
		}
	}
	for (const paper of result.imported) {
		if (!paper.pdf) continue;
		const abs = paper.paperDir
			? paper.paperDir.replace(/[\\/]+$/, "")
			: joinVaultPath(
					vaultPath,
					(paper.path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
				);
		if (abs) {
			const rel = toVaultRelative(vaultPath, abs)
				.replace(/\\/g, "/")
				.replace(/^\/+|\/+$/g, "");
			void callApiResult(
				() =>
					commands.jobLayoutAnalyzeEnqueue({
						vaultPath,
						path: rel,
						force: false,
					}),
				{ fallback: "layout analysis enqueue failed" },
			);
		}
	}

	if (result.errors.length > 0) {
		notifyError(result.errors.join("; "));
	}

	// Enqueue a DownloadAssets job for each newly imported paper that
	// still lacks assets. Uses the CapsCache-backed query (§8.4) instead
	// of the frontend tree walk; the runner is idempotent and backfills
	// PAPER.md + layout.
	const newPaths = result.imported
		.map((r) => (r.path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
		.filter(Boolean);
	if (newPaths.length === 0) return;
	let needingAssets: string[] = [];
	try {
		needingAssets = await callApiResult(
			() => commands.jobPapersNeedingAssets({ vaultPath }),
			{ fallback: "collect papers needing assets failed" },
		);
	} catch (e) {
		logger.warn("post-import asset check failed", { error: errorText(e) });
	}
	const needingSet = new Set(
		needingAssets.map((p) => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")),
	);
	for (const rel of newPaths) {
		if (!needingSet.has(rel)) continue;
		void callApiResult(
			() =>
				commands.jobDownloadAssetsEnqueue({
					vaultPath,
					path: rel,
					lane: "normal",
					force: false,
				}),
			{ fallback: "download enqueue failed" },
		).catch((e) =>
			logger.warn("post-import download enqueue failed", {
				rel,
				error: errorText(e),
			}),
		);
	}
}

/** Executor body of a chat-paste review batch (`mode: "lookupBatch"`) job —
 * one Host `lookup_import_batch` call for the whole checklist, so batch-level
 * dedup applies and the row shows n/total progress. */
export async function runLookupBatchImportJob(
	ctx: TaskExecutorContext,
): Promise<void> {
	const vaultPath = ctx.vaultPath;
	const parentDir = ctx.paperPath || "papers";
	const texts = lookupJobTexts(ctx.params);
	if (texts.length === 0)
		throw new Error("import job is missing its identifiers");
	const settings = getSettings();

	await reportTaskPhase(ctx, i18n.t("app:tasks.lookupFetching"));
	const result = await addPapersByIdentifiers({
		vaultRoot: vaultPath,
		parentDir,
		texts,
		settings,
		progressTaskId: ctx.jobId,
	});
	throwIfTaskCancelled(ctx);
	stashLookupResult(ctx.jobId, result);

	if (result.imported.length > 0) {
		await reportTaskPhase(
			ctx,
			i18n.t("sidebar:lookup.batchDone", { count: result.imported.length }),
		);
	}
	if (result.skillCandidates.length > 0) {
		setSkillImportDraft(result.skillCandidates);
	}

	await finishImportedPapers(vaultPath, result, texts[0] ?? "");
}

/** Submit the confirmed chat-paste checklist as ONE batch import job and
 * surface its failure to the popover. */
export async function lookupBatchSubmit(texts: string[]): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath) throw new Error(i18n.t("sidebar:lookup.needsVault"));
	const list = texts.map((t) => t.trim()).filter(Boolean);
	if (list.length === 0) return;
	const job = await enqueueTask({
		kind: "import",
		vaultPath,
		path: currentLookupParentDir(),
		lane: "normal",
		params: { mode: "lookupBatch", texts: list },
	});
	await awaitTaskSettled(job);
}

function lookupJobText(params: unknown): string {
	const text =
		params && typeof params === "object"
			? (params as { text?: unknown }).text
			: undefined;
	return typeof text === "string" ? text.trim() : "";
}

function lookupJobMode(params: unknown): string {
	const mode =
		params && typeof params === "object"
			? (params as { mode?: unknown }).mode
			: undefined;
	return typeof mode === "string" ? mode : "";
}

function lookupJobTexts(params: unknown): string[] {
	const texts =
		params && typeof params === "object"
			? (params as { texts?: unknown }).texts
			: undefined;
	if (!Array.isArray(texts)) return [];
	return texts
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
}

/** Picked a title-search candidate → import it as a normal identifier. */
export async function confirmPaperSearchImport(
	candidate: PaperSearchCandidate,
	parentDir: string,
): Promise<void> {
	shiftPaperSearchDraft();
	await lookupSubmit([candidate.identifier], { parentDir });
}

export function cancelPaperSearchImport(): void {
	// Closing the picker also ends the searches behind it: cancel each job so
	// its card stops immediately and the host skips the remaining queries.
	for (const jobId of pendingSearchJobIds) cancelTask(jobId);
	pendingSearchJobIds.clear();
	clearPaperSearchDraft();
}

type SkillImportSelection = { discoveryId: string; selectedNames: string[] };

export async function confirmSkillImport(
	selections: SkillImportSelection[],
): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath) return;
	setSkillImportDraft(null);
	try {
		await enqueueTaskSettled({
			kind: "import",
			vaultPath,
			path: "",
			lane: "normal",
			params: { mode: "skill", selections },
		});
	} catch (e) {
		notifyError(errorText(e));
	}
}

/** Executor body of a Skill-install (`mode: "skill"`) import job. */
export async function runSkillImportJob(
	ctx: TaskExecutorContext,
): Promise<void> {
	const vaultPath = ctx.vaultPath;
	const selections = skillJobSelections(ctx.params);
	await reportTaskPhase(ctx, i18n.t("sidebar:lookup.skillImporting"));
	const result: SkillImportResult[] = [];
	for (const selection of selections) {
		if (selection.selectedNames.length === 0) continue;
		result.push(
			...(await installDiscoveredSkills({
				vaultRoot: vaultPath,
				discoveryId: selection.discoveryId,
				selectedNames: selection.selectedNames,
			})),
		);
	}
	throwIfTaskCancelled(ctx);
	await refreshTree(vaultPath);
	const installed = result.filter((item) => !item.skipped);
	const installedCount = installed.length;
	const skippedCount = result.length - installedCount;
	if (installedCount > 0) {
		track("skill.install", {
			extra: {
				sourceKind: "github",
				installed: installed.map((item) => item.name),
				skipped: skippedCount,
			},
		});
	}
	notifySuccess(
		i18n.t("sidebar:lookup.skillImportDone", {
			installed: installedCount,
			skipped: skippedCount,
		}),
	);
}

function skillJobSelections(params: unknown): SkillImportSelection[] {
	const selections =
		params && typeof params === "object"
			? (params as { selections?: unknown }).selections
			: undefined;
	if (!Array.isArray(selections)) return [];
	return selections.filter(
		(item): item is SkillImportSelection =>
			Boolean(item) &&
			typeof item === "object" &&
			typeof (item as SkillImportSelection).discoveryId === "string" &&
			Array.isArray((item as SkillImportSelection).selectedNames),
	);
}

export function inferLookupSource(raw: string): string {
	const text = raw.trim();
	if (/npx\s+skills|github\.com|skills\.sh/i.test(text)) return "skill";
	if (/arxiv\.org|^\d{4}\.\d{4,5}(v\d+)?$/i.test(text)) return "arxiv";
	if (/^10\.\d{4,}/.test(text) || /^doi:/i.test(text)) return "doi";
	if (/^https?:\/\//i.test(text)) return "url";
	return "id";
}

export function cancelSkillImport(): void {
	const draft = uiStore.getState().skillImportDraft;
	setSkillImportDraft(null);
	for (const discovery of draft ?? []) {
		void discardSkillDiscovery(discovery.discoveryId);
	}
}

/** Import the checked reverse-citation candidates via the batch importer. */
export async function confirmCitingImport(
	identifiers: string[],
): Promise<void> {
	setCitingScanDraft(null);
	if (identifiers.length === 0) return;
	await lookupSubmit(identifiers, { parentDir: currentLookupParentDir() });
}

/** Nothing is staged for citing candidates, so closing is enough. */
export function cancelCitingImport(): void {
	setCitingScanDraft(null);
}

/**
 * Import local PDF file(s) → paper folders + catalog + PAPER.md.
 * - No args: native PDF picker (magic wand).
 * - `entries` + optional `parentDir`: OS-drop import.
 */
export async function importLocalPdf(opts?: {
	entries?: LocalPdfImportEntry[];
	parentDir?: string;
	vaultPath?: string;
}): Promise<void> {
	// Paths under ~/.agentero/import-tmp from path-less WKWebView drops.
	const stagingPaths = (opts?.entries ?? [])
		.map((e) => e.filePath)
		.filter(isImportTempPath);
	const activeVaultPath = getVaultPath();
	const vaultPath = opts?.vaultPath ?? activeVaultPath;
	if (
		!vaultPath ||
		(opts?.vaultPath != null && opts.vaultPath !== activeVaultPath)
	) {
		void cleanupImportTempPaths(stagingPaths);
		return;
	}
	if (libraryStore.getState().ioBusy) {
		void cleanupImportTempPaths(stagingPaths);
		return;
	}
	setLibraryIoBusy("import-pdf");
	try {
		await enqueueTaskSettled({
			kind: "import",
			vaultPath,
			path: opts?.parentDir ?? currentLookupParentDir(),
			lane: "normal",
			params: { mode: "localPdf", entries: opts?.entries ?? null },
		});
	} catch (e) {
		if (isBackgroundTaskCancelledError(e)) return;
		notifyError(errorText(e));
	} finally {
		setLibraryIoBusy(null);
		void cleanupImportTempPaths(stagingPaths);
	}
}

/** Executor body of a local-PDF (`mode: "localPdf"`) import job. */
export async function runLocalPdfImportJob(
	ctx: TaskExecutorContext,
): Promise<void> {
	const result = await importLocalPdfs({
		vaultRoot: ctx.vaultPath,
		parentDir: ctx.paperPath || "papers",
		entries: localPdfJobEntries(ctx.params),
		// The job id doubles as the Host parse-phase progress task id.
		progressTaskId: ctx.jobId,
	});
	// The user closed the picker: nothing imported, nothing to report.
	if (!result) return;
	throwIfTaskCancelled(ctx);
	await refreshLibrary();

	const merged = result.papers.filter((p) => p.status === "deduped");
	const created = result.papers.length - merged.length;
	await reportTaskPhase(
		ctx,
		created > 0
			? i18n.t("sidebar:papersLibrary.importPdfDone", { count: created })
			: merged.length === 1
				? i18n.t("sidebar:papersLibrary.importPdfMerged", {
						title: merged[0].title,
					})
				: i18n.t("sidebar:papersLibrary.importPdfMergedMany", {
						count: merged.length,
					}),
	);
	// Tree / wiki / library refresh runs via the paper:imported handler.
	for (const paper of result.papers) {
		if (paper.recognizePending) {
			// The RecognizeMetadata runner owns the follow-ups so they
			// run against the paper's final (post-rename) path.
			continue;
		}
		if (paper.paperDir) {
			enqueuePaperLayoutAnalysis({
				paperAbsPath: paper.paperDir.replace(/[\\/]+$/, ""),
				paperLabel: paper.title?.trim() || paper.path,
			});
		}
	}
	if (merged.length === 1) {
		notifySuccess(
			i18n.t("sidebar:papersLibrary.importPdfMerged", {
				title: merged[0].title,
			}),
		);
	} else if (merged.length > 1) {
		notifySuccess(
			i18n.t("sidebar:papersLibrary.importPdfMergedMany", {
				count: merged.length,
			}),
		);
	}
	if (result.errors.length) {
		const doneText =
			created > 0
				? `${i18n.t("sidebar:papersLibrary.importPdfDone", { count: created })}; `
				: "";
		notifyWarning(`${doneText}${result.errors.slice(0, 2).join("; ")}`);
	}
}

function localPdfJobEntries(
	params: unknown,
): LocalPdfImportEntry[] | undefined {
	const entries =
		params && typeof params === "object"
			? (params as { entries?: unknown }).entries
			: undefined;
	return Array.isArray(entries)
		? (entries as LocalPdfImportEntry[])
		: undefined;
}

/**
 * OS PDF drop onto a papers/ folder or the Library → instant import with
 * placeholder (filename-derived) metadata; a RecognizeMetadata job then
 * resolves identifiers in the background and renames the folder. The user
 * can always correct via Edit Metadata.
 */
export function dropLocalPdfs(
	items: Array<{ path: string; sourceName: string }>,
	parentDir: string,
): void {
	if (!items.length) return;
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const path = normalizeDroppedPath(item.path);
		if (!path || seen.has(path)) continue;
		seen.add(path);
		paths.push(path);
	}
	if (!paths.length) return;
	if (!getVaultPath()) {
		notifyWarning(i18n.t("app:errors.dropPdfNeedsVault"));
		void cleanupImportTempPaths(paths);
		return;
	}
	const vaultPath = getVaultPath();
	if (!vaultPath) return;
	localPdfDropQueue.push({
		vaultPath,
		entries: paths.map((filePath) => ({ filePath })),
		parentDir: parentDir || "papers",
	});
	drainLocalPdfDropQueue();
}
