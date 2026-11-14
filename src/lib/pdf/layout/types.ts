import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import type { LayoutSourceStyle } from "@/lib/pdf/layout/source-style";

/**
 * Layout kinds we may store from PP-DocLayoutV3.
 * Sidebar surfaces image/chart/table/algorithm/formula (merged with a model
 * formula_number box only); figure_title/header/formula_number/abstract/text
 * are intermediate or debug-only and never (or not primarily) listed as cards.
 */
export type PdfLayoutKind =
	| "image"
	| "table"
	| "algorithm"
	| "formula"
	| "formula_number"
	| "chart"
	| "figure_title"
	| "header"
	/** Paper abstract block — debug / full overlay only, never sidebar. */
	| "abstract"
	/** Paragraph / body text — blocker for formula merge, never sidebar. */
	| "text";

/** Minimal raw region shape shared by anchor enumeration and reading order. */
export type DocumentAnchorRegion = {
	id: string;
	pageIndex: number;
	kind: string;
	title?: string;
	text?: string;
	readingOrder?: number;
	bbox?: { x: number; y: number; w: number; h: number };
};

/**
 * One detected region after layout analysis.
 * `rect` is in PDF page points; `bbox` is normalized 0–1 (same convention as
 * selection / visual annotations).
 * `score` is model confidence 0–1 (UI may show as percent).
 * After caption merge, figure regions may include `title` from nearby
 * figure_title / caption-like header + PDF text runs.
 * Merged formulas keep `titleBbox` (the formula_number box) but do not parse
 * equation-id text into `title`.
 */
export type PdfLayoutRegion = {
	id: string;
	/** 0-based page index (EmbedPDF). */
	pageIndex: number;
	kind: PdfLayoutKind;
	/** Raw model label (e.g. `image`, `table`, `algorithm`). */
	label: string;
	/** Model confidence in [0, 1]. */
	score: number;
	readingOrder: number;
	/** PDF page coordinates in points. */
	rect: { x: number; y: number; w: number; h: number };
	/** Normalized 0–1 relative to page size. */
	bbox: PdfAskNormalizedRect;
	/**
	 * Caption / figure title text (from PDF text layer over the caption box).
	 * Formulas do not parse equation numbers into this field.
	 * Set after merge + text enrichment for figures/tables/algorithms.
	 */
	title?: string;
	/**
	 * Body / abstract / header text extracted from the PDF text layer inside
	 * this region's bbox (not used for figure-caption merge).
	 */
	text?: string;
	/** Dominant source style, preserved through cache and translation. */
	sourceStyle?: LayoutSourceStyle;
	/**
	 * Normalized caption box (before union into bbox), if a title was attached.
	 * For formulas: the model `formula_number` box geometry (no text parse).
	 */
	titleBbox?: PdfAskNormalizedRect;
	/** Caption on another page; never union these coordinates into the figure. */
	captionPageIndex?: number;
	captionBbox?: PdfAskNormalizedRect;
	/**
	 * Semantic role of a caption box (from text / geometry).
	 * Used so "Table 2: …" mislabeled as figure_title still binds to tables,
	 * and "(a) …" subpanel titles are not used as whole-figure anchors.
	 */
	captionRole?:
		| "figure_main"
		| "table_main"
		| "algorithm_main"
		| "subpanel"
		| "other";
};

export type PdfLayoutDocumentResult = {
	documentId: string;
	/** Wall time of last successful analysis. */
	updatedAt: number;
	/**
	 * Post-merge regions for the figures rail, hover targets, and product UX
	 * (caption/formula hosts after mergeCaptionsIntoHosts).
	 */
	regions: PdfLayoutRegion[];
	/**
	 * Pre-merge model detections (text-enriched when available). Used by the
	 * Figures Eye overlay for debug — every raw bbox, no sidebar filter / NMS.
	 */
	rawRegions: PdfLayoutRegion[];
	/** Per-kind counts for quick UI summary (post caption-merge). */
	counts: Record<PdfLayoutKind, number>;
};

/**
 * One English sentence and its translation inside a layout block.
 * `quote` is the text-layer slice (hyphens kept). `source` is the normalized
 * string sent to the engine. `translated` is the whole sentence. `display` is
 * the slice painted in this block when the sentence continues in another box.
 */
export type LayoutTranslateSentence = {
	quote: string;
	source: string;
	translated: string;
	display?: string;
};

/** Reading-order region extracted as one translatable source unit. */
export type LayoutTranslateRegion = {
	/** Character-level source; regenerated from the PDF, not duplicated in cache. */
	reflow?: import("@/lib/pdf/reflow/types").Paragraph;
	reflowFallback?: "protected-spans";
	/** Shared page preview rendered from the same PDF bytes used for export. */
	reflowPreview?: string;
	/** Output versions that contain this page preview. Transient renderer state. */
	reflowPreviewSources?: WeakSet<
		import("@/lib/pdf/reflow/output-version").ReflowOutputVersion
	>;
	reflowLayout?: import("@/lib/pdf/reflow/types").ParagraphLayout;
	id: string;
	pageIndex: number;
	bbox: PdfLayoutRegion["bbox"];
	kind: PdfLayoutRegion["kind"];
	readingOrder: number;
	sourceStyle?: LayoutSourceStyle;
	/** Complete normalized source; request limits apply only to transport. */
	source: string;
	/**
	 * Text-layer string before hyphen healing. Sentence quotes are cut from
	 * this. Not written to the sidecar.
	 */
	raw?: string;
};

export type LayoutTranslateItemStatus =
	| "pending"
	| "running"
	| "done"
	| "error"
	| "skipped";

export type LayoutTranslateItem = LayoutTranslateRegion & {
	status: LayoutTranslateItemStatus;
	/** Transient settled sentence share while a paragraph is still translating. */
	progress?: number;
	/** Translated text when status is done (or partial). */
	translated?: string;
	error?: string;
	/** Sentence pairs for this block. Absent when the block was not paired. */
	sentences?: LayoutTranslateSentence[];
};

export type LayoutAnalysisUiStatus =
	| { stage: "idle" }
	| {
			stage: "running";
			/** Actual model for this run; absent during cached text reconstruction. */
			backend?: import("./settings").LayoutBackend;
			message: string;
			/**
			 * Overall analysis progress 0–100 when known.
			 * Omit / null for indeterminate (pulse) stages such as model prep.
			 */
			progress?: number | null;
			/** 1-based page currently being processed (when known). */
			page?: number;
			/** Pages finished (from plugin page-complete), when known. */
			completed?: number;
			/** Document page count for the current run, when known. */
			total?: number;
	  }
	| { stage: "done"; message: string; total: number }
	| { stage: "error"; message: string }
	| { stage: "cancelled" };
