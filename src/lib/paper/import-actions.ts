/**
 * Paper import actions: magic-wand identifier lookup, local-PDF import, and
 * the OS-drop confirm dialog flow. Heavy work runs as background tasks.
 */

import i18n from "@/i18n";
import {
	enqueueBackgroundTask,
	isBackgroundTaskCancelledError,
} from "@/lib/core/background-tasks";
import { invokeApi } from "@/lib/core/ipc";
import { logger } from "@/lib/core/logger";
import { notifyError, notifySuccess, notifyWarning } from "@/lib/core/notify";
import { currentLookupParentDir } from "@/lib/paper/library-actions";
import {
	libraryStore,
	refreshLibrary,
	setImportPdfDraft,
	setLibraryIoBusy,
} from "@/lib/paper/library-store";
import {
	addPapersByIdentifiers,
	discardSkillDiscovery,
	importLocalPdfs,
	installDiscoveredSkills,
	type LocalPdfImportEntry,
	type LookupBatchAddResult,
} from "@/lib/paper/lookup";
import { enqueuePaperLayoutAnalysis } from "@/lib/pdf/layout";
import { getSettings } from "@/lib/settings/react-store";
import {
	cleanupImportTempPaths,
	isImportTempPath,
} from "@/lib/shell/external-file-drop";
import {
	bumpLookupOpenSignal,
	layout,
	setSkillImportDraft,
	uiStore,
} from "@/lib/shell/ui-store";
import { joinVaultPath } from "@/lib/vault";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { getVaultPath, refreshTree } from "@/lib/vault/store";
import { toVaultRelative } from "@/lib/wiki";
import { rebuildWikiAndNotify } from "@/lib/wiki/store";
import { openPaper } from "@/lib/workspace/actions";

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
	/** Open the first newly imported paper after the import finishes. */
	openImported?: boolean;
	/** Vault-relative destination, e.g. `papers` or `papers/nlp`. Defaults to the current tree selection. */
	parentDir?: string;
	/** Run after one input has finished importing and stores have refreshed. */
	onComplete?: (result: LookupBatchAddResult) => void | Promise<void>;
};

export async function lookupSubmit(
	texts: string[],
	opts: LookupSubmitOptions = {},
): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath) {
		throw new Error(i18n.t("sidebar:lookup.needsVault"));
	}
	if (texts.length === 0) return;
	const settings = getSettings();
	const openImported = opts.openImported ?? true;

	for (const text of texts) {
		const input = text.trim();
		if (!input) continue;
		void enqueueBackgroundTask(
			{
				kind: "lookup",
				title: i18n.t("app:tasks.lookupImport"),
				detail: input.slice(0, 80),
			},
			async ({ id, setDetail }) => {
				setDetail(i18n.t("app:tasks.lookupFetching", { id: input }));
				const result = await addPapersByIdentifiers({
					vaultRoot: vaultPath,
					parentDir: opts.parentDir ?? currentLookupParentDir(),
					texts: [input],
					settings,
					progressTaskId: id,
				});

				await refreshTree(vaultPath);
				if (!isRemoteVaultHandle(vaultPath)) {
					await rebuildWikiAndNotify(vaultPath);
				}
				await refreshLibrary();
				if (result.skillCandidates.length > 0) {
					setSkillImportDraft(result.skillCandidates);
					setDetail(
						i18n.t("sidebar:lookup.skillCandidatesFound", {
							count: result.skillCandidates.reduce(
								(total: number, discovery) =>
									total + discovery.candidates.length,
								0,
							),
						}),
					);
				}

				const first = result.imported[0];
				if (first) {
					const paperAbs = first.paperDir
						? first.paperDir.replace(/[\\/]+$/, "")
						: joinVaultPath(
								vaultPath,
								(first.path || "")
									.replace(/\\/g, "/")
									.replace(/^\/+|\/+$/g, ""),
							);
					if (openImported) openPaper(paperAbs);
					setDetail(
						i18n.t("app:tasks.lookupRefreshing", { title: first.title }),
					);
				}
				// Papers that already have a PDF after import: start layout now.
				// Those still downloading enqueue layout after download completes.
				for (const paper of result.imported) {
					const abs = paper.paperDir
						? paper.paperDir.replace(/[\\/]+$/, "")
						: joinVaultPath(
								vaultPath,
								(paper.path || "")
									.replace(/\\/g, "/")
									.replace(/^\/+|\/+$/g, ""),
							);
					if (abs) {
						const rel = toVaultRelative(vaultPath, abs)
							.replace(/\\/g, "/")
							.replace(/^\/+|\/+$/g, "");
						void invokeApi(
							"job_layout_analyze_enqueue",
							{
								args: {
									vaultPath,
									path: rel,
									force: false,
								},
							},
							{ fallback: "layout analysis enqueue failed" },
						);
					}
				}

				if (result.errors.length > 0) {
					notifyError(`${input}: ${result.errors.join("; ")}`);
				}
				await opts.onComplete?.(result);

				// Enqueue a DownloadAssets job for each newly imported paper that
				// still lacks assets. Uses the CapsCache-backed query (§8.4) instead
				// of the frontend tree walk; the runner is idempotent and backfills
				// PAPER.md + layout.
				const newPaths = result.imported
					.map((r) =>
						(r.path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
					)
					.filter(Boolean);
				if (newPaths.length > 0) {
					let needingAssets: string[] = [];
					try {
						needingAssets = await invokeApi<string[]>(
							"job_papers_needing_assets",
							{ args: { vaultPath } },
							{ fallback: "collect papers needing assets failed" },
						);
					} catch (e) {
						logger.warn("post-import asset check failed", {
							error: e instanceof Error ? e.message : String(e),
						});
					}
					const needingSet = new Set(
						needingAssets.map((p) =>
							p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
						),
					);
					for (const rel of newPaths) {
						if (!needingSet.has(rel)) continue;
						void invokeApi(
							"job_download_assets_enqueue",
							{
								args: { vaultPath, path: rel, lane: "normal", force: false },
							},
							{ fallback: "download enqueue failed" },
						).catch((e) =>
							logger.warn("post-import download enqueue failed", {
								rel,
								error: e instanceof Error ? e.message : String(e),
							}),
						);
					}
				}
			},
			{ concurrency: settings.batchImportConcurrency },
		).catch((e) => {
			if (isBackgroundTaskCancelledError(e)) return;
			notifyError(`${input}: ${e instanceof Error ? e.message : String(e)}`);
		});
	}
}

