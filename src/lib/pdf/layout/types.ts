import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";

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
	/**
	 * Normalized caption box (before union into bbox), if a title was attached.
	 * For formulas: the model `formula_number` box geometry (no text parse).
	 */
	titleBbox?: PdfAskNormalizedRect;
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

/** Reading-order region extracted as one translatable source unit. */
export type LayoutTranslateRegion = {
	id: string;
	pageIndex: number;
	bbox: PdfLayoutRegion["bbox"];
	kind: PdfLayoutRegion["kind"];
	readingOrder: number;
	/** Source PDF text (trimmed, possibly truncated for the API). */
	source: string;
};

export type LayoutTranslateItemStatus =
	| "pending"
	| "running"
	| "done"
	| "error"
	| "skipped";

export type LayoutTranslateItem = LayoutTranslateRegion & {
	status: LayoutTranslateItemStatus;
	/** Translated text when status is done (or partial). */
	translated?: string;
	error?: string;
};

export type LayoutAnalysisUiStatus =
	| { stage: "idle" }
	| {
			stage: "running";
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
