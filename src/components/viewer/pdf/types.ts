/**
 * Public contract of the EmbedPDF viewer plus the local card/editor state
 * shapes its features pass around.
 */

import type { FormattedSelection } from "@embedpdf/plugin-selection/react";
import type { RefObject } from "react";
import type { PromptImage } from "@/lib/agent/api";
import type { SelectionSide } from "@/lib/agent/selection-side";
import type { PaperMetadata } from "@/lib/paper";
import type { Citation } from "@/lib/paper/refs";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import type {
	PdfAskAnchor,
	PdfAskNormalizedRect,
	PdfAskThread,
} from "@/lib/pdf/ask";
import type { CrossrefKind } from "@/lib/pdf/citation-dest-keys";
import type { HighlightColor } from "@/lib/pdf/highlight/palette";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";
import type { VisibleSelectionPage } from "@/lib/pdf/layout/visible-selection-rects";
import type { BracketCitation } from "@/lib/pdf/link-text";
import type { PdfNavigationTarget } from "@/lib/pdf/pending-pdf-page";
import type { PdfReloadPosition } from "@/lib/pdf/reload-position";
import type { PdfViewerHandle } from "@/lib/workspace/viewer/pdf-viewer-registry";

export type { PdfViewerHandle };

/** Normalized rectangle emitted by the jEV smart-highlight job. */
type SuggestedHighlightRect = {
	x: number | null;
	y: number | null;
	w: number | null;
	h: number | null;
};

/** Job result payload for `jevSmartHighlights` (not an IPC command type). */
export type SuggestedHighlight = {
	quote: string;
	page: number;
	rects: SuggestedHighlightRect[];
	color: string;
	category: string;
	score: number | null;
	pageWidth: number | null;
	pageHeight: number | null;
};

export type PdfViewerProps = {
	/**
	 * PDF source: local `blob:` (bytes via fs) or remote https. Prefer local
	 * vault PDF; remote URL is fallback when download fails.
	 */
	source: string | null;
	/**
	 * Local PDF bytes. Preferred over `source`: the engine opens the document
	 * straight from the buffer, avoiding a `fetch(blob:)` that stalls/fails in
	 * some webviews (Windows WebView2). `source` is the fallback (remote https).
	 */
	sourceBytes?: ArrayBuffer | null;
	/**
	 * Base per-tab document id (EmbedPDF scope key). Buffer-backed sources get
	 * a per-read revision suffix inside the viewer so a reloaded PDF registers
	 * under a fresh PDFium document.
	 */
	docId?: string | null;
	/** Embed-local citation: navigate once after layout and keep its raw bbox highlighted. */
	embeddedTarget?: PdfNavigationTarget | null;
	/** Increment to return to the same embed target without reopening the PDF. */
	embeddedTargetRequest?: number;
	/** Reserve space beside the page for comment cards (off in note embeds). */
	reserveCommentRail?: boolean;
	/** Note embeds keep their own scroll position instead of changing the paper's last-read page. */
	rememberReadingPosition?: boolean;
	/** Absolute path to paper folder for annotations/marks persistence */
	paperAbsPath?: string | null;
	/** Vault-relative paper path stored inside JSON */
	paperRelPath?: string | null;
	/** Current vault root for ACP cwd */
	vaultPath?: string | null;
	/** Paper metadata when already resolved by the workspace tab (remote papers). */
	paperMeta?: PaperMetadata | null;
	/** Open Translate settings from a translation error card. */
	onOpenSettings?: () => void;
	className?: string;
	/** Register/unregister an imperative handle for the annotations panel */
	onHandle?: (handle: PdfViewerHandle | null) => void;
	/** Called whenever the highlight list changes (for the annotations panel) */
	onHighlightsChange?: (highlights: PdfHighlight[]) => void;
	/** Called whenever PDF ask threads change (for the annotations panel) */
	onAsksChange?: (threads: PdfAskThread[]) => void;
	/** Called whenever visual agent-trace marks change (for the annotations panel) */
	onVisualTracesChange?: (traces: PdfVisualSessionTrace[]) => void;
	/**
	 * Open a rendered-translation workspace tab split to the right.
	 * Used when Settings → Translate → dualPaneTranslate is enabled.
	 */
	onOpenTranslationTab?: (
		paperTabId: string,
		paperAbsPath: string | null,
		paperTitle?: string | null,
	) => void;
	/**
	 * Workspace active tab. Dock may keep inactive PDFs mounted (`keepMounted`);
	 * only the active viewer should refresh marks/ (expensive base64 JSON list).
	 */
	isActive?: boolean;
	/**
	 * When true, this viewer is the right-hand translation pane of a dual-pane
	 * layout. It always paints layout-translate overlays and never hides them
	 * behind the dual-pane setting.
	 */
	translationPane?: boolean;
	/** Render the PDF page and translation overlay without reader chrome. */
	translationOnly?: boolean;
	/** Inline comparison: mirror this source and hydrate cache without auto-starting translation. */
	translationSourceDocId?: string;
	/**
	 * True for remote papers (e.g. arXiv Daily preview) that have no local
	 * sidecar. Hides mark-persisting UI (highlight / note / translate); Ask /
	 * Add-to-chat stay available as ephemeral session actions. Offers import.
	 */
	isRemotePaper?: boolean;
	/**
	 * True for PDFs outside `papers/` (e.g. a compiled plans/a.pdf). Renders a
	 * plain viewer: layout analysis, visual annotation, full-text translation,
	 * the selection toolbar, and annotations are all hidden; basic reading
	 * (pages, zoom, search, text selection + copy) stays.
	 */
	plainViewer?: boolean;
	/**
	 * Keep the floating page / zoom / paper-tone bar in a plain viewer. The
	 * writing preview opts in so its PDF chrome matches the reading layout.
	 */
	showBottomBar?: boolean;
	/** Canonical TeX source and actual output path for compiled-document SyncTeX. */
	texRootPath?: string | null;
	pdfPath?: string | null;
	/** Keep forward search on the writing preview instead of a reading tab. */
	syncTexScope?: "writing";
	cloudSyncBackward?: (
		page: number,
		x: number,
		y: number,
	) => Promise<{ path: string; line: number; column: number } | null>;
	/**
	 * Identifier used by the "Import to library" action for remote papers.
	 * Usually the arXiv abs/source URL.
	 */
	importIdentifier?: string;
};

