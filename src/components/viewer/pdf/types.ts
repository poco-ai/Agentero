/**
 * Public contract of the EmbedPDF viewer plus the local card/editor state
 * shapes its features pass around.
 */

import type { FormattedSelection } from "@embedpdf/plugin-selection/react";
import type { PromptImage } from "@/lib/agent/api";
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
import type { PdfViewerHandle } from "@/lib/workspace/viewer/pdf-viewer-registry";

export type { PdfViewerHandle };

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
	/** Stable per-tab document id (EmbedPDF documentId + scope key). */
	docId?: string | null;
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
	 * True for remote papers (e.g. arXiv Daily preview) that have no local
	 * sidecar. Hides mark-persisting UI (highlight / note / translate); Ask /
	 * Add-to-chat stay available as ephemeral session actions. Offers import.
	 */
	isRemotePaper?: boolean;
	/**
	 * Identifier used by the "Import to library" action for remote papers.
	 * Usually the arXiv abs/source URL.
	 */
	importIdentifier?: string;
};

export type PdfViewerInnerProps = PdfViewerProps & { docId: string };

/** Viewport-space point (client px) used by every floating overlay. */
export type ScreenPoint = {
	x: number;
	y: number;
};

/** Screen anchor for a floating card, including which side to open on. */
export type CardScreenPoint = ScreenPoint & {
	preferRight?: boolean;
};

export type SelectionMenuState = {
	screen: ScreenPoint;
	anchor: PdfAskAnchor;
	pages: FormattedSelection[];
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
	/** Rendered region crop; null while in flight. */
	image: PromptImage | null;
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
	quote: string;
	comment: string;
	color: HighlightColor;
	kind: CommentRailKind;
	/** Pre-computed `[[alias|target]]` or null if no wiki target. */
	linkAlias: string | null;
	/** Visual marks with an Agent conversation show a truncated inline preview. */
	messages?: PageAnnotationCommentMessage[];
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
};
