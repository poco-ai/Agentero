/**
 * Library actions: rescan, bibliography import/export, asset downloads, the
 * paper-reader workflow, and tag persistence. Long operations surface in the
 * background-tasks panel.
 */

import i18n from "@/i18n";
import { track } from "@/lib/activity";
import { enqueueBackgroundTask } from "@/lib/core/background-tasks";
import { errorText } from "@/lib/core/error";
import { invokeApi } from "@/lib/core/ipc";
import { logger } from "@/lib/core/logger";
import { notifyError, notifySuccess, notifyWarning } from "@/lib/core/notify";
import { mapLimit } from "@/lib/core/utils";
import {
	detectPaperDirectory,
	notesPathForPaper,
	type PaperMetadata,
	type PaperTag,
	paperCatalogPath,
	paperDirFromPath,
	resolvePapersParentDir,
} from "@/lib/paper";
import {
	exportLibraryToFile,
	importLibraryFromFile,
	type PaperMetaPatch,
	rescanPapers,
	resolveIdentifierMetadata,
	setPaperTags,
	updatePaperMeta,
} from "@/lib/paper/api";
import {
	libraryStore,
	refreshLibrary,
	scheduleLibraryRefresh,
	setCitingScanDraft,
	setEditMetaDraft,
	setLibraryIoBusy,
	setLibraryPapers,
	setLibraryRescanning,
} from "@/lib/paper/library-store";
import { downloadPaperAssets } from "@/lib/paper/lookup";
import {
	maybeAutoRunPaperReader,
	paperAssetsReadyForReader,
	runPaperReaderWorkflow,
} from "@/lib/paper/reader";
import { libraryCitingScan } from "@/lib/paper/refs";
import { enqueuePaperLayoutAnalysis } from "@/lib/pdf/layout";
import { getSettings } from "@/lib/settings/react-store";
import type { FileNode } from "@/lib/vault";
import { joinVaultPath, readVaultFile } from "@/lib/vault";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { getVaultPath, refreshTree, vaultStore } from "@/lib/vault/store";
import { toVaultRelative } from "@/lib/wiki";
import { openPaper } from "@/lib/workspace/actions";
import {
	refreshTabNotes,
	setTabs,
	workspaceStore,
} from "@/lib/workspace/store";

/** Import target directory derived from the current tree selection. */
export function currentLookupParentDir(): string {
	const { vaultPath, treeSelectedPath, tree } = vaultStore.getState();
	return resolvePapersParentDir(vaultPath, treeSelectedPath, tree);
}

/** Open the metadata edit dialog for the paper folder right-clicked in the tree. */
export function editPaperMetaFromTree(paperDir: string): void {
	const vaultPath = getVaultPath();
	if (!vaultPath || isRemoteVaultHandle(vaultPath)) return;
	const rel = toVaultRelative(vaultPath, paperDir);
	const meta = rel
		? libraryStore.getState().paperMetaByRelPath.get(rel)
		: undefined;
	if (meta) setEditMetaDraft(meta);
}

/**
 * Find new papers that cite this library but are not imported yet, and open
 * the candidate list. Online-only and slow enough to need the task panel.
 */
export async function discoverCitingPapers(): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath || libraryStore.getState().ioBusy) return;
	setLibraryIoBusy("citing");
	try {
		await enqueueBackgroundTask(
			{ kind: "lookup", title: i18n.t("app:tasks.citingScan") },
			async ({ id, setDetail }) => {
				setDetail(i18n.t("app:tasks.citingScanPhaseMeta"));
				// Host emits the per-seed counter for the fetch phase directly.
				const result = await libraryCitingScan(vaultPath, { taskId: id });
				if (result.cancelled) return null;
				setDetail(
					i18n.t("sidebar:papersLibrary.citingScanDone", {
						count: result.candidates.length,
					}),
				);
				// The result describes the vault it was scanned from; a switch
				// mid-scan means the dialog would be about the wrong library.
				if (getVaultPath() === vaultPath) setCitingScanDraft(result);
				return result;
			},
		);
	} catch (e) {
		notifyError(errorText(e));
	} finally {
		setLibraryIoBusy(null);
	}
}

/** Rebuild the catalog from papers/ on disk (recover disk-only papers). */
export async function rescanLibraryPapers(): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath || libraryStore.getState().rescanning) return;
	setLibraryRescanning(true);
	try {
		const n = await rescanPapers(vaultPath);
		await refreshLibrary();
		await refreshTree(vaultPath);
		if (n > 0) {
			notifySuccess(i18n.t("sidebar:papersLibrary.rescanned", { count: n }));
		} else {
			notifyWarning(i18n.t("sidebar:papersLibrary.rescanEmpty"));
		}
	} catch (e) {
		notifyError(
			e instanceof Error
				? e.message
				: i18n.t("sidebar:papersLibrary.rescanFailed"),
		);
	} finally {
		setLibraryRescanning(false);
	}
}