export type PdfViewerInnerProps = PdfViewerProps & {
	docId: string;
	/**
	 * Original bytes before the private copy passed to EmbedPDF. Cache keying
	 * must not depend on a buffer the PDF engine may have transferred.
	 */
	pdfCacheBytes?: ArrayBuffer | null;
	/**
	 * Revision-stripped document id (the tab id / stable scope key). Cross-pane
	 * callers — e.g. `onOpenTranslationTab`, which resolves it back to a
	 * workspace tab — need this form, not the per-buffer `docId`.
	 */
	baseDocId: string;
	/** Survives the inner EmbedPDF remount when the compiled buffer changes. */
	reloadPositionRef?: RefObject<PdfReloadPosition | null>;
};

/** Viewport-space point (client px) used by every floating overlay. */
export type ScreenPoint = {
	x: number;
	y: number;
	top?: number;
	bottom?: number;
	/** Side of the selection where the gesture ended; drives menu placement. */
	side?: SelectionSide;
	/** Viewport x of the gesture endpoint; the menu centers on this point. */
	cursorX?: number;
};

/** Floating anchor plus the exact reference under the pointer. The original
 * annotation remains intact for navigation and named-destination lookup. */
export type PdfLinkHoverPoint = ScreenPoint & {
	citation?: BracketCitation;
	sourcePoint?: { x: number; y: number };
};

/** Screen anchor for a floating card, including which side to open on. */
export type CardScreenPoint = ScreenPoint & {
	preferRight?: boolean;
	/**
	 * Inset from the window edges that page-anchored cards are clipped to, so
	 * a card scrolling with the page never paints over the app chrome.
	 */
	clipInset?: {
		top: number;
		right: number;
		bottom: number;
		left: number;
	};
	selectionBounds?: {
		left: number;
		top: number;
		right: number;
		bottom: number;
	};
};

export type SelectionMenuState = {
	/** Top-center of the selection — floating toolbar anchor. */
	screen: ScreenPoint;
	/** Page-local x fraction of the gesture endpoint; re-mapped on scroll/zoom. */
	cursorXFraction?: number;
	anchor: PdfAskAnchor;
	/** Original PDF geometry. Empty when a translated quote could not be located. */
	pages: FormattedSelection[];
	/**
	 * Visible text to put on the clipboard. Set when the selection is on a
	 * translation span, so copy does not replace it with the English quote.
	 */
	copyText?: string;
	/** The anchor quote is English recovered from the translation selection. */
	fromTranslation?: boolean;
	/** Native reader selection; screen placement is independent of PDF page layout. */
	fromReader?: { blockId: string };
	/** Sentence translations passed to chat as context, not stored on the mark. */
	pairedTranslation?: string;
	/**
	 * Translation the reader selected, in page fractions. The toolbar tracks
	 * these. `pages` stays the English glyph boxes stored on the annotation.
	 */
	visiblePages?: VisibleSelectionPage[];
};

