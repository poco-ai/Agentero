import i18n from "@/i18n";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { scheduleIdle } from "@/lib/core/idle";
import { callApiResult } from "@/lib/core/ipc";
import { toVaultRelative } from "@/lib/core/path";
import { enqueueTaskSettled } from "@/lib/core/tasks";
import { isTauri } from "@/lib/core/tauri";
import {
	canAttemptPdfDownload,
	detectPaperDirectory,
	findLocalPdfPath,
	getRemoteArxivPaperByPath,
	isPaperDirectory,
	isRemoteArxivPath,
	isUnderPapers,
	loadPaperMetadata,
	loadPaperOpenBundle,
	localFileToArrayBuffer,
	localImageToViewerSource,
	notesPathForPaper,
	type PaperMetadata,
	paperDirFromPath,
	paperRemoteAssetsFromMetadata,
	REMOTE_ARXIV_PREFIX,
	revokePdfViewerSource,
} from "@/lib/paper";
import { isLibraryVirtualPath, isTrashVirtualPath } from "@/lib/paper/api";
import {
	isPlazaVirtualPath,
	plazaSourceForPath,
	plazaTitleForPath,
} from "@/lib/plaza";
import {
	ensureLocalFsScope,
	type FileNode,
	isTextOpenable,
	readVaultFile,
} from "@/lib/vault";
import { basenameOf, normalizePathKey, treeFindNode } from "@/lib/vault/path";
import { readSeedCached } from "@/lib/vault/seed-cache";
import { tabTitleForPath } from "@/lib/workspace/tabs/model";
import {
	type DocTab,
	NOTES_PLACEHOLDER,
	type TabResources,
} from "@/lib/workspace/tabs/types";
import {
	imageMimeFromPath,
	isViewerPath,
	paperBodyMode,
	preferredModeForPath,
	viewerModeSpec,
} from "@/lib/workspace/viewer";

function findChildren(nodes: FileNode[], path: string): FileNode[] | undefined {
	return treeFindNode(nodes, path)?.children;
}

const pdfAutoDownloadTried = new Set<string>();

/**
 * Open-paper reconcile (§7.4 入口②): ask the Host to backfill `PAPER.md`
 * (ParseBody) when this paper has a PDF but no TeX and no `PAPER.md`. The
 * CapsCache check is authoritative and the job is deduped by the JobCenter,
 * replacing the old client-side precheck + session-set.
 */
function reconcilePaperOnOpen(
	paperDir: string,
	vaultPath: string | null,
): void {
	if (!isTauri() || !vaultPath) return;
	const rel = toVaultRelative(vaultPath, paperDir)
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (!rel) return;
	// Host ParseBody/ParseRefs jobs; keep them off the PDF-open critical path.
	scheduleIdle(() => {
		void callApiResult(
			() => commands.jobReconcilePaper({ vaultPath, path: rel }),
			{ fallback: "paper reconcile failed" },
		).catch(() => undefined);
	});
}

/**
 * PDF for a paper tab: local file (blob:) → auto-download if missing → remote pdf_url.
 * Avoids Tauri asset:// which PDF.js cannot XHR ("Unexpected server response (0)").
 */
async function resolvePaperPdfSource(
	paperDir: string,
	vaultPath: string | null,
	meta: PaperMetadata | null,
	remotePdf: string | null,
): Promise<{
	pdfUrl: string | null;
	pdfBytes: ArrayBuffer | null;
	didDownload: boolean;
}> {
	const localPath = await findLocalPdfPath(paperDir);
	if (localPath) {
		const bytes = await localFileToArrayBuffer(localPath);
		if (bytes) return { pdfUrl: null, pdfBytes: bytes, didDownload: false };
		return { pdfUrl: remotePdf, pdfBytes: null, didDownload: false };
	}

	if (!isTauri() || !vaultPath || !canAttemptPdfDownload(meta, remotePdf)) {
		return { pdfUrl: remotePdf, pdfBytes: null, didDownload: false };
	}

	const rel = toVaultRelative(vaultPath, paperDir)
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (!rel || pdfAutoDownloadTried.has(rel)) {
		return { pdfUrl: remotePdf, pdfBytes: null, didDownload: false };
	}
	pdfAutoDownloadTried.add(rel);

	let didDownload = false;
	try {
		// JobCenter `downloadAssets`: the Host runner downloads PDF/TeX and chains
		// the PAPER.md + layout follow-ups; progress/cancel ride the job contract.
		await enqueueTaskSettled({ kind: "downloadAssets", vaultPath, path: rel });
		didDownload = true;
	} catch {
		// fall through to remote
	}

	const after = await findLocalPdfPath(paperDir);
	if (after) {
		const bytes = await localFileToArrayBuffer(after);
		if (bytes) return { pdfUrl: null, pdfBytes: bytes, didDownload };
	}
	return { pdfUrl: remotePdf, pdfBytes: null, didDownload };
}