export async function libraryExport(): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath || libraryStore.getState().ioBusy) return;
	setLibraryIoBusy("export");
	try {
		await enqueueBackgroundTask(
			{ kind: "export", title: i18n.t("app:tasks.libraryExport") },
			async () => {
				const result = await exportLibraryToFile({
					vaultPath,
					settings: getSettings(),
					format: "bibtex",
				});
				// User cancelled dialog — treat as soft cancel, not failure.
				return result ?? null;
			},
		);
	} catch (e) {
		notifyError(errorText(e));
	} finally {
		setLibraryIoBusy(null);
	}
}

export async function libraryImport(): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath || libraryStore.getState().ioBusy) return;
	setLibraryIoBusy("import");
	try {
		const result = await enqueueBackgroundTask(
			{ kind: "import", title: i18n.t("app:tasks.libraryImport") },
			async ({ setDetail }) => {
				const r = await importLibraryFromFile({
					vaultPath,
					parentDir: currentLookupParentDir(),
					settings: getSettings(),
				});
				if (!r) return null;
				setDetail(
					i18n.t("sidebar:papersLibrary.importDone", { count: r.imported }),
				);
				await refreshTree(vaultPath);
				await refreshLibrary();
				return r;
			},
		);
		if (result?.errors.length) {
			notifyWarning(
				`${i18n.t("sidebar:papersLibrary.importDone", { count: result.imported })}; ${result.errors.slice(0, 2).join("; ")}`,
			);
		}
	} catch (e) {
		notifyError(errorText(e));
	} finally {
		setLibraryIoBusy(null);
	}
}

/**
 * Shared download core: background task + tree/library refresh + layout
 * analysis. Returns the download result for follow-up workflows (reader).
 */
async function runPaperAssetsDownload(vaultPath: string, rel: string) {
	return enqueueBackgroundTask(
		{
			kind: "download",
			title: i18n.t("app:tasks.downloadPaper"),
			detail: rel,
		},
		async ({ id, setDetail }) => {
			setDetail(rel);
			const r = await downloadPaperAssets({
				vaultRoot: vaultPath,
				paperPath: rel,
				progressTaskId: id,
			});
			setDetail(i18n.t("app:tasks.downloadRefreshing", { path: rel }));
			await refreshTree(vaultPath);
			await refreshLibrary();
			enqueuePaperLayoutAnalysis({
				paperAbsPath: joinVaultPath(vaultPath, rel),
			});
			track("asset.download", {
				path: rel,
				extra: { pdf: r.pdf, tex: r.tex, paperMd: r.paperMd },
			});
			return r;
		},
	);
}

/**
 * On-demand assets: missing local PDF, and/or arXiv TeX when fetchable but
 * absent. Auto-runs the paper reader afterwards when everything is ready.
 */
export async function downloadPaperAssetsAction(node: FileNode): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath) return;
	const rel = toVaultRelative(vaultPath, node.path)
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	try {
		const assets = await runPaperAssetsDownload(vaultPath, rel);
		// After PDF/TeX/PAPER.md ready → auto paper-reader with task progress.
		if (
			paperAssetsReadyForReader({
				pdf: assets.pdf,
				tex: assets.tex,
				paperMd: assets.paperMd,
			})
		) {
			// Fire-and-forget: reader progress shows in the task bar. Do NOT
			// await — awaiting keeps every paper row busy during reading.
			void maybeAutoRunPaperReader({
				vaultRoot: vaultPath,
				paperPath: rel,
				assetsReady: true,
			})
				.then(async (started) => {
					if (!started) return;
					await refreshLibrary();
					const notesAbs = notesPathForPaper(node.path);
					try {
						const content = await readVaultFile(notesAbs);
						refreshTabNotes(node.path, content);
					} catch {
						// ignore
					}
				})
				.catch((e) => {
					notifyError(errorText(e));
				});
		}
	} catch (e) {
		notifyError(errorText(e));
	}
}

/**
 * Library-table row action: re-download assets (PDF / TeX) from the paper's
 * upstream source — the row for papers synced without bulky attachments.
 */
export async function downloadLibraryPaper(
	paper: PaperMetadata,
): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath || !paper.path) return;
	const rel = paper.path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	try {
		await runPaperAssetsDownload(vaultPath, rel);
	} catch (e) {
		notifyError(errorText(e));
	}
}

