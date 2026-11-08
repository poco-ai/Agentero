import i18n from "@/i18n";
import { isRemoteArxivPath, notesPathForPaper } from "@/lib/paper";
import {
	createPlaceholderTab,
	isCanonicalTabIdForPath,
	normalizeTabPath,
	tabIdForPath,
} from "@/lib/workspace/tabs/model";
import type {
	DocTab,
	OpenPlacement,
	ReadingColumns,
} from "@/lib/workspace/tabs/types";
import { viewerModeSpec } from "@/lib/workspace/viewer";

export function tabNotesEligible(tab: DocTab | null): boolean {
	if (!tab) return false;
	return (
		tab.kind !== "library" &&
		!isRemoteArxivPath(tab.path) &&
		(tab.mode === "pdf" || tab.mode === "html") &&
		Boolean(tab.paperMeta ?? tab.notesPath)
	);
}

/**
 * Paper body panel (PDF/HTML) — left column of the reading split.
 * Distinct from the NOTES.md markdown panel for the same paper.
 */
export function isPaperContentTab(tab: DocTab | null): boolean {
	return tabNotesEligible(tab);
}

/** Center Markdown mode while a paper is open edits its NOTES.md live. */
export function tabIsPaperNotes(tab: DocTab | null): boolean {
	if (tab?.mode !== "markdown" || !tab.notesPath) {
		return false;
	}
	const tabPath = normalizeTabPath(tab.path);
	const notesPath = normalizeTabPath(tab.notesPath);
	const paperDir = notesPath.replace(/\/notes\.md$/, "");
	return tabPath === notesPath || tabPath === paperDir;
}

/**
 * Markdown tab that represents a paper note: canonical `NOTES.md` (or the paper
 * root markdown tab) plus any extra note opened from inside the paper folder.
 * Broader than {@link tabIsPaperNotes} so a replaced notes column keeps being
 * recognized after showing an extra note.
 */
export function tabIsPaperNoteDocument(tab: DocTab | null): boolean {
	if (tab?.mode !== "markdown" || !tab.notesPath || tab.kind === "paper") {
		return false;
	}
	const paperDir = normalizeTabPath(tab.notesPath).replace(/\/notes\.md$/, "");
	const tabPath = normalizeTabPath(tab.path);
	return (
		tabPath === normalizeTabPath(tab.notesPath) ||
		tabPath === paperDir ||
		tabPath.startsWith(`${paperDir}/`)
	);
}

/**
 * Notes panel a newly opened note should replace instead of stacking another
 * tab in the reading column. Prefers the active notes pane, then the notes
 * companion of the active paper body, then the first open notes pane.
 */
export function findNotesPaneForReplacement(
	tabs: DocTab[],
	activeId?: string | null,
): DocTab | null {
	const active = tabs.find((t) => t.id === activeId) ?? null;
	if (tabIsPaperNoteDocument(active)) return active;
	const companion = findReadingCompanion(tabs, active);
	if (tabIsPaperNoteDocument(companion)) return companion;
	return tabs.find((t) => tabIsPaperNoteDocument(t)) ?? null;
}

/**
 * Anchor for stacking another NOTES panel into the right reading column.
 */
export function findNotesColumnAnchor(
	tabs: DocTab[],
	opts?: { excludeId?: string; preferId?: string | null },
): DocTab | null {
	const candidates = tabs.filter(
		(t) => t.id !== opts?.excludeId && tabIsPaperNotes(t),
	);
	if (!candidates.length) return null;
	if (opts?.preferId) {
		const preferred = candidates.find((t) => t.id === opts.preferId);
		if (preferred) return preferred;
	}
	return candidates[0] ?? null;
}

/**
 * Where to place a newly opened paper body / NOTES companion.
 *
 * Inside the standard two-column reading layout (`columns`) the paper body
 * joins the left column and NOTES the right one, independent of focus. With
 * any other layout paper bodies use normal dock placement (active group /
 * default) so multi-paper layouts can split freely, and NOTES still prefer an
 * existing notes column; otherwise they open to the right of the paper.
 */
export function paperReadingPlacements(
	tabs: DocTab[],
	opts: {
		paperId: string;
		notesId?: string | null;
		/** Prefer stacking relative to the currently active panel when possible. */
		activeId?: string | null;
		/** Explicit placement from file-tree drop etc. wins for the paper body. */
		forcedPaperPlacement?: OpenPlacement;
		/** Anchors of an existing two-column reading layout (paper | notes). */
		columns?: ReadingColumns | null;
	},
): {
	paper: OpenPlacement;
	notes: OpenPlacement;
} {
	const notesAnchor = opts.columns
		? null
		: opts.notesId
			? findNotesColumnAnchor(tabs, {
					excludeId: opts.notesId,
					preferId: opts.activeId,
				})
			: null;
	const notes: OpenPlacement = opts.columns
		? { direction: "within", referencePanelId: opts.columns.rightAnchorId }
		: notesAnchor
			? { direction: "within", referencePanelId: notesAnchor.id }
			: { direction: "right", referencePanelId: opts.paperId };

	if (opts.forcedPaperPlacement) {
		return {
			paper: opts.forcedPaperPlacement,
			notes,
		};
	}

	if (opts.columns) {
		return {
			paper: {
				direction: "within",
				referencePanelId: opts.columns.leftAnchorId,
			},
			notes,
		};
	}

	// null → dockview activates existing / adds to the active group (free layout).
	return { paper: null, notes };
}