/** Revoke blob: media sources held by a document panel (PDF + image). */
export function revokeTabMediaSources(
	tab: Pick<DocTab, "pdfUrl" | "imageUrl"> | null,
): void {
	if (!tab) return;
	if (tab.pdfUrl) revokePdfViewerSource(tab.pdfUrl);
	if (tab.imageUrl) revokePdfViewerSource(tab.imageUrl);
}

/**
 * Resolve everything a tab needs to render (paper metadata, local/remote PDF,
 * HTML URL, image blob, NOTES seed, initial view mode, plain-file text).
 */
export async function loadTabResources(
	path: string,
	vaultPath: string | null,
	tree: FileNode[],
	paperFolders: string[],
): Promise<TabResources> {
	if (isTrashVirtualPath(path)) {
		return {
			kind: "trash",
			title: "Recycle Bin",
			mode: "markdown",
			paperMeta: null,
			pdfUrl: null,
			htmlUrl: null,
			imageUrl: null,
			notesPath: null,
			notesSeed: "",
			markdownSeed: "",
			loaded: true,
		};
	}
	if (isLibraryVirtualPath(path)) {
		return {
			kind: "library",
			title: "Library",
			mode: "markdown",
			paperMeta: null,
			pdfUrl: null,
			htmlUrl: null,
			imageUrl: null,
			notesPath: null,
			notesSeed: "",
			markdownSeed: "",
			loaded: true,
		};
	}
	// Plaza is virtual and remote-only: never probe the filesystem for it.
	if (isPlazaVirtualPath(path)) {
		return {
			kind: "plaza",
			title: plazaTitleForPath(path),
			mode: "markdown",
			paperMeta: null,
			pdfUrl: null,
			htmlUrl: plazaSourceForPath(path)?.url ?? null,
			imageUrl: null,
			notesPath: null,
			notesSeed: "",
			markdownSeed: "",
			loaded: true,
		};
	}

	// Remote arXiv preview: read from in-memory metadata, never touch disk.
	if (isRemoteArxivPath(path)) {
		const meta = getRemoteArxivPaperByPath(path);
		if (!meta) {
			return {
				kind: "paper",
				title: i18n.t("app:labels.remoteArxiv"),
				mode: "markdown",
				paperMeta: null,
				pdfUrl: null,
				htmlUrl: null,
				imageUrl: null,
				notesPath: null,
				notesSeed: "",
				markdownSeed: "",
				loaded: true,
				error: i18n.t("app:errors.remotePaperUnavailable"),
			};
		}
		const { pdfUrl, htmlUrl } = paperRemoteAssetsFromMetadata(meta);
		const mode = paperBodyMode(Boolean(pdfUrl), htmlUrl);
		return {
			kind: "paper",
			title: meta.title || path.slice(REMOTE_ARXIV_PREFIX.length),
			mode,
			paperMeta: meta,
			pdfUrl,
			pdfBytes: null,
			htmlUrl,
			imageUrl: null,
			notesPath: null,
			notesSeed: "",
			markdownSeed: "",
			loaded: true,
		};
	}

	// Restored tabs load concurrently with the tree on startup; ensure the
	// vault dir is in the fs-plugin scope before any read (see ensureLocalFsScope).
	await ensureLocalFsScope(vaultPath);

	let paperDir = paperDirFromPath(path, paperFolders);
	if (!paperDir && (await detectPaperDirectory(path))) {
		paperDir = path.replace(/[\\/]+$/, "");
	}

	const treeNode = treeFindNode(tree, path);
	// Tree markers can identify a paper folder before paperFolders refreshes.
	if (
		!paperDir &&
		treeNode?.kind === "directory" &&
		isPaperDirectory(path, treeNode.children)
	) {
		paperDir = path.replace(/[\\/]+$/, "");
	}

	// Non-paper directory (org folder under papers/, notes/, etc.) → scoped library.
	// Tree may be empty during tab restore before refreshTree completes: fall back to
	// "not an openable file" so folder paths still reopen as library scope tabs.
	// Outside `papers/` any extension-bearing path is a plain-text fallback file;
	// extension-less names stay directory-suspect for that restore race.
	const looksLikeOpenableFile =
		isViewerPath(path) ||
		isTextOpenable(path) ||
		(!isUnderPapers(path) && /\.[^\\/]+$/.test(path));
	if (
		!paperDir &&
		(treeNode?.kind === "directory" ||
			(treeNode == null && !looksLikeOpenableFile))
	) {
		return {
			kind: "library",
			title: treeNode?.name || basenameOf(path),
			mode: "markdown",
			paperMeta: null,
			pdfUrl: null,
			htmlUrl: null,
			imageUrl: null,
			notesPath: null,
			notesSeed: "",
			markdownSeed: "",
			loaded: true,
		};
	}

	if (paperDir) {
		const notesPath = notesPathForPaper(paperDir);
		// Fallback seed read races with the probes below; resolved last so a
		// bundle that only arrives on the retry wins over an early failed read.
		const notesFallback = readSeedCached(notesPath).catch(
			() => NOTES_PLACEHOLDER,
		);
		const probeOpenState = async () => {
			const bundle = await loadPaperOpenBundle(paperDir, vaultPath);
			const meta =
				bundle?.paper ?? (await loadPaperMetadata(paperDir, vaultPath));
			const { pdfUrl: remotePdf, htmlUrl } =
				paperRemoteAssetsFromMetadata(meta);
			let paperPdf: string | null = null;
			let paperBytes: ArrayBuffer | null = null;
			let didDownload = false;
			if (bundle?.pdfPath) {
				paperBytes = await localFileToArrayBuffer(bundle.pdfPath);
			}
			if (!paperBytes) {
				const resolved = await resolvePaperPdfSource(
					paperDir,
					vaultPath,
					meta,
					remotePdf,
				);
				paperPdf = resolved.pdfUrl;
				paperBytes = resolved.pdfBytes;
				didDownload = resolved.didDownload;
			}
			return { bundle, meta, htmlUrl, paperPdf, paperBytes, didDownload };
		};

		let open = await probeOpenState();
		// Startup race: the paper exists on disk, yet neither the catalog bundle
		// nor metadata resolved — the Host was likely still opening the vault
		// (fs scope / catalog not ready yet). Hydration runs exactly once, so a
		// miss here would stick; one delayed re-probe heals the tab instead.
		if (
			!open.paperPdf &&
			!open.paperBytes &&
			!open.htmlUrl &&
			(!open.bundle || !open.meta) &&
			isTauri() &&
			vaultPath
		) {
			await new Promise((resolve) => setTimeout(resolve, 1200));
			open = await probeOpenState();
		}

		const { bundle, meta, htmlUrl, paperPdf, paperBytes, didDownload } = open;
		// Open-paper reconcile (§7.4 入口②): backfill PAPER.md (ParseBody) and
		// references (ParseRefs) as needed. Idempotent — the JobCenter dedupes
		// jobs, so this is safe even right after a download.
		reconcilePaperOnOpen(paperDir, vaultPath);
		const notesSeed = bundle?.notesSeed ?? (await notesFallback);

		const openingPaperRoot =
			normalizePathKey(path) === normalizePathKey(paperDir) ||
			isPaperDirectory(path, findChildren(tree, path));

		if (openingPaperRoot) {
			const mode = paperBodyMode(Boolean(paperPdf || paperBytes), htmlUrl);
			return {
				kind: "paper",
				title: meta?.title || basenameOf(paperDir),
				mode,
				paperMeta: meta,
				pdfUrl: paperPdf,
				pdfBytes: paperBytes,
				htmlUrl,
				imageUrl: null,
				notesPath,
				notesSeed,
				markdownSeed: "",
				loaded: true,
				didDownloadAssets: didDownload,
			};
		}

		// A directory inside a paper folder (figures/, data/…) is not an
		// openable file — scoped library, never an empty Markdown editor.
		if (
			treeNode?.kind === "directory" ||
			(treeNode == null && !looksLikeOpenableFile)
		) {
			return {
				kind: "library",
				title: treeNode?.name || basenameOf(path),
				mode: "markdown",
				paperMeta: null,
				pdfUrl: null,
				htmlUrl: null,
				imageUrl: null,
				notesPath: null,
				notesSeed: "",
				markdownSeed: "",
				loaded: true,
			};
		}

		// A file inside a paper folder (e.g. NOTES.md, a nested PDF, or figure).
		// The resource strategy comes from the mode registry (viewer/index.ts).
		const mode = preferredModeForPath(path);
		let pdfUrl = paperPdf;
		let pdfBytes = paperBytes;
		let imageUrl: string | null = null;
		let markdownSeed = "";
		let excalidrawSeed = "";

		switch (viewerModeSpec(mode).resource) {
			case "pdf": {
				// Prefer the exact file the user clicked (may differ from canonical {id}.pdf).
				const exact = await localFileToArrayBuffer(path);
				if (exact) {
					pdfBytes = exact;
					pdfUrl = null;
				}
				break;
			}
			case "image": {
				imageUrl = await localImageToViewerSource(
					path,
					imageMimeFromPath(path),
				);
				if (!imageUrl) {
					return {
						kind: "file",
						title: basenameOf(path),
						mode: "image",
						paperMeta: meta,
						pdfUrl: paperPdf,
						pdfBytes: paperBytes,
						htmlUrl,
						imageUrl: null,
						notesPath,
						notesSeed,
						markdownSeed: "",
						loaded: true,
						didDownloadAssets: didDownload,
						error: "cannotPreview",
					};
				}
				break;
			}
			case "excalidraw": {
				try {
					excalidrawSeed = await readVaultFile(path);
				} catch {
					// Leave the canvas empty when the file cannot be read.
				}
				// markdownSeed is consumed only by markdown mode; the old loader
				// read it here too.
				break;
			}
			case "markdown": {
				if (isTextOpenable(path)) {
					try {
						markdownSeed = await readVaultFile(path);
					} catch {
						// Leave the editor empty when the file cannot be read.
					}
				}
				break;
			}
			case "html": {
				// Local `.html` is served by the `agentero-html` scheme from
				// `tab.path`. The paper's remote `htmlUrl` stays on the paper
				// body tab and is not reused as this file's preview.
				break;
			}
			case "text": {
				// Unreachable inside papers/: the path fallback for this domain is
				// markdown, never the CodeMirror text editor.
				break;
			}
		}

		return {
			kind: "file",
			title: tabTitleForPath(path),
			mode,
			paperMeta: meta,
			pdfUrl,
			pdfBytes,
			htmlUrl,
			imageUrl,
			notesPath,
			notesSeed,
			markdownSeed,
			excalidrawSeed,
			loaded: true,
			didDownloadAssets: didDownload,
		};
	}

	// Plain file, not under a paper folder (vault root, notes/, etc.).
	// The resource strategy comes from the mode registry (viewer/index.ts).
	const mode = preferredModeForPath(path);
	const base = {
		kind: "file" as const,
		title: tabTitleForPath(path),
		mode,
		paperMeta: null,
		pdfUrl: null as string | null,
		pdfBytes: null as ArrayBuffer | null,
		htmlUrl: null as string | null,
		imageUrl: null as string | null,
		notesPath: null,
		notesSeed: "",
		markdownSeed: "",
		loaded: true as const,
	};

	switch (viewerModeSpec(mode).resource) {
		case "pdf": {
			const pdfBytes = await localFileToArrayBuffer(path);
			if (!pdfBytes) {
				return { ...base, error: "cannotPreview" };
			}
			return { ...base, pdfBytes };
		}
		case "image": {
			const imageUrl = await localImageToViewerSource(
				path,
				imageMimeFromPath(path),
			);
			if (!imageUrl) {
				return { ...base, error: "cannotPreview" };
			}
			return { ...base, imageUrl };
		}
		case "excalidraw": {
			try {
				const excalidrawSeed = await readVaultFile(path);
				return { ...base, excalidrawSeed };
			} catch (e) {
				return { ...base, error: errorText(e) };
			}
		}
		case "text": {
			// CodeMirror plain-text fallback (Papers 外未知/文本扩展名). Unlike the
			// Markdown editor this accepts any extension — the text editor is the
			// catch-all viewer, so no isTextOpenable gate here.
			try {
				const textSeed = await readVaultFile(path);
				return { ...base, textSeed };
			} catch (e) {
				return { ...base, error: errorText(e) };
			}
		}
		case "html": {
			// Local `.html` is previewed from `path` via `agentero-html`.
			return base;
		}
		case "markdown": {
			if (!isTextOpenable(path)) {
				return { ...base, error: "cannotPreview" };
			}
			try {
				const markdownSeed = await readSeedCached(path);
				return { ...base, markdownSeed };
			} catch (e) {
				return {
					...base,
					error: errorText(e),
				};
			}
		}
	}
}

/** Whether the tab's active view exposes the side NOTES column. */
