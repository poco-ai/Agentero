import i18n from "@/i18n";
import { downloadPaperAssets } from "@/lib/lookup";
import {
	canAttemptPdfDownload,
	detectPaperDirectory,
	findLocalPdfPath,
	isPaperDirectory,
	loadPaperMetadata,
	localImageToViewerSource,
	localPdfToViewerSource,
	notesPathForPaper,
	type PaperMetadata,
	paperDirFromPath,
	paperHasLocalPaperMd,
	paperHasLocalPdf,
	paperHasLocalTex,
	paperRemoteAssetsFromMetadata,
	revokePdfViewerSource,
} from "@/lib/paper-metadata";
import { isLibraryVirtualPath, isTrashVirtualPath } from "@/lib/papers-api";
import {
	basenameOf,
	type DocTab,
	type DocTabKind,
	normalizeTabPath,
} from "@/lib/tabs/model";
import { isTauri } from "@/lib/tauri";
import { type FileNode, isTextOpenable, readVaultFile } from "@/lib/vault";
import {
	type CenterViewMode,
	imageMimeFromPath,
	isHtmlPath,
	isImagePath,
	isPdfPath,
	preferredModeForPath,
} from "@/lib/viewer";
import { toVaultRelative } from "@/lib/wiki";
import { runBackgroundTask } from "@/stores/background-tasks-store";

const NOTES_PLACEHOLDER = "# Notes\n\nNo NOTES.md found for this paper.\n";

function findNode(nodes: FileNode[], path: string): FileNode | undefined {
	const key = normalizeTabPath(path);
	const walk = (list: FileNode[]): FileNode | undefined => {
		for (const n of list) {
			if (normalizeTabPath(n.path) === key) return n;
			if (n.children?.length) {
				const hit = walk(n.children);
				if (hit) return hit;
			}
		}
		return undefined;
	};
	return walk(nodes);
}

function findChildren(nodes: FileNode[], path: string): FileNode[] | undefined {
	return findNode(nodes, path)?.children;
}

/** Fields loadTabResources fills in on top of a placeholder tab. */
export type TabResources = {
	kind: DocTabKind;
	title: string;
	mode: CenterViewMode;
	paperMeta: PaperMetadata | null;
	pdfUrl: string | null;
	htmlUrl: string | null;
	imageUrl: string | null;
	notesPath: string | null;
	notesSeed: string;
	markdownSeed: string;
	loaded: true;
	/** Non-fatal message to surface (e.g. unpreviewable file). */
	error?: string;
	/** True when this load triggered `paper_download_assets` (tree may need refresh). */
	didDownloadAssets?: boolean;
};

/** Session-scoped: vault-rel paper paths already auto-downloaded for preview. */
const pdfAutoDownloadTried = new Set<string>();

/** Session-scoped: vault-rel paper paths already triggered for deferred body resolve. */
const paperParseTried = new Set<string>();

function maybeTriggerDeferredParse(
	paperDir: string,
	vaultPath: string | null,
	treeNode: FileNode | undefined,
): void {
	if (!isTauri() || !vaultPath || !treeNode) return;
	if (
		!paperHasLocalPdf(treeNode) ||
		paperHasLocalTex(treeNode) ||
		paperHasLocalPaperMd(treeNode)
	) {
		return;
	}
	const rel = toVaultRelative(vaultPath, paperDir)
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (!rel || paperParseTried.has(rel)) return;
	paperParseTried.add(rel);

	void runBackgroundTask(
		{
			kind: "download",
			title: i18n.t("app:tasks.downloadPaper"),
			detail: rel,
		},
		async ({ id }) => {
			await downloadPaperAssets({
				vaultRoot: vaultPath,
				paperPath: rel,
				progressTaskId: id,
			});
		},
	).catch(() => {});
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
): Promise<{ pdfUrl: string | null; didDownload: boolean }> {
	const localPath = await findLocalPdfPath(paperDir);
	if (localPath) {
		const blob = await localPdfToViewerSource(localPath);
		return { pdfUrl: blob ?? remotePdf, didDownload: false };
	}

	if (!isTauri() || !vaultPath || !canAttemptPdfDownload(meta, remotePdf)) {
		return { pdfUrl: remotePdf, didDownload: false };
	}

	const rel = toVaultRelative(vaultPath, paperDir)
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (!rel || pdfAutoDownloadTried.has(rel)) {
		return { pdfUrl: remotePdf, didDownload: false };
	}
	pdfAutoDownloadTried.add(rel);

	let didDownload = false;
	try {
		await runBackgroundTask(
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
				return r;
			},
		);
		didDownload = true;
	} catch {
		// fall through to remote
	}

	const after = await findLocalPdfPath(paperDir);
	if (after) {
		const blob = await localPdfToViewerSource(after);
		return { pdfUrl: blob ?? remotePdf, didDownload };
	}
	return { pdfUrl: remotePdf, didDownload };
}

