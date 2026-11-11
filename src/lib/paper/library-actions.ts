/**
 * Library actions: rescan, bibliography import/export, asset downloads, the
 * paper-reader workflow, and tag persistence. Long operations surface in the
 * background-tasks panel.
 */

import i18n from "@/i18n";
import { track } from "@/lib/activity";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { logger } from "@/lib/core/logger";
import { notifyError, notifySuccess, notifyWarning } from "@/lib/core/notify";
import { enqueueTask, enqueueTaskSettled } from "@/lib/core/tasks";
import {
	detectPaperDirectory,
	isPublicationDateInput,
	notesPathForPaper,
	type PaperMetadata,
	type PaperTag,
	paperCatalogPath,
	paperDirFromPath,
	publicationDateText,
	resolvePapersParentDir,
} from "@/lib/paper";
import {
	copyPaperFolder,
	type PaperMetaPatch,
	rescanPapers,
	resolveIdentifierMetadata,
	setPaperTags,
	syncPublication,
	updatePaperMeta,
} from "@/lib/paper/api";
import {
	libraryStore,
	refreshLibrary,
	scheduleLibraryRefresh,
	setEditMetaDraft,
	setLibraryIoBusy,
	setLibraryPapers,
	setLibraryRescanning,
} from "@/lib/paper/library-store";
import {
	maybeAutoRunPaperReader,
	paperAssetsReadyForReader,
	runPaperReaderWorkflow,
} from "@/lib/paper/reader";
import type { FileNode } from "@/lib/vault";
import { joinVaultPath, readVaultFile } from "@/lib/vault";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { getVaultPath, refreshTree, vaultStore } from "@/lib/vault/store";
import { toVaultRelative } from "@/lib/wiki";
import { rebuildWikiAndNotify } from "@/lib/wiki/store";
import { openPaper, syncUpdatedPaperTabs } from "@/lib/workspace/actions";
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
 * the candidate list. Online-only and slow enough to need the task panel:
 * runs as a `citingScan` renderer job (executor in `library-tasks.ts`).
 */
export async function discoverCitingPapers(): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath || libraryStore.getState().ioBusy) return;
	setLibraryIoBusy("citing");
	try {
		await enqueueTaskSettled({ kind: "citingScan", vaultPath, path: "" });
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
			notifySuccess(i18n.t("sidebar:papersLibrary.rescanEmpty"));
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
		await enqueueTaskSettled({
			kind: "libraryIo",
			vaultPath,
			path: "",
			params: { op: "export" },
		});
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
		await enqueueTaskSettled({
			kind: "libraryIo",
			vaultPath,
			path: "",
			params: { op: "import" },
		});
	} catch (e) {
		notifyError(errorText(e));
	} finally {
		setLibraryIoBusy(null);
	}
}

/**
 * Shared download core: one `downloadAssets` JobCenter job per paper. The Host
 * runner downloads, invalidates caps, backfills PAPER.md and enqueues the
 * layout pass; byte progress projects into the tasks panel. Returns the
 * post-download asset flags for follow-up workflows (reader).
 */
async function runPaperAssetsDownload(vaultPath: string, rel: string) {
	await enqueueTaskSettled({ kind: "downloadAssets", vaultPath, path: rel });
	await refreshTree(vaultPath);
	await refreshLibrary();
	// Best-effort: a failed lookup (vault switched / paper moved mid-download)
	// must not turn the successful download into an error toast; the reader
	// gate simply stays closed then.
	const status = await callApiResult(
		() => commands.jobPaperAssetsStatus({ vaultPath, path: rel }),
		{ fallback: "paper assets status failed" },
	).catch((error) => {
		logger.warn("paper assets status failed", {
			path: rel,
			error: errorText(error),
		});
		return null;
	});
	const assets = {
		pdf: status?.pdf ?? false,
		tex: status?.tex ?? false,
		paperMd: status?.paperMd ?? false,
	};
	track("asset.download", {
		path: rel,
		extra: { pdf: assets.pdf, tex: assets.tex, paperMd: assets.paperMd },
	});
	return assets;
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
/**
 * Duplicate library papers into one `papers/` folder ("copy to folder").
 *
 * Batch-safe: a paper whose target already exists only fails that paper, and
 * the summary toast reports the counts. The library is refreshed so the copies
 * appear as their own rows (same logical id, different path).
 */
export async function copyLibraryPapersTo(
	papers: PaperMetadata[],
	destParentRel: string,
): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath) return;
	if (isRemoteVaultHandle(vaultPath)) {
		notifyError(i18n.t("sidebar:fileTree.copyDesktopOnly"));
		return;
	}
	const rels = papers
		.map((paper) => paper.path?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
		.filter((rel): rel is string => Boolean(rel));
	if (rels.length === 0) return;
	let copied = 0;
	let failed = 0;
	for (const rel of rels) {
		try {
			await copyPaperFolder(vaultPath, rel, destParentRel);
			copied++;
		} catch {
			failed++;
		}
	}
	await refreshTree(vaultPath);
	await refreshLibrary();
	if (copied > 0) await rebuildWikiAndNotify(vaultPath);
	if (copied > 0) {
		notifySuccess(
			i18n.t("sidebar:papersLibrary.copy.copied", {
				count: copied,
				folder: destParentRel || "papers",
			}),
		);
	}
	if (failed > 0) {
		notifyWarning(
			i18n.t("sidebar:papersLibrary.copy.failed", { count: failed }),
		);
	}
}

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
 * paper-reader workflow: manual read on complete + unread papers.
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
		queue = await callApiResult(
			() => commands.jobPapersNeedingAssets({ vaultPath }),
			{ fallback: "collect papers needing assets failed" },
		);
	} catch (e) {
		notifyError(errorText(e));
		return;
	}
	if (!queue.length) return;

	for (const rel of queue) {
		if (!rel) continue;
		void callApiResult(
			() =>
				commands.jobDownloadAssetsEnqueue({
					vaultPath,
					path: rel,
					lane: "idle",
					force: false,
				}),
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
				const key = p.path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
				return key === path ? { ...p, ...updated } : p;
			}),
		);
		setTabs((prev) =>
			prev.map((tab) => {
				if (!tab.paperMeta) return tab;
				const key = tab.paperMeta.path
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
					},
				};
			}),
		);
		return { ...paperMeta, ...updated };
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
		// Host returns the full record; omitted optional fields were cleared.
		setLibraryPapers((prev) =>
			prev.map((p) => {
				const key = p.path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
				return key === path ? { ...updated, has_pdf: p.has_pdf } : p;
			}),
		);
		syncUpdatedPaperTabs(vaultPath, path, updated, paperMeta.id);
		return updated;
	} catch (e) {
		notifyError(errorText(e));
		return null;
	}
}