export function createNotesSplitPane(tab: DocTab): DocTab | null {
	if (!tab.notesPath) return null;
	return {
		...createPlaceholderTab(tab.notesPath, "markdown"),
		kind: "file",
		title: i18n.t("app:labels.notes"),
		paperMeta: tab.paperMeta,
		notesPath: tab.notesPath,
		notesSeed: tab.notesSeed,
		loaded: true,
	};
}

/** Whether NOTES.md for this paper is already open as a panel. */
export function tabHasNotesSplit(
	tabs: DocTab[],
	paperTab: DocTab | null,
): boolean {
	if (!paperTab?.notesPath) return false;
	const notesId = tabIdForPath(paperTab.notesPath);
	return tabs.some((t) => t.id === notesId);
}

/**
 * Open NOTES companion of a paper body (PDF/HTML). Null when the tab is not
 * a paper body or its NOTES panel is not open.
 */
export function findReadingCompanion(
	tabs: DocTab[],
	tab: DocTab | null,
): DocTab | null {
	if (!tab || !isPaperContentTab(tab) || !tab.notesPath) return null;
	if (!isCanonicalTabIdForPath(tab.id, tab.path)) return null;
	const notesId = tabIdForPath(tab.notesPath);
	return tabs.find((t) => t.id === notesId) ?? null;
}

/**
 * Panel ids to close together: closing a paper body (PDF/HTML) also closes
 * its open NOTES panel, but closing NOTES leaves the body open.
 */
export function readingPairCloseIds(tabs: DocTab[], id: string): string[] {
	const tab = tabs.find((t) => t.id === id) ?? null;
	const companion = findReadingCompanion(tabs, tab);
	if (!companion || companion.id === id) return [id];
	// Companion first so body/NOTES order is stable for tests and revoke order.
	return [companion.id, id];
}

/**
 * Text-like editor kinds whose tab carries a disk-content seed. Each kind maps
 * to the `{seed, dirty, key}` fields on DocTab plus how own saves differ from
 * external writes, so one generic patch covers the whole reseed/refresh series.
 */
type SeedKind = "notes" | "markdown" | "excalidraw" | "text";

type SeedSpec = {
	/** Whether this tab's editor renders the path. Notes tabs pair with the
	 * paper dir: either the NOTES.md tab id or the paper body tab id. */
	owns: (tab: DocTab, norm: string, absPath: string) => boolean;
	/** Tab fields holding the in-memory seed / unsaved-edits flag / reload key. */
	seed: "notesSeed" | "markdownSeed" | "excalidrawSeed" | "textSeed";
	dirty: "notesDirty" | "markdownDirty" | "excalidrawDirty" | "textDirty";
	key: "notesKey" | "seedKey" | "excalidrawKey" | "textKey";
	/** Own saves bump the reload key too (editors swap content in place). */
	bumpOnReseed: boolean;
	/** Own save with the seed already current keeps the tab identity so
	 * memoized viewers bail out (PERF, text editor hot path). */
	keepIdentityOnReseed: boolean;
};

const SEED_SPECS: Record<SeedKind, SeedSpec> = {
	notes: {
		owns: (tab, _norm, absPath) =>
			tab.id === tabIdForPath(absPath) ||
			tab.id === tabIdForPath(notesPathForPaper(absPath)) ||
			Boolean(
				tab.notesPath &&
					normalizeTabPath(tab.notesPath) ===
						normalizeTabPath(notesPathForPaper(absPath)),
			),
		seed: "notesSeed",
		dirty: "notesDirty",
		key: "notesKey",
		bumpOnReseed: true,
		keepIdentityOnReseed: false,
	},
	markdown: {
		owns: (tab, norm) => normalizeTabPath(tab.path) === norm,
		seed: "markdownSeed",
		dirty: "markdownDirty",
		key: "seedKey",
		bumpOnReseed: true,
		keepIdentityOnReseed: false,
	},
	excalidraw: {
		owns: (tab, norm) =>
			normalizeTabPath(tab.path) === norm && tab.mode === "excalidraw",
		seed: "excalidrawSeed",
		dirty: "excalidrawDirty",
		key: "excalidrawKey",
		bumpOnReseed: false,
		keepIdentityOnReseed: false,
	},
	text: {
		owns: (tab, norm) =>
			normalizeTabPath(tab.path) === norm &&
			(tab.mode === "text" || tab.mode === "research-table"),
		seed: "textSeed",
		dirty: "textDirty",
		key: "textKey",
		bumpOnReseed: false,
		keepIdentityOnReseed: true,
	},
};

