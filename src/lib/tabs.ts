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
import {
	isLibraryVirtualPath,
	isTrashVirtualPath,
	LIBRARY_VIRTUAL_PATH,
	TRASH_VIRTUAL_PATH,
} from "@/lib/papers-api";
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

export type DocTabKind = "library" | "trash" | "paper" | "file";

/** One open document in the center tab strip (browser-style multi-tab). */
export type DocTab = {
	/** Stable id derived from the normalized path (dedupe / reorder). */
	id: string;
	/** Absolute path, or the Library virtual path. */
	path: string;
	kind: DocTabKind;
	title: string;
	/** Current view for this tab. */
	mode: CenterViewMode;
	paperMeta: PaperMetadata | null;
	pdfUrl: string | null;
	htmlUrl: string | null;
	/** Local image preview (`blob:`) when mode is image. */
	imageUrl: string | null;
	notesPath: string | null;
	/** Seed content for the NOTES editor (live content lives inside the editor). */
	notesSeed: string;
	/** Seed content for a plain-file Markdown editor. */
	markdownSeed: string;
	markdownDirty: boolean;
	notesDirty: boolean;
	/** Bump to remount + reseed the center Markdown editor. */
	seedKey: number;
	/** Bump to remount + reseed the NOTES editor. */
	notesKey: number;
	loaded: boolean;
};

const NOTES_PLACEHOLDER = "# Notes\n\nNo NOTES.md found for this paper.\n";

/** Normalize a path for id / equality (case-insensitive, no trailing slash). */
export function normalizeTabPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function tabIdForPath(path: string): string {
	if (isLibraryVirtualPath(path)) return LIBRARY_VIRTUAL_PATH;
	if (isTrashVirtualPath(path)) return TRASH_VIRTUAL_PATH;
	return normalizeTabPath(path);
}

export function basenameOf(path: string): string {
	return (
		path
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.pop() ?? path
	);
}

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

/** Whether the tab's active view exposes the side NOTES column. */
export function tabNotesEligible(tab: DocTab | null): boolean {
	if (!tab) return false;
	return (
		tab.kind !== "library" &&
		Boolean(tab.paperMeta) &&
		(tab.mode === "pdf" || tab.mode === "html")
	);
}

/** Center Markdown mode while a paper is open edits its NOTES.md live. */
export function tabIsPaperNotes(tab: DocTab | null): boolean {
	if (!tab?.paperMeta || tab.mode !== "markdown" || !tab.notesPath) {
		return false;
	}
	const tabPath = normalizeTabPath(tab.path);
	const notesPath = normalizeTabPath(tab.notesPath);
	const paperDir = notesPath.replace(/\/notes\.md$/, "");
	return tabPath === notesPath || tabPath === paperDir;
}

// --- Pure tab-list operations (unit-tested in test/tabs.test.ts) ---

/** Placeholder tab shown immediately while its resources load asynchronously. */
export function createPlaceholderTab(
	path: string,
	preferMode: CenterViewMode = "markdown",
): DocTab {
	const isLibrary = isLibraryVirtualPath(path);
	const isTrash = isTrashVirtualPath(path);
	return {
		id: tabIdForPath(path),
		path: isLibrary
			? LIBRARY_VIRTUAL_PATH
			: isTrash
				? TRASH_VIRTUAL_PATH
				: path,
		kind: isLibrary ? "library" : isTrash ? "trash" : "file",
		title: isLibrary ? "Library" : isTrash ? "Recycle Bin" : basenameOf(path),
		mode: preferMode,
		paperMeta: null,
		pdfUrl: null,
		htmlUrl: null,
		imageUrl: null,
		notesPath: null,
		notesSeed: "",
		markdownSeed: "",
		markdownDirty: false,
		notesDirty: false,
		seedKey: 0,
		notesKey: 0,
		loaded: false,
	};
}

/**
 * Ensure the full-library tab exists; returns the next tabs + active id.
 * Used when the tab strip would otherwise be empty (default page).
 */
export function ensureFullLibraryTab(prev: DocTab[]): {
	tabs: DocTab[];
	activeId: string;
	inserted: boolean;
} {
	const existing = prev.find((t) => isLibraryVirtualPath(t.path));
	if (existing) {
		return { tabs: prev, activeId: existing.id, inserted: false };
	}
	const tab: DocTab = {
		...createPlaceholderTab(LIBRARY_VIRTUAL_PATH),
		kind: "library",
		title: "Library",
		loaded: true,
	};
	return { tabs: [...prev, tab], activeId: tab.id, inserted: true };
}

/** Insert a placeholder tab for `path` unless a tab for it already exists. */
export function insertPlaceholderTab(
	prev: DocTab[],
	path: string,
	preferMode: CenterViewMode = "markdown",
): { tabs: DocTab[]; id: string; exists: boolean } {
	const id = tabIdForPath(path);
	if (prev.some((t) => t.id === id)) return { tabs: prev, id, exists: true };
	return {
		tabs: [...prev, createPlaceholderTab(path, preferMode)],
		id,
		exists: false,
	};
}

/** Merge a patch into the tab with the given id. */
export function patchTab(
	prev: DocTab[],
	id: string,
	patch: Partial<DocTab>,
): DocTab[] {
	return prev.map((t) => (t.id === id ? { ...t, ...patch } : t));
}