/**
 * Right-rail editor opened from the selection toolbar. Commit uses snapped
 * `pages` even if focusing the editor cleared the live selection.
 */
export type SelectionCommentDraft = {
	readerBlockId?: string;
	/** 1-based page number (matches `commentsByPage` keys). */
	page: number;
	/** Normalized Y of the selection top (0–1). */
	anchorY: number;
	quote: string;
	/** EmbedPDF selection pages snapped when the editor was opened. */
	pages: FormattedSelection[];
	/**
	 * Translation boxes to keep painted while the editor is open. Omitted for an
	 * English text-layer selection, which EmbedPDF already tints.
	 */
	visiblePages?: VisibleSelectionPage[];
};

export type CitationPreviewState = {
	screen: ScreenPoint;
	/**
	 * Sidecar citation(s) the hovered link points at. A single hyperref hit is
	 * a one-element list; ACS ranges like `14-18` expand to every index in the
	 * range (plus any comma-separated neighbours in the same superscript group).
	 */
	matched: Citation[];
};

/**
 * Hover card for a `\ref` cross-reference link: a crop of the figure / table /
 * equation / algorithm the link points at, resolved through the hyperref
 * cross-reference destination map plus layout regions. `image` is null while
 * the region crop renders.
 */
export type CrossrefPreviewState = {
	screen: ScreenPoint;
	kind: CrossrefKind;
	/** 1-based destination page (display only). */
	page: number;
	/** Normalized bbox of the resolved layout region on the destination page. */
	region: PdfAskNormalizedRect;
	/** Full target page for floats; a bibliography crop for references. */
	image: PromptImage | null;
	/** 1:1 on-screen display size in CSS pixels matching the document's zoom. */
	targetSize?: { width: number; height: number };
	/** Separate bibliography entry crops, ordered by reference number. */
	referenceEntries?: number[];
	missingReferences?: number[];
	referenceImages?: {
		id: string;
		image: PromptImage;
		width: number;
		height: number;
	}[];
	/** Point within the rendered image to reveal initially (normalized top-left). */
	focusPoint?: { x: number; y: number };
};

export type VisualDraftEditorState = {
	screen: ScreenPoint;
	page: number;
	region: PdfAskNormalizedRect;
	image: PromptImage;
};

/** Discriminator for a right-rail comment card. */
export type CommentRailKind = "highlight" | "visual";

/** One turn from a visual mark's inline Agent conversation preview. */
export type PageAnnotationCommentMessage = {
	id: string;
	role: "user" | "assistant";
	content: string;
};

/** Persistent comment-rail card for one annotated highlight or visual note. */
export type PageAnnotationComment = {
	id: string;
	/** 0-based EmbedPDF page index (save / delete). */
	pageIndex: number;
	/** Normalized Y anchor on the page (0-1) used for initial placement. */
	anchorY: number;
	/** Normalized rects covering the highlighted text / visual region. */
	rects: PdfAskNormalizedRect[];
	/**
	 * Translated selection, when the note was made on the overlay. The page
	 * uses these instead of `rects` while that translation is showing.
	 */
	translatedRects?: PdfAskNormalizedRect[];
	quote: string;
	comment: string;
	color: HighlightColor;
	kind: CommentRailKind;
	/** Pre-computed `[[alias|target]]` or null if no wiki target. */
	linkAlias: string | null;
	/** Visual marks with an Agent conversation show a truncated inline preview. */
	messages?: PageAnnotationCommentMessage[];
	/**
	 * True when this card represents a freshly-created note that has not been
	 * saved yet. If the editor closes without a non-empty comment, the underlying
	 * mark is removed instead of leaving an empty highlight (#491).
	 */
	isNew?: boolean;
};

/**
 * In-place comment-rail edit (Notion-style). All highlight / visual notes edit
 * here; there is no floating note editor fallback.
 */
export type RailEditState = {
	id: string;
	pageIndex: number;
	kind: CommentRailKind;
	comment: string;
	quote: string;
	color: HighlightColor;
	anchorY: number;
	/** Normalized rects covering the highlighted text / visual region. */
	rects: PdfAskNormalizedRect[];
	/**
	 * True when the editor was opened for a freshly-created note. Closing or
	 * saving an empty new note deletes the underlying mark (#491).
	 */
	isNew?: boolean;
};
