/**
 * Public contract of the EmbedPDF viewer plus the local card/editor state
 * shapes its features pass around.
 */

import type { FormattedSelection } from "@embedpdf/plugin-selection/react";
import type { PromptImage } from "@/lib/agent/api";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import type {
	PdfAskAnchor,
	PdfAskNormalizedRect,
	PdfAskThread,
} from "@/lib/pdf/ask";
import type { EquationSymbol } from "@/lib/pdf/equation-annotation";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";

/** Imperative surface consumed through `pdf-viewer-registry`. */
export type PdfViewerHandle = {
	getHighlights: () => PdfHighlight[];
	scrollToHighlight: (id: string) => void;
	editComment: (id: string) => void;
	deleteHighlight: (id: string) => void;
	/** Jump to an ask pin and reopen its conversation card. */
	scrollToAsk: (id: string) => void;
	deleteAsk: (id: string) => void;
	/** Jump to a visual agent-trace pin and open its preview card. */
	scrollToVisualTrace: (id: string) => void;
	deleteVisualTrace: (id: string) => void;
	/** Toggle visual-region annotation mode (⌘.). */
	toggleVisualAnnotation: () => void;
	/** Run EmbedPDF layout analysis for figures / tables / formulas. */
	analyzeLayout: () => void;
	/** Jump to a layout region (0-based page) and focus its overlay. */
	scrollToLayoutRegion: (region: {
		id: string;
		pageIndex: number;
		bbox: PdfAskNormalizedRect;
	}) => void;
	/** Crop a normalized page region (for figure sidebar thumbnails). */
	renderRegion: (args: {
		pageIndex: number;
		bbox: PdfAskNormalizedRect;
		maxEdgePx?: number;
	}) => Promise<PromptImage | null>;
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
	/** Stable per-tab document id (EmbedPDF documentId + scope key). */
	docId?: string | null;
	/** Absolute path to paper folder for annotations/marks persistence */
	paperAbsPath?: string | null;
	/** Vault-relative paper path stored inside JSON */
	paperRelPath?: string | null;
	/** Current vault root for ACP cwd */
	vaultPath?: string | null;
	/** Open the annotations overview (App-level right sidebar tab). */
	onOpenAnnotations?: () => void;
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
	 * Workspace active tab. Dock may keep inactive PDFs mounted (`pdfKeepMounted`);
	 * only the active viewer should refresh marks/ (expensive base64 JSON list).
	 */
	isActive?: boolean;
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
	previewText: string;
};

export type EditorState = {
	screen: ScreenPoint;
	pageIndex: number;
	id: string;
	comment: string;
};

export type VisualDraftEditorState = {
	screen: ScreenPoint;
	page: number;
	region: PdfAskNormalizedRect;
	image: PromptImage;
	/**
	 * Opened by layout-region hover: auto-closes after leaving the region /
	 * draft card (grace period). Manual region-select drafts stay until dismiss.
	 */
	ephemeral?: boolean;
};

/** Hover card for formula regions when `{paper}/Annotation.md` has symbols. */
export type FormulaAnnotationPreviewState = {
	screen: ScreenPoint;
	regionId: string;
	page: number;
	region: PdfAskNormalizedRect;
	symbols: EquationSymbol[];
};