/**
 * paper-reader workflow: Zap on complete + unread papers.
 * Progress surfaces in the bottom-left background tasks panel.
 */
export async function readPaper(node: FileNode): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath) return;
	const rel = toVaultRelative(vaultPath, node.path)
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	// Fire-and-forget: reader progress shows in the bottom-left task bar.
	void runPaperReaderWorkflow({ vaultRoot: vaultPath, paperPath: rel })
		.then(async () => {
			await refreshLibrary();
			// Refresh NOTES pane if this paper is open in a tab.
			const notesAbs = notesPathForPaper(node.path);
			try {
				const content = await readVaultFile(notesAbs);
				refreshTabNotes(node.path, content);
			} catch {
				// ignore
			}
		})
		.catch((e) => {
			notifyError(errorText(e));
		});
}

/**
 * Library bulk download: every paper folder missing PDF and/or fetchable TeX.
 * Enqueues one `DownloadAssets` JobCenter job per paper (idle lane); the
 * scheduler throttles (cap 3), each job projects into the tasks panel and
 * backfills PAPER.md + layout, and the library refreshes via the job-completion
 * hook (§10.2).
 */
export async function downloadAllMissingAssets(): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath) return;
	// CapsCache-backed query (§8.4) replaces the frontend tree walk.
	let queue: string[] = [];
	try {
		queue = await invokeApi<string[]>(
			"job_papers_needing_assets",
			{ args: { vaultPath } },
			{ fallback: "collect papers needing assets failed" },
		);
	} catch (e) {
		notifyError(errorText(e));
		return;
	}
	if (!queue.length) return;

	for (const rel of queue) {
		if (!rel) continue;
		void invokeApi(
			"job_download_assets_enqueue",
			{ args: { vaultPath, path: rel, lane: "idle", force: false } },
			{ fallback: "download enqueue failed" },
		).catch((e) =>
			logger.warn("bulk download enqueue failed", {
				rel,
				error: errorText(e),
			}),
		);
	}
}

export function openLibraryPaper(paper: PaperMetadata): void {
	const vaultPath = getVaultPath();
	if (!vaultPath || !paper.path) return;
	openPaper(joinVaultPath(vaultPath, paper.path));
}

/**
 * Vault-relative catalog path for a paper, or `""` when it cannot be resolved.
 * Prefers `meta.path`; projections may omit it, so fall back to the folder of
 * the tab that has this paper open.
 */
export async function resolvePaperCatalogRel(
	paperMeta: PaperMetadata,
): Promise<string> {
	const vaultPath = getVaultPath();
	if (!vaultPath) return "";
	const path = (paperMeta.path ?? "")
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (path) return path;
	const matchingTab = workspaceStore
		.getState()
		.tabs.find((tab) => tab.paperMeta?.id === paperMeta.id);
	const selectedPath = matchingTab?.path ?? null;
	if (!selectedPath) return "";
	let paperDir = paperDirFromPath(
		selectedPath,
		vaultStore.getState().paperFolders,
	);
	if (!paperDir && (await detectPaperDirectory(selectedPath))) {
		paperDir = selectedPath.replace(/[\\/]+$/, "");
	}
	return paperCatalogPath(paperDir ?? "", vaultPath) ?? "";
}

/** Persist Paper Info tags for the displayed paper and sync library + open tabs. */
export async function paperTagsChange(
	paperMeta: PaperMetadata,
	tags: PaperTag[],
): Promise<PaperMetadata | null> {
	const vaultPath = getVaultPath();
	if (!vaultPath) return null;
	const path = await resolvePaperCatalogRel(paperMeta);
	if (!path) {
		notifyError(i18n.t("sidebar:paperInfo.tagsSaveFailed"));
		return null;
	}
	try {
		const updated = await setPaperTags(vaultPath, path, tags);
		track("paper.tag", {
			path,
			extra: { op: "set", tagCount: tags.length },
		});
		setLibraryPapers((prev) =>
			prev.map((p) => {
				const key = (p.path ?? "")
					.replace(/\\/g, "/")
					.replace(/^\/+|\/+$/g, "");
				return key === path ? { ...p, ...updated } : p;
			}),
		);
		setTabs((prev) =>
			prev.map((tab) => {
				if (!tab.paperMeta) return tab;
				const key = (tab.paperMeta.path ?? "")
					.replace(/\\/g, "/")
					.replace(/^\/+|\/+$/g, "");
				const samePath = key === path;
				const sameOpenPaper = !key && tab.paperMeta.id === paperMeta.id;
				if (!samePath && !sameOpenPaper) return tab;
				return {
					...tab,
					paperMeta: {
						...tab.paperMeta,
						...updated,
						path: updated.path ?? path,
					},
				};
			}),
		);
		return { ...paperMeta, ...updated, path: updated.path ?? path };
	} catch (e) {
		notifyError(errorText(e));
		return null;
	}
}

