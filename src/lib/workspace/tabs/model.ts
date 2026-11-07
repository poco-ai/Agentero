import {
	isLibraryVirtualPath,
	isTrashVirtualPath,
	LIBRARY_VIRTUAL_PATH,
	TRASH_VIRTUAL_PATH,
} from "@/lib/paper/api";
import { isPlazaVirtualPath, plazaTitleForPath } from "@/lib/plaza";
import { isResearchTablePath, TABLE_SUFFIX } from "@/lib/research-table/model";
import { basenameOf, normalizePathKey } from "@/lib/vault/path";
import type { DocTab, TabResources } from "@/lib/workspace/tabs/types";
import type { CenterViewMode } from "@/lib/workspace/viewer";

export { basenameOf, normalizePathKey as normalizeTabPath };

export const SPLIT_PANE_ID_MARKER = "::pane-";

/** Tab label for a file path. Research tables hide the `.table.json` suffix. */
export function tabTitleForPath(path: string): string {
	const base = basenameOf(path);
	if (!isResearchTablePath(base)) return base;
	const stem = base.slice(0, -TABLE_SUFFIX.length);
	return stem || base;
}

export function tabIdForPath(path: string): string {
	if (isLibraryVirtualPath(path)) return LIBRARY_VIRTUAL_PATH;
	if (isTrashVirtualPath(path)) return TRASH_VIRTUAL_PATH;
	if (isPlazaVirtualPath(path)) return path;
	return normalizePathKey(path);
}

export function isCanonicalTabIdForPath(id: string, path: string): boolean {
	return id === tabIdForPath(path);
}

export function splitPaneIdForPath(
	path: string,
	existingIds: Iterable<string>,
): string {
	const base = tabIdForPath(path);
	const taken = new Set(existingIds);
	let index = 2;
	let id = `${base}${SPLIT_PANE_ID_MARKER}${index}`;
	while (taken.has(id)) {
		index += 1;
		id = `${base}${SPLIT_PANE_ID_MARKER}${index}`;
	}
	return id;
}

function remapTabIdForPath(
	id: string,
	fromPath: string,
	toPath: string,
): string {
	const fromBase = tabIdForPath(fromPath);
	const toBase = tabIdForPath(toPath);
	if (id === fromBase) return toBase;
	if (id.startsWith(`${fromBase}${SPLIT_PANE_ID_MARKER}`)) {
		return `${toBase}${id.slice(fromBase.length)}`;
	}
	return toBase;
}

/** Rewrite one absolute or Vault-relative path under a moved root. */
export function remapPathUnder(path: string, from: string, to: string): string {
	if (isLibraryVirtualPath(path) || isTrashVirtualPath(path)) return path;
	if (isPlazaVirtualPath(path)) return path;
	const current = path.replace(/\\/g, "/").replace(/\/+$/, "");
	const oldRoot = from.replace(/\\/g, "/").replace(/\/+$/, "");
	const newRoot = to.replace(/\\/g, "/").replace(/\/+$/, "");
	const currentKey = current.toLowerCase();
	const oldKey = oldRoot.toLowerCase();
	if (currentKey === oldKey) return newRoot;
	if (currentKey.startsWith(`${oldKey}/`)) {
		return `${newRoot}${current.slice(oldRoot.length)}`;
	}
	return path;
}

/** Keep tabs mounted while a file or directory changes its Vault path. */
export function remapTabsUnderPath(
	prev: DocTab[],
	from: string,
	to: string,
	fromRel: string,
	toRel: string,
): DocTab[] {
	return prev.map((tab) => {
		const path = remapPathUnder(tab.path, from, to);
		const notesPath = tab.notesPath
			? remapPathUnder(tab.notesPath, from, to)
			: null;
		const pdfUrl = tab.pdfUrl ? remapPathUnder(tab.pdfUrl, from, to) : null;
		const imageUrl = tab.imageUrl
			? remapPathUnder(tab.imageUrl, from, to)
			: null;
		const paperMeta = tab.paperMeta;
		let nextPaperMeta = paperMeta;
		if (paperMeta) {
			const remappedPaperPath = remapPathUnder(paperMeta.path, fromRel, toRel);
			if (remappedPaperPath !== paperMeta.path) {
				nextPaperMeta = { ...paperMeta, path: remappedPaperPath };
			}
		}
		if (
			path === tab.path &&
			notesPath === tab.notesPath &&
			pdfUrl === tab.pdfUrl &&
			imageUrl === tab.imageUrl &&
			nextPaperMeta === paperMeta
		) {
			return tab;
		}
		return {
			...tab,
			id: remapTabIdForPath(tab.id, tab.path, path),
			path,
			notesPath,
			pdfUrl,
			imageUrl,
			paperMeta: nextPaperMeta,
		};
	});
}

