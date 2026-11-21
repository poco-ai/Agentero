import type { PaperMetadata } from "@/lib/paper";
import type { LinkFragment } from "@/lib/wiki";
import type { CenterViewMode } from "@/lib/workspace/viewer";

export type DocTabKind =
	| "library"
	| "trash"
	| "plaza"
	| "zen"
	| "paper"
	| "file";

/** Extra view of a path. Absent means the canonical view. Not a filesystem path. */
export type TabPaneKind = "split" | "translation";

/**
 * One open document panel in the center Dockview workspace.
 * All open documents are peers — layout/split is owned by dockview, not by nesting.
 */
export type DocTab = {
	/**
	 * Opaque view id (`view-…`) for file and paper panels. Library, Trash, Zen,
	 * and Plaza keep their virtual path ids. Restored layouts keep their old
	 * path-shaped ids instead of rewriting them.
	 */
	id: string;
	/** Split copy or translation companion. Absent on the canonical view. */
	pane?: TabPaneKind;
	/** Absolute path, or a virtual path (Library / Recycle Bin / Plaza). */
	path: string;
	kind: DocTabKind;
	title: string;
	/** View mode for this panel (set at open; no in-pane PDF/HTML toggle). */
	mode: CenterViewMode;
	paperMeta: PaperMetadata | null;
	pdfUrl: string | null;
	/** Local PDF bytes fed straight to the engine (avoids fragile `blob:` fetch). */
	pdfBytes: ArrayBuffer | null;
	htmlUrl: string | null;
	/**
	 * Absolute `webpage.html` offline snapshot beside the paper's NOTES.md.
	 * Probed on open, never persisted: restored tabs re-probe on hydrate.
	 */
	htmlArchivePath: string | null;
	/** Local image preview (`blob:`) when mode is image. */
	imageUrl: string | null;
	notesPath: string | null;
	/** Seed content for the NOTES editor (live content lives inside the editor). */
	notesSeed: string;
	/** Seed content for a plain-file Markdown editor. */
	markdownSeed: string;
	/** Seed content for the plain-text (CodeMirror) editor. */
	textSeed: string;
	markdownDirty: boolean;
	notesDirty: boolean;
	/** A sibling Markdown editor saved over this panel's baseline; retain its draft. */
	markdownConflict?: boolean;
	textDirty: boolean;
	/** Bump to reload the center Markdown editor's content in place from `markdownSeed`. */
	seedKey: number;
	/** Bump to reload the plain-text editor's content in place from `textSeed`. */
	textKey: number;
	/**
	 * Bumped when this panel's edited file is replaced in place (writing project
	 * source swap) so the plain-text CodeMirror editor remounts instead of
	 * swapping documents. Renames and disk reloads keep the instance.
	 */
	textEpoch: number;
	/** Bump to reload a local HTML preview after the file changes on disk. */
	htmlKey: number;
	/** Bump to reload the NOTES editor's content in place from `notesSeed`. */
	notesKey: number;
	/** One-shot, monotonic intent consumed by the mounted Markdown editor. */
	navigationIntent?: { id: number; fragment: LinkFragment };
	/** Transient: compiled-PDF pane is waiting on a running LaTeX compile. */
	texCompiling?: boolean;
	/** Render the rtex live canvas instead of the compiled PDF (PDF tab only). */
	texLive?: boolean;
	/** Project root .tex for compiled PDFs and live previews, including custom outputs. */
	texRoot?: string;
	/** Owning writing project for source files and project assets. */
	writingRoot?: string;
	/** A failed NOTES read must not mount an editor with an empty baseline. */
	loadError?: string;
	loaded: boolean;
};

/**
 * Dockview placement direction.
 * - left/right/above/below → new group (split)
 * - within → same group as a sibling tab
 */
export type SplitDirection = "left" | "right" | "above" | "below" | "within";

/**
 * How a newly opened panel should be placed in dockview.
 * `null` = let dockview activate existing / add to active group (default open).
 */
export type OpenPlacement = {
	direction: SplitDirection;
	/** Existing panel id to place relative to; null = active panel. */
	referencePanelId: string | null;
} | null;

/**
 * Anchors of the standard two-column reading layout. While dockview shows
 * exactly two side-by-side columns, new paper bodies join the left column and
 * their NOTES companions join the right one, regardless of focus.
 */
export type ReadingColumns = {
	leftAnchorId: string;
	rightAnchorId: string;
};

/** Fields loadTabResources fills in on top of a placeholder tab. */
export type TabResources = {
	kind: DocTabKind;
	title: string;
	mode: CenterViewMode;
	paperMeta: PaperMetadata | null;
	pdfUrl: string | null;
	pdfBytes?: ArrayBuffer | null;
	htmlUrl: string | null;
	/** Offline webpage snapshot (`<paperDir>/webpage.html`), when one exists. */
	htmlArchivePath?: string | null;
	imageUrl: string | null;
	notesPath: string | null;
	notesSeed: string;
	markdownSeed: string;
	textSeed?: string;
	loaded: true;
	/** Non-fatal message to surface (e.g. unpreviewable file). */
	error?: string;
	/** True when this load triggered a `DownloadAssets` job (tree may need refresh). */
	didDownloadAssets?: boolean;
};

export type PersistedTab = {
	id?: string;
	path: string;
	mode: CenterViewMode;
	/** Split or translation companion. Absent on the canonical view. */
	pane?: TabPaneKind;
	/** Last resolved display title (paper metadata title); shown before hydration. */
	title?: string;
	/** rtex live pane; persists across window reloads instead of reverting to PDF. */
	texLive?: boolean;
	texRoot?: string;
	/** Owning writing project for source files and project assets. */
	writingRoot?: string;
};

/**
 * Restored session: panel list + active id derived from dockview layout
 * (params carry path/mode; grid carries active group/view).
 */
export type PersistedTabs = {
	tabs: PersistedTab[];
	activeId: string | null;
	/** Global dockview grid snapshot (panel ids are view ids, not file paths). */
	layout: unknown | null;
};

/** Params written into each dockview panel for layout round-trip. */
export type PanelPersistParams = {
	panelId: string;
	path: string;
	mode: CenterViewMode;
	/** Display title at save time; restore shows it before resources hydrate. */
	title: string;
	/** Live TeX pane state; only set while live. The source association persists in either mode. */
	texLive?: boolean;
	texRoot?: string;
	/** Owning writing project for source files and project assets. */
	writingRoot?: string;
	/** Split or translation companion. Never written into `path`. */
	pane?: TabPaneKind;
};

export const NOTES_PLACEHOLDER =
	"# Notes\n\nNo NOTES.md found for this paper.\n";