export async function confirmSkillImport(
	selections: Array<{ discoveryId: string; selectedNames: string[] }>,
): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath) return;
	setSkillImportDraft(null);
	try {
		const result = await enqueueBackgroundTask(
			{
				kind: "import",
				title: i18n.t("sidebar:lookup.skillImportTask"),
				detail: i18n.t("sidebar:lookup.skillImporting"),
			},
			async () => {
				const installed = [];
				for (const selection of selections) {
					if (selection.selectedNames.length === 0) continue;
					installed.push(
						...(await installDiscoveredSkills({
							vaultRoot: vaultPath,
							discoveryId: selection.discoveryId,
							selectedNames: selection.selectedNames,
						})),
					);
				}
				await refreshTree(vaultPath);
				return installed;
			},
		);
		const installedCount = result.filter((item) => !item.skipped).length;
		const skippedCount = result.length - installedCount;
		notifySuccess(
			i18n.t("sidebar:lookup.skillImportDone", {
				installed: installedCount,
				skipped: skippedCount,
			}),
		);
	} catch (e) {
		notifyError(e instanceof Error ? e.message : String(e));
	}
}

export function cancelSkillImport(): void {
	const draft = uiStore.getState().skillImportDraft;
	setSkillImportDraft(null);
	for (const discovery of draft ?? []) {
		void discardSkillDiscovery(discovery.discoveryId);
	}
}

/**
 * Import local PDF file(s) → paper folders + catalog + PAPER.md.
 * - No args: native PDF picker (magic wand).
 * - `entries` + optional `parentDir`: confirm-dialog drop import.
 */
export async function importLocalPdf(opts?: {
	entries?: LocalPdfImportEntry[];
	parentDir?: string;
}): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath || libraryStore.getState().ioBusy) return;
	// Paths under ~/.agentero/import-tmp from path-less WKWebView drops.
	const stagingPaths = (opts?.entries ?? [])
		.map((e) => e.filePath)
		.filter(isImportTempPath);
	setLibraryIoBusy("import-pdf");
	try {
		const result = await enqueueBackgroundTask(
			{ kind: "import", title: i18n.t("app:tasks.importPdf") },
			async ({ id, setDetail }) => {
				const r = await importLocalPdfs({
					vaultRoot: vaultPath,
					parentDir: opts?.parentDir ?? currentLookupParentDir(),
					entries: opts?.entries,
					progressTaskId: id,
				});
				if (!r) return null;
				setDetail(
					i18n.t("sidebar:papersLibrary.importPdfDone", {
						count: r.papers.length,
					}),
				);
				await refreshTree(vaultPath);
				await rebuildWikiAndNotify(vaultPath);
				await refreshLibrary();
				return r;
			},
		);
		if (result) {
			if (result.papers[0]) openPaper(result.papers[0].paperDir);
			for (const paper of result.papers) {
				if (paper.paperDir) {
					enqueuePaperLayoutAnalysis({
						paperAbsPath: paper.paperDir.replace(/[\\/]+$/, ""),
						paperLabel: paper.title?.trim() || paper.path,
					});
				}
			}
			if (result.errors.length) {
				notifyWarning(
					`${i18n.t("sidebar:papersLibrary.importPdfDone", { count: result.papers.length })}; ${result.errors.slice(0, 2).join("; ")}`,
				);
			}
		}
	} catch (e) {
		if (isBackgroundTaskCancelledError(e)) return;
		notifyError(e instanceof Error ? e.message : String(e));
	} finally {
		setLibraryIoBusy(null);
		void cleanupImportTempPaths(stagingPaths);
	}
}

/** OS PDF drop onto a papers/ folder or the Library → metadata confirm dialog. */
export function dropLocalPdfs(
	items: Array<{ path: string; sourceName: string }>,
	parentDir: string,
): void {
	if (!items.length) return;
	const paths = items.map((i) => i.path);
	if (!getVaultPath()) {
		notifyWarning(i18n.t("app:errors.dropPdfNeedsVault"));
		void cleanupImportTempPaths(paths);
		return;
	}
	if (libraryStore.getState().ioBusy) {
		void cleanupImportTempPaths(paths);
		return;
	}
	setImportPdfDraft({ items, parentDir: parentDir || "papers" });
}

export function confirmImportLocalPdf(
	entries: LocalPdfImportEntry[],
	parentDir: string,
): void {
	setImportPdfDraft(null);
	void importLocalPdf({ entries, parentDir });
}

export function importPdfDialogOpenChange(open: boolean): void {
	if (open) return;
	const paths =
		libraryStore.getState().importPdfDraft?.items.map((i) => i.path) ?? [];
	setImportPdfDraft(null);
	// User cancelled confirm — drop staging copies.
	void cleanupImportTempPaths(paths);
}
