import type { PaperMetadata } from "@/lib/paper-metadata";
import {
	isLibraryVirtualPath,
	isTrashVirtualPath,
	LIBRARY_VIRTUAL_PATH,
	TRASH_VIRTUAL_PATH,
} from "@/lib/papers-api";
import type { CenterViewMode } from "@/lib/viewer";

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