/**
 * Sync publication information for the given papers: re-resolve external
 * metadata when a DOI/arXiv/title is available, then let the Host refresh the
 * `#submitted:` projection and EasyScholar metrics in one pass.
 *
 * Runs as one `metadataRefresh` renderer batch job (executor in
 * `library-tasks.ts`): the paper list travels in the job params, progress is
 * reported per item, cancellation routes through the panel, and partial
 * failures surface on the job row.
 */
export async function syncLibraryPublication(
	vaultPath: string | null | undefined,
	targets: PaperMetadata[],
): Promise<void> {
	if (!vaultPath || isRemoteVaultHandle(vaultPath)) return;
	const papers = targets
		.map((p) => ({
			path: p.path ?? "",
			query: p.doi?.trim() || p.arxiv_id?.trim() || p.title?.trim() || "",
		}))
		.filter((p) => p.path && p.query);
	const syncPaths = targets
		.map((p) => p.path?.trim())
		.filter((path): path is string => Boolean(path));
	if (papers.length === 0 && syncPaths.length === 0) {
		notifyError(i18n.t("sidebar:papersLibrary.refreshMetadataNoTargets"));
		return;
	}
	try {
		await enqueueTask({
			kind: "metadataRefresh",
			vaultPath,
			path: "",
			params: { papers, syncPaths },
		});
	} catch (e) {
		notifyError(errorText(e));
	}
}

/**
 * Catalog patch from an identifier-resolved record. Empty fields are skipped
 * so `paper_update_meta` keeps the stored value.
 */
export function resolvedMetaPatch(meta: PaperMetadata): PaperMetaPatch {
	const patch: PaperMetaPatch = {};
	if (meta.title?.trim()) patch.title = meta.title.trim();
	if (meta.authors?.length) patch.authors = meta.authors;
	// Sources occasionally return prose ("Spring 2017"); the Host would reject it.
	const date = publicationDateText(meta);
	if (date && isPublicationDateInput(date)) patch.date = date;
	if (meta.doi?.trim()) patch.doi = meta.doi.trim();
	if (meta.arxiv_id?.trim()) patch.arxivId = meta.arxiv_id.trim();
	if (meta.publication?.trim()) patch.publication = meta.publication.trim();
	if (meta.volume?.trim()) patch.volume = meta.volume.trim();
	if (meta.issue?.trim()) patch.issue = meta.issue.trim();
	if (meta.pages?.trim()) patch.pages = meta.pages.trim();
	if (meta.publisher?.trim()) patch.publisher = meta.publisher.trim();
	if (meta.abstract?.trim()) patch.abstract = meta.abstract.trim();
	if (meta.pdf_url?.trim()) patch.pdfUrl = meta.pdf_url.trim();
	if (meta.html_url?.trim()) patch.htmlUrl = meta.html_url.trim();
	return patch;
}

/**
 * Re-resolve external metadata for a single paper. Used by the row context menu.
 */
export async function refreshPaperMetadata(
	vaultPath: string | null | undefined,
	paper: PaperMetadata,
): Promise<void> {
	if (!vaultPath || isRemoteVaultHandle(vaultPath)) return;
	if (!paper.path) return;
	const text =
		paper.doi?.trim() || paper.arxiv_id?.trim() || paper.title?.trim();
	if (!text) {
		notifyError(i18n.t("sidebar:papersLibrary.refreshMetadataNoTargets"));
		return;
	}
	try {
		const meta = await resolveIdentifierMetadata(text);
		const patch = resolvedMetaPatch(meta);

		if (Object.keys(patch).length > 0) {
			const updated = await updatePaperMeta(vaultPath, paper.path, patch);
			syncUpdatedPaperTabs(vaultPath, paper.path, updated, paper.id);
			scheduleLibraryRefresh();
			notifySuccess(i18n.t("sidebar:papersLibrary.refreshMetadataDone"));
		} else {
			notifyWarning(i18n.t("sidebar:papersLibrary.refreshMetadataEmpty"));
		}
		try {
			await syncPublication(vaultPath, [paper.path]);
			scheduleLibraryRefresh();
		} catch (e) {
			logger.warn("publication sync after single refresh failed", {
				path: paper.path,
				error: errorText(e),
			});
		}
	} catch (e) {
		logger.error("refresh paper metadata failed", {
			path: paper.path,
			error: String(e),
		});
		notifyError(i18n.t("sidebar:papersLibrary.refreshMetadataFailed"));
	}
}
