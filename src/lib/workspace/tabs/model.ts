import i18n from "@/i18n";
import { isZenVirtualPath, ZEN_VIRTUAL_PATH } from "@/lib/agent/zen-path";
import {
	isLibraryVirtualPath,
	isTrashVirtualPath,
	LIBRARY_VIRTUAL_PATH,
	TRASH_VIRTUAL_PATH,
} from "@/lib/paper/api";
import { isPlazaVirtualPath, plazaTitleForPath } from "@/lib/plaza";
import { isResearchTablePath, TABLE_SUFFIX } from "@/lib/research-table/model";
import { basenameOf, normalizePathKey } from "@/lib/vault/path";
import type {
	DocTab,
	TabPaneKind,
	TabResources,
} from "@/lib/workspace/tabs/types";
import type { CenterViewMode } from "@/lib/workspace/viewer";

export { basenameOf, normalizePathKey as normalizeTabPath };

export const SPLIT_PANE_ID_MARKER = "::pane-";
export const TRANSLATION_PANE_ID_MARKER = "::translation";
const VIEW_ID_PREFIX = "view-";

/** Tab label for a file path. Research tables hide the `.table.json` suffix. */
export function tabTitleForPath(path: string): string {
	const base = basenameOf(path);
	if (!isResearchTablePath(base)) return base;
	const stem = base.slice(0, -TABLE_SUFFIX.length);
	return stem || base;
}

/**
 * Virtual-path id, and the legacy path-shaped id of a restored panel.
 * New file and paper views do not use this as their panel id.
 */
export function tabIdForPath(path: string): string {
	if (isLibraryVirtualPath(path)) return LIBRARY_VIRTUAL_PATH;
	if (isTrashVirtualPath(path)) return TRASH_VIRTUAL_PATH;
	if (isZenVirtualPath(path)) return ZEN_VIRTUAL_PATH;
	if (isPlazaVirtualPath(path)) return path;
	return normalizePathKey(path);
}

function isStableVirtualPath(path: string): boolean {
	return (
		isLibraryVirtualPath(path) ||
		isTrashVirtualPath(path) ||
		isZenVirtualPath(path) ||
		isPlazaVirtualPath(path)
	);
}

/** True when `id` is the legacy path-shaped canonical id for `path`. */
export function isCanonicalTabIdForPath(id: string, path: string): boolean {
	return id === tabIdForPath(path);
}

export function isOpaqueViewId(id: string): boolean {
	return id.startsWith(VIEW_ID_PREFIX);
}