/**
 * Seed every tab of `kind` owning the path. `external` = the content came
 * from disk (own save must not remount an editor holding live state; an
 * external write must reload in place), so it forces the reload-key bump.
 */
export function seedTabs(
	prev: DocTab[],
	absPath: string,
	content: string,
	kind: SeedKind,
	external = false,
): DocTab[] {
	const spec = SEED_SPECS[kind];
	const norm = normalizeTabPath(absPath);
	const bump = external || spec.bumpOnReseed;
	return prev.map((tab) => {
		if (!spec.owns(tab, norm, absPath)) return tab;
		if (
			!bump &&
			spec.keepIdentityOnReseed &&
			tab[spec.seed] === content &&
			!tab[spec.dirty]
		) {
			return tab;
		}
		const next = { ...tab };
		next[spec.seed] = content;
		next[spec.dirty] = false;
		if (kind === "notes" || kind === "markdown") next.markdownConflict = false;
		if (bump) next[spec.key] = tab[spec.key] + 1;
		return next;
	});
}

/**
 * Refresh an open PDF / translation pane from disk. A fresh `pdfBytes`
 * identity is the viewer's reload signal (EmbedPDF re-inits on the new
 * buffer); panes the TeX compile flow owns (`texCompiling`) are skipped —
 * openTexPdf fills those itself when the run lands. Source and translation
 * panes share the registry's pdf-bytes resource.
 */
export function refreshPdfTab(
	prev: DocTab[],
	absPath: string,
	bytes: ArrayBuffer,
): DocTab[] {
	const key = normalizeTabPath(absPath);
	return prev.map((t) => {
		if (
			normalizeTabPath(t.path) === key &&
			viewerModeSpec(t.mode).resource === "pdf" &&
			!t.texCompiling
		) {
			return { ...t, pdfBytes: bytes, loaded: true };
		}
		return t;
	});
}

/**
 * Apply the banner choice for one panel. Keeping the draft only lifts the
 * hold; the editor then writes it on purpose. Loading replaces just this pane
 * with the bytes read at click time.
 */
export function applyMarkdownConflictChoice(
	prev: DocTab[],
	tabId: string,
	action: "keep" | "load" | "hold",
	disk: string,
): DocTab[] {
	let changed = false;
	const next = prev.map((tab) => {
		if (tab.id !== tabId) return tab;
		if (action === "hold") {
			if (tab.markdownConflict) return tab;
			changed = true;
			return { ...tab, markdownConflict: true };
		}
		if (action === "keep") {
			if (!tab.markdownConflict) return tab;
			changed = true;
			return { ...tab, markdownConflict: false };
		}
		const notes = tabIsPaperNotes(tab);
		const seeded = seedTabs(
			[tab],
			notes && tab.notesPath
				? tab.notesPath.replace(/[\\/]NOTES\.md$/i, "")
				: tab.path,
			disk,
			notes ? "notes" : "markdown",
			true,
		);
		const loaded = seeded[0] ?? tab;
		if (loaded !== tab) changed = true;
		return loaded;
	});
	return changed ? next : prev;
}

/** Advance the writer's seed, reload clean siblings and retain conflicted drafts. */
export function syncTabSeedsForPath(
	prev: DocTab[],
	path: string,
	content: string,
	writerId: string,
): DocTab[] {
	const norm = normalizeTabPath(path);
	return prev.map((tab) => {
		const notes = Boolean(
			tab.notesPath && normalizeTabPath(tab.notesPath) === norm,
		);
		if (!notes && normalizeTabPath(tab.path) !== norm) return tab;
		const seed = notes ? "notesSeed" : "markdownSeed";
		const dirty = notes ? tab.notesDirty : tab.markdownDirty;
		const key = notes ? "notesKey" : "seedKey";
		if (tab.mode === "markdown" && tab.id !== writerId) {
			if (tab.markdownConflict) return tab;
			if (tab[seed] === content) return tab;
			if (dirty) return { ...tab, markdownConflict: true };
			return { ...tab, [seed]: content, [key]: tab[key] + 1 };
		}
		// The writer's live state and dirty flag remain editor-owned. Paper body
		// tabs also keep the latest NOTES seed for a later companion open.
		return tab[seed] === content ? tab : { ...tab, [seed]: content };
	});
}