/** Apply a manual metadata patch and sync library + open tabs. */
export async function paperMetaChange(
	paperMeta: PaperMetadata,
	patch: PaperMetaPatch,
): Promise<PaperMetadata | null> {
	const vaultPath = getVaultPath();
	if (!vaultPath) return null;
	const path = await resolvePaperCatalogRel(paperMeta);
	if (!path) {
		notifyError(i18n.t("sidebar:paperInfo.editMeta.saveFailed"));
		return null;
	}
	try {
		const updated = await updatePaperMeta(vaultPath, path, patch);
		track("paper.edit-meta", {
			path,
			extra: { fields: Object.keys(patch) },
		});
		setLibraryPapers((prev) =>
			prev.map((p) => {
				const key = (p.path ?? "")
					.replace(/\\/g, "/")
					.replace(/^\/+|\/+$/g, "");
				return key === path ? { ...p, ...updated } : p;
			}),
		);
		setTabs((prev) =>
			prev.map((tab) => {
				if (!tab.paperMeta) return tab;
				const key = (tab.paperMeta.path ?? "")
					.replace(/\\/g, "/")
					.replace(/^\/+|\/+$/g, "");
				const samePath = key === path;
				const sameOpenPaper = !key && tab.paperMeta.id === paperMeta.id;
				if (!samePath && !sameOpenPaper) return tab;
				return {
					...tab,
					paperMeta: {
						...tab.paperMeta,
						...updated,
						path: updated.path ?? path,
					},
				};
			}),
		);
		return { ...paperMeta, ...updated, path: updated.path ?? path };
	} catch (e) {
		notifyError(errorText(e));
		return null;
	}
}

/**
 * Re-resolve the `publication` field for the given papers via identifier
 * lookup (library header refresh button). Online-only and slow enough to
 * surface in the background-tasks panel with progress + partial-failure
 * reporting; concurrency 3 to stay polite with metadata providers.
 */
export async function refreshLibraryPublications(
	vaultPath: string | null | undefined,
	targets: PaperMetadata[],
): Promise<void> {
	if (!vaultPath || isRemoteVaultHandle(vaultPath)) return;
	const papers = targets.filter(
		(p) => p.path && (p.doi?.trim() || p.arxiv_id?.trim() || p.title?.trim()),
	);
	if (papers.length === 0) {
		notifyError(i18n.t("sidebar:papersLibrary.refreshPublicationNoTargets"));
		return;
	}
	await enqueueBackgroundTask(
		{
			kind: "other",
			title: i18n.t("sidebar:papersLibrary.refreshPublicationTaskTitle"),
			detail: i18n.t("sidebar:papersLibrary.refreshPublicationTaskDetail", {
				current: 0,
				total: papers.length,
			}),
		},
		async ({ signal, setProgress, setDetail }) => {
			const stats = { updated: 0, empty: 0, failed: 0, processed: 0 };
			setProgress(0);
			const updateStats = () => {
				setProgress(Math.round((stats.processed / papers.length) * 100));
				setDetail(
					i18n.t("sidebar:papersLibrary.refreshPublicationTaskDetail", {
						current: stats.processed,
						total: papers.length,
						updated: stats.updated,
						failed: stats.failed,
						empty: stats.empty,
					}),
				);
			};
			await mapLimit(papers, 3, async (paper) => {
				if (signal.aborted) return;
				const text =
					paper.doi?.trim() || paper.arxiv_id?.trim() || paper.title?.trim();
				try {
					const meta = await resolveIdentifierMetadata(text ?? "");
					const publication = meta.publication?.trim();
					if (publication && paper.path) {
						await updatePaperMeta(vaultPath, paper.path, {
							publication,
						});
						stats.updated++;
						scheduleLibraryRefresh();
					} else {
						stats.empty++;
					}
				} catch (e) {
					stats.failed++;
					logger.error("refresh publication failed", {
						path: paper.path,
						error: String(e),
					});
				} finally {
					stats.processed++;
					updateStats();
				}
			});
			await refreshLibrary();
			if (stats.failed > 0) {
				throw new Error(
					i18n.t("sidebar:papersLibrary.refreshPublicationPartial", {
						updated: stats.updated,
						failed: stats.failed,
						empty: stats.empty,
					}),
				);
			}
		},
	);
}