/** New file / paper view id. Not a filesystem path. */
export function createViewId(): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	if (uuid) return `${VIEW_ID_PREFIX}${uuid}`;
	return `${VIEW_ID_PREFIX}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Old panel ids encode the role. New ids carry it on `pane` instead. */
export function legacyPaneKindFromId(id: string): TabPaneKind | undefined {
	if (id.includes(SPLIT_PANE_ID_MARKER)) return "split";
	if (id.includes(TRANSLATION_PANE_ID_MARKER)) return "translation";
	return undefined;
}

/**
 * Path encoded in a legacy panel id.
 * Opaque `view-` ids are not paths. `::pane-` / `::translation` are stripped.
 */
export function legacyPathFromPanelId(id: string): string | null {
	if (!id || isOpaqueViewId(id)) return null;
	const paneAt = id.indexOf(SPLIT_PANE_ID_MARKER);
	const translationAt = id.indexOf(TRANSLATION_PANE_ID_MARKER);
	let base = id;
	if (paneAt >= 0 && (translationAt < 0 || paneAt < translationAt)) {
		base = id.slice(0, paneAt);
	} else if (translationAt >= 0) {
		base = id.slice(0, translationAt);
	}
	if (!base || isOpaqueViewId(base)) return null;
	if (
		isStableVirtualPath(base) ||
		base.includes("/") ||
		base.includes("\\") ||
		/^[A-Za-z]:/.test(base)
	) {
		return base;
	}
	return null;
}

export function isCanonicalView(tab: { pane?: TabPaneKind | null }): boolean {
	return tab.pane !== "split" && tab.pane !== "translation";
}

/**
 * Canonical view for a path: not a split copy and not a translation pane.
 * Virtual paths still resolve through {@link tabIdForPath}.
 */
export function findCanonicalTab<
	T extends { id: string; path: string; pane?: TabPaneKind | null },
>(tabs: readonly T[], path: string): T | undefined {
	if (!path) return undefined;
	if (isStableVirtualPath(path)) {
		const id = tabIdForPath(path);
		return tabs.find((tab) => tab.id === id);
	}
	const key = normalizePathKey(path);
	return tabs.find(
		(tab) => normalizePathKey(tab.path) === key && isCanonicalView(tab),
	);
}

/** Allocate an opaque id for a new split copy. The path stays on the tab. */
export function splitPaneIdForPath(
	_path: string,
	existingIds: Iterable<string>,
): string {
	const taken = new Set(existingIds);
	let id = createViewId();
	while (taken.has(id)) id = createViewId();
	return id;
}

/** Rewrite one absolute or Vault-relative path under a moved root. */
export function remapPathUnder(path: string, from: string, to: string): string {
	if (isLibraryVirtualPath(path) || isTrashVirtualPath(path)) return path;
	if (isZenVirtualPath(path)) return path;
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
		const writingRoot = tab.writingRoot
			? remapPathUnder(tab.writingRoot, from, to)
			: undefined;
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
			writingRoot === tab.writingRoot &&
			nextPaperMeta === paperMeta
		) {
			return tab;
		}
		return {
			...tab,
			path,
			notesPath,
			pdfUrl,
			imageUrl,
			writingRoot,
			paperMeta: nextPaperMeta,
		};
	});
}

export function createPlaceholderTab(
	path: string,
	preferMode: CenterViewMode = "markdown",
	id?: string,
): DocTab {
	const isLibrary = isLibraryVirtualPath(path);
	const isTrash = isTrashVirtualPath(path);
	const isZen = isZenVirtualPath(path);
	const isPlaza = isPlazaVirtualPath(path);
	const resolvedId =
		id ?? (isStableVirtualPath(path) ? tabIdForPath(path) : createViewId());
	const legacyPane = legacyPaneKindFromId(resolvedId);
	return {
		id: resolvedId,
		...(legacyPane ? { pane: legacyPane } : {}),
		path: isLibrary
			? LIBRARY_VIRTUAL_PATH
			: isTrash
				? TRASH_VIRTUAL_PATH
				: isZen
					? ZEN_VIRTUAL_PATH
					: path,
		kind: isLibrary
			? "library"
			: isTrash
				? "trash"
				: isZen
					? "zen"
					: isPlaza
						? "plaza"
						: "file",
		title: isLibrary
			? "Library"
			: isTrash
				? "Recycle Bin"
				: isZen
					? i18n.t("sidebar:zen.title")
					: isPlaza
						? plazaTitleForPath(path)
						: tabTitleForPath(path),
		mode: preferMode,
		paperMeta: null,
		pdfUrl: null,
		pdfBytes: null,
		htmlUrl: null,
		htmlArchivePath: null,
		imageUrl: null,
		notesPath: null,
		notesSeed: "",
		markdownSeed: "",
		textSeed: "",
		markdownDirty: false,
		notesDirty: false,
		textDirty: false,
		seedKey: 0,
		notesKey: 0,
		textKey: 0,
		textEpoch: 0,
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
	// A translation view shares the paper path, not the source view id.
	// Hydration must not turn it into a second body, or reuse a blob lease.
	const keepTranslation = current?.mode === "translation";
	const pdfUrl =
		keepTranslation && res.pdfUrl?.startsWith("blob:") ? null : res.pdfUrl;
	return {
		kind: res.kind,
		title: res.title,
		mode: keepTranslation ? "translation" : keepPdfMode ? "pdf" : res.mode,
		paperMeta: res.paperMeta,
		pdfUrl,
		pdfBytes:
			keepTranslation && res.pdfBytes
				? res.pdfBytes.slice(0)
				: (res.pdfBytes ?? null),
		htmlUrl: res.htmlUrl,
		htmlArchivePath: res.htmlArchivePath ?? null,
		imageUrl: res.imageUrl,
		notesPath: res.notesPath,
		notesSeed: res.notesSeed,
		markdownSeed: res.markdownSeed,
		textSeed: res.textSeed ?? "",
		seedKey: 1,
		loadError:
			current &&
			res.mode === "markdown" &&
			res.notesPath &&
			normalizePathKey(current.path) === normalizePathKey(res.notesPath)
				? res.error
				: undefined,
		loaded: true,
	};
}

/** Insert a placeholder tab for `path` unless a tab for it already exists. */
export function insertPlaceholderTab(
	prev: DocTab[],
	path: string,
	preferMode: CenterViewMode = "markdown",
): { tabs: DocTab[]; id: string; exists: boolean } {
	const existing = findCanonicalTab(prev, path);
	if (existing) return { tabs: prev, id: existing.id, exists: true };
	const tab = createPlaceholderTab(path, preferMode);
	return {
		tabs: [...prev, tab],
		id: tab.id,
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

/**
 * Tab list after moving one view into a document window.
 * Only `viewId` leaves. A paper body's NOTES companion is a different id
 * and stays; this must not use `readingPairCloseIds`.
 */
export function tabsAfterMovedView(tabs: DocTab[], viewId: string): DocTab[] {
	return removeTab(tabs, viewId).tabs;
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