/** Revoke blob: media sources held by closed tabs (PDF + image). */
export function revokeTabPdfSource(
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

	let paperDir = paperDirFromPath(path, paperFolders);
	if (!paperDir && (await detectPaperDirectory(path))) {
		paperDir = path.replace(/[\\/]+$/, "");
	}

	const treeNode = findNode(tree, path);
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
	const looksLikeOpenableFile =
		isPdfPath(path) ||
		isImagePath(path) ||
		isHtmlPath(path) ||
		isTextOpenable(path);
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
		const meta = await loadPaperMetadata(paperDir, vaultPath);
		const { pdfUrl: remotePdf, htmlUrl } = paperRemoteAssetsFromMetadata(meta);
		const { pdfUrl: paperPdf, didDownload } = await resolvePaperPdfSource(
			paperDir,
			vaultPath,
			meta,
			remotePdf,
		);
		if (!didDownload) {
			maybeTriggerDeferredParse(paperDir, vaultPath, findNode(tree, paperDir));
		}
		const notesPath = notesPathForPaper(paperDir);
		let notesSeed = NOTES_PLACEHOLDER;
		try {
			notesSeed = await readVaultFile(notesPath);
		} catch {
			// keep placeholder
		}

		const openingPaperRoot =
			normalizeTabPath(path) === normalizeTabPath(paperDir) ||
			isPaperDirectory(path, findChildren(tree, path));

		if (openingPaperRoot) {
			const mode: CenterViewMode = paperPdf
				? "pdf"
				: htmlUrl
					? "html"
					: "markdown";
			return {
				kind: "paper",
				title: meta?.title || basenameOf(paperDir),
				mode,
				paperMeta: meta,
				pdfUrl: paperPdf,
				htmlUrl,
				imageUrl: null,
				notesPath,
				notesSeed,
				markdownSeed: "",
				loaded: true,
				didDownloadAssets: didDownload,
			};
		}

		// A file inside a paper folder (e.g. NOTES.md, a nested PDF, or figure).
		const mode = preferredModeForPath(path);
		let pdfUrl = paperPdf;
		let imageUrl: string | null = null;
		let markdownSeed = "";

		if (isPdfPath(path)) {
			// Prefer the exact file the user clicked (may differ from canonical {id}.pdf).
			const exact = await localPdfToViewerSource(path);
			if (exact) {
				if (paperPdf && paperPdf !== exact) {
					revokePdfViewerSource(paperPdf);
				}
				pdfUrl = exact;
			} else {
				pdfUrl = paperPdf;
			}
		} else if (isImagePath(path)) {
			imageUrl = await localImageToViewerSource(path, imageMimeFromPath(path));
			if (!imageUrl) {
				return {
					kind: "file",
					title: basenameOf(path),
					mode: "image",
					paperMeta: meta,
					pdfUrl: paperPdf,
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
		}
		if (isTextOpenable(path)) {
			try {
				markdownSeed = await readVaultFile(path);
			} catch {
				// Leave the editor empty when the file cannot be read.
			}
		}

		return {
			kind: "file",
			title: basenameOf(path),
			mode,
			paperMeta: meta,
			pdfUrl,
			htmlUrl,
			imageUrl,
			notesPath,
			notesSeed,
			markdownSeed,
			loaded: true,
			didDownloadAssets: didDownload,
		};
	}

	// Plain file, not under a paper folder (vault root, notes/, etc.).
	const mode = preferredModeForPath(path);
	const base = {
		kind: "file" as const,
		title: basenameOf(path),
		mode,
		paperMeta: null,
		pdfUrl: null as string | null,
		htmlUrl: null as string | null,
		imageUrl: null as string | null,
		notesPath: null,
		notesSeed: "",
		markdownSeed: "",
		loaded: true as const,
	};

	if (isPdfPath(path)) {
		const pdfUrl = await localPdfToViewerSource(path);
		if (!pdfUrl) {
			return { ...base, mode: "pdf", error: "cannotPreview" };
		}
		return { ...base, mode: "pdf", pdfUrl };
	}

	if (isImagePath(path)) {
		const imageUrl = await localImageToViewerSource(
			path,
			imageMimeFromPath(path),
		);
		if (!imageUrl) {
			return { ...base, mode: "image", error: "cannotPreview" };
		}
		return { ...base, mode: "image", imageUrl };
	}

	if (isHtmlPath(path)) {
		// Local HTML still has no sandboxed file:// preview (remote only for paper HTML).
		return base;
	}

	if (!isTextOpenable(path)) {
		return { ...base, error: "cannotPreview" };
	}

	try {
		const markdownSeed = await readVaultFile(path);
		return { ...base, markdownSeed };
	} catch (e) {
		return {
			...base,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}