/** Remove a tab and pick the next active id (a neighbor, or null when emptied). */
export function removeTab(
	prev: DocTab[],
	id: string,
	activeId: string | null,
): { tabs: DocTab[]; removed: DocTab | null; activeId: string | null } {
	const idx = prev.findIndex((t) => t.id === id);
	if (idx < 0) return { tabs: prev, removed: null, activeId };
	const removed = prev[idx] ?? null;
	const tabs = prev.filter((t) => t.id !== id);
	let nextActiveId = activeId;
	if (activeId === id) {
		nextActiveId = tabs.length
			? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null)
			: null;
	}
	return { tabs, removed, activeId: nextActiveId };
}

/** Remove every tab at or under `path`; Library/Trash virtual tabs are kept. */
export function removeTabsUnderPath(
	prev: DocTab[],
	path: string,
	activeId: string | null,
): { tabs: DocTab[]; removed: DocTab[]; activeId: string | null } {
	const key = normalizeTabPath(path);
	const survivors: DocTab[] = [];
	const removed: DocTab[] = [];
	for (const t of prev) {
		if (isLibraryVirtualPath(t.path)) {
			survivors.push(t);
			continue;
		}
		const tk = normalizeTabPath(t.path);
		if (tk === key || tk.startsWith(`${key}/`)) {
			removed.push(t);
			continue;
		}
		survivors.push(t);
	}
	if (!removed.length) return { tabs: prev, removed, activeId };
	const nextActiveId = survivors.some((t) => t.id === activeId)
		? activeId
		: (survivors[survivors.length - 1]?.id ?? null);
	return { tabs: survivors, removed, activeId: nextActiveId };
}

/** Move the tab `fromId` to the current position of `toId`. */
export function moveTab(
	prev: DocTab[],
	fromId: string,
	toId: string,
): DocTab[] {
	const from = prev.findIndex((t) => t.id === fromId);
	const to = prev.findIndex((t) => t.id === toId);
	if (from < 0 || to < 0 || from === to) return prev;
	const next = [...prev];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

/** Active tab id after cycling by `delta` (wraps); unchanged with fewer than 2 tabs. */
export function cycleActiveTabId(
	list: DocTab[],
	activeId: string | null,
	delta: number,
): string | null {
	if (list.length < 2) return activeId;
	const idx = list.findIndex((t) => t.id === activeId);
	const nextIdx = (idx + delta + list.length) % list.length;
	return list[nextIdx]?.id ?? activeId;
}

/** Reseed an open paper tab's NOTES editor (bumps notesKey to remount). */
export function reseedNotesTab(
	prev: DocTab[],
	paperDir: string,
	content: string,
): DocTab[] {
	const id = tabIdForPath(paperDir);
	return prev.map((t) =>
		t.id === id
			? {
					...t,
					notesSeed: content,
					notesDirty: false,
					notesKey: t.notesKey + 1,
				}
			: t,
	);
}

/** Reseed an open plain-Markdown tab (bumps seedKey to remount). */
export function reseedMarkdownTab(
	prev: DocTab[],
	absPath: string,
	content: string,
): DocTab[] {
	const id = tabIdForPath(absPath);
	return prev.map((t) =>
		t.id === id
			? {
					...t,
					markdownSeed: content,
					markdownDirty: false,
					seedKey: t.seedKey + 1,
				}
			: t,
	);
}

/** Keep the seed of the tab(s) owning `path` in sync after a disk write. */
export function syncTabSeedsForPath(
	prev: DocTab[],
	path: string,
	content: string,
): DocTab[] {
	const key = path.replace(/\\/g, "/").toLowerCase();
	return prev.map((tab) => {
		const notesKey = tab.notesPath?.replace(/\\/g, "/").toLowerCase();
		if (notesKey === key) return { ...tab, notesSeed: content };
		if (normalizeTabPath(tab.path) === normalizeTabPath(path)) {
			return { ...tab, markdownSeed: content };
		}
		return tab;
	});
}

// --- Tab session persistence (per-window, best-effort localStorage) ---

const TABS_STORAGE_KEY = "agentero-open-tabs";

export type PersistedTab = { path: string; mode: CenterViewMode };
export type PersistedTabs = { tabs: PersistedTab[]; activeIndex: number };

/** Read and validate the previously persisted open tabs for this window. */
export function loadPersistedTabs(): PersistedTabs | null {
	try {
		const raw = localStorage.getItem(TABS_STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as PersistedTabs;
		if (!parsed || !Array.isArray(parsed.tabs)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Persist the current open tabs and active index (best-effort). */
export function savePersistedTabs(
	tabs: DocTab[],
	activeTabId: string | null,
): void {
	try {
		const payload: PersistedTabs = {
			tabs: tabs.map((t) => ({ path: t.path, mode: t.mode })),
			activeIndex: Math.max(
				0,
				tabs.findIndex((t) => t.id === activeTabId),
			),
		};
		if (payload.tabs.length) {
			localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(payload));
		} else {
			localStorage.removeItem(TABS_STORAGE_KEY);
		}
	} catch {
		// localStorage may be unavailable; tab restore is best-effort.
	}
}