export function createPlaceholderTab(
	path: string,
	preferMode: CenterViewMode = "markdown",
	id = tabIdForPath(path),
): DocTab {
	const isLibrary = isLibraryVirtualPath(path);
	const isTrash = isTrashVirtualPath(path);
	const isPlaza = isPlazaVirtualPath(path);
	return {
		id,
		path: isLibrary
			? LIBRARY_VIRTUAL_PATH
			: isTrash
				? TRASH_VIRTUAL_PATH
				: path,
		kind: isLibrary
			? "library"
			: isTrash
				? "trash"
				: isPlaza
					? "plaza"
					: "file",
		title: isLibrary
			? "Library"
			: isTrash
				? "Recycle Bin"
				: isPlaza
					? plazaTitleForPath(path)
					: tabTitleForPath(path),
		mode: preferMode,
		paperMeta: null,
		pdfUrl: null,
		pdfBytes: null,
		htmlUrl: null,
		imageUrl: null,
		notesPath: null,
		notesSeed: "",
		markdownSeed: "",
		excalidrawSeed: "",
		textSeed: "",
		markdownDirty: false,
		notesDirty: false,
		excalidrawDirty: false,
		textDirty: false,
		seedKey: 0,
		notesKey: 0,
		excalidrawKey: 0,
		textKey: 0,
		htmlKey: 0,
		loaded: false,
	};
}

/**
 * Ensure the full-library tab exists; returns the next tabs + active id.
 * The Library tab is resident: every mutation path re-inserts it when missing.
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

/**
 * Fields a freshly loaded `TabResources` fills in on top of a tab. When the
 * tab already renders this paper as PDF (restored placeholder, ⇧⌘T reopen,
 * doc popout), a single failed local-PDF probe must not downgrade it to an
 * empty Markdown editor — keep `pdf` and let the viewer surface the state.
 */
export function patchFromTabResources(
	res: TabResources,
	current?: DocTab | null,
): Partial<DocTab> {
	const keepPdfMode =
		current?.mode === "pdf" &&
		res.mode === "markdown" &&
		(current.kind === "paper" || res.kind === "paper");
	return {
		kind: res.kind,
		title: res.title,
		mode: keepPdfMode ? "pdf" : res.mode,
		paperMeta: res.paperMeta,
		pdfUrl: res.pdfUrl,
		pdfBytes: res.pdfBytes ?? null,
		htmlUrl: res.htmlUrl,
		imageUrl: res.imageUrl,
		notesPath: res.notesPath,
		notesSeed: res.notesSeed,
		markdownSeed: res.markdownSeed,
		excalidrawSeed: res.excalidrawSeed ?? "",
		textSeed: res.textSeed ?? "",
		seedKey: 1,
		loaded: true,
	};
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

/** Merge a patch into the tab with the given id (primary pane fields only). */
export function patchTab(
	prev: DocTab[],
	id: string,
	patch: Partial<DocTab>,
): DocTab[] {
	const idx = prev.findIndex((t) => t.id === id);
	if (idx < 0) return prev;
	const current = prev[idx];
	// No-op patches (e.g. notesDirty: true → true) must keep the array and the
	// tab identity: DocView's memo compares `tab` by reference, so minting a
	// fresh object per patch re-rendered every pane's editor.
	let changed = false;
	for (const key of Object.keys(patch) as (keyof DocTab)[]) {
		if (current[key] !== patch[key]) {
			changed = true;
			break;
		}
	}
	if (!changed) return prev;
	const next = prev.slice();
	next[idx] = { ...current, ...patch };
	return next;
}

/**
 * Remove a tab from the React list only.
 * Active focus is owned by dockview (`onDidActivePanelChange`); do not pick a neighbor here.
 */
export function removeTab(
	prev: DocTab[],
	id: string,
): { tabs: DocTab[]; removed: DocTab | null } {
	const idx = prev.findIndex((t) => t.id === id);
	if (idx < 0) return { tabs: prev, removed: null };
	const removed = prev[idx] ?? null;
	const tabs = prev.filter((t) => t.id !== id);
	return { tabs, removed };
}

/** Remove every tab at or under `path`; Library/Trash/Plaza virtual tabs are kept. */
export function removeTabsUnderPath(
	prev: DocTab[],
	path: string,
): {
	tabs: DocTab[];
	removed: DocTab[];
} {
	const key = normalizePathKey(path);
	const hit = (p: string) => {
		const k = normalizePathKey(p);
		return k === key || k.startsWith(`${key}/`);
	};
	const survivors: DocTab[] = [];
	const removed: DocTab[] = [];
	for (const t of prev) {
		if (isLibraryVirtualPath(t.path) || isPlazaVirtualPath(t.path)) {
			survivors.push(t);
			continue;
		}
		if (hit(t.path)) {
			removed.push(t);
			continue;
		}
		survivors.push(t);
	}
	if (!removed.length) {
		return { tabs: prev, removed };
	}
	return { tabs: survivors, removed };
}
