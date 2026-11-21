import type { PdfLayoutKind } from "@/lib/pdf/layout/types";

/**
 * PP-DocLayoutV3 labels → our kinds.
 * Source: `@embedpdf/ai` LAYOUT_LABELS (class ids 0–24).
 * Unmapped labels are dropped in `blockToRegion` — keep this complete for
 * the debug Eye overlay (e.g. abstract was previously discarded).
 */
const LABEL_TO_KIND: Record<string, PdfLayoutKind> = {
	image: "image",
	chart: "chart",
	table: "table",
	algorithm: "algorithm",
	formula: "formula",
	formula_number: "formula_number",
	figure_title: "figure_title",
	header: "header",
	/** Class 0 — paper abstract. */
	abstract: "abstract",
	// Body / secondary text blocks.
	text: "text",
	aside_text: "text",
	content: "text",
	footer: "text",
	footnote: "text",
	number: "text",
	reference: "text",
	reference_content: "text",
	seal: "text",
	vision_footnote: "text",
	// Titles that are not figure captions.
	doc_title: "header",
	paragraph_title: "header",
};

export function layoutLabelToKind(label: string): PdfLayoutKind | null {
	const key = label.trim().toLowerCase();
	return LABEL_TO_KIND[key] ?? null;
}

/** Sidebar “Figures” section: image + chart (same gallery group). */
export function isFigureLayoutKind(kind: PdfLayoutKind): boolean {
	return kind === "image" || kind === "chart";
}

/** Sidebar “Tables” section. */
export function isTableLayoutKind(kind: PdfLayoutKind): boolean {
	return kind === "table";
}

/** Sidebar “Algorithms” section. */
export function isAlgorithmLayoutKind(kind: PdfLayoutKind): boolean {
	return kind === "algorithm";
}

/** Sidebar “Formulas” section (numbered only after merge). */
export function isFormulaLayoutKind(kind: PdfLayoutKind): boolean {
	return kind === "formula";
}

/** Equation number boxes (e.g. "(1)") — merged into formula hosts, not listed alone. */
export function isFormulaNumberLayoutKind(kind: PdfLayoutKind): boolean {
	return kind === "formula_number";
}

/** Body / aside text blocks. */
export function isTextLayoutKind(kind: PdfLayoutKind): boolean {
	return kind === "text";
}

/**
 * Text-like layout elements: the selection quote is `region.text`
 * (body, abstract, header, figure/table caption). Figures, tables,
 * algorithms and formulas stay whole-element crops.
 */
export function isLayoutElementTextKind(kind: PdfLayoutKind): boolean {
	return (
		kind === "text" ||
		kind === "abstract" ||
		kind === "header" ||
		kind === "figure_title"
	);
}

/**
 * Regions drawn as a crop: figures, charts, tables, algorithms and formulas.
 * Text runs the model found inside one of these belong to the graphic itself,
 * not to the prose, so they never become hover sentences.
 */
export function isLayoutVisualKind(kind: PdfLayoutKind): boolean {
	return (
		kind === "image" ||
		kind === "chart" ||
		kind === "table" ||
		kind === "algorithm" ||
		kind === "formula" ||
		kind === "formula_number"
	);
}

/**
 * Regions whose PDF text layer we extract for body / abstract / headers.
 * Algorithms are never bulk-translated (see listTranslatableLayoutRegions).
 */
export function isLayoutBodyTextKind(kind: PdfLayoutKind): boolean {
	return kind === "text" || kind === "abstract" || kind === "header";
}

/**
 * Kinds eligible for bulk layout translation:
 * body text, abstract, section headers, figure/table captions.
 */
export function isLayoutTranslatableKind(kind: PdfLayoutKind): boolean {
	return isLayoutBodyTextKind(kind) || kind === "figure_title";
}

/** Section / paper titles shown bold in the layout-translate overlay. */
export function isLayoutTranslateHeadingKind(kind: PdfLayoutKind): boolean {
	return kind === "header";
}

/** Caption candidates merged into nearby figures/tables, not listed alone. */
export function isCaptionLayoutKind(kind: PdfLayoutKind): boolean {
	return kind === "figure_title" || kind === "header";
}

/**
 * Kinds shown in the Figures right-rail after merge.
 * image + chart share one section; table / algorithm / formula are separate.
 * Bare formula_number / captions are never sidebar kinds.
 */
export function isSidebarLayoutKind(
	kind: PdfLayoutKind,
): kind is "image" | "chart" | "table" | "algorithm" | "formula" {
	return (
		isFigureLayoutKind(kind) ||
		isTableLayoutKind(kind) ||
		isAlgorithmLayoutKind(kind) ||
		isFormulaLayoutKind(kind)
	);
}

/** i18n key under `viewer` namespace for overlay / UI kind labels. */
export type LayoutKindI18nKey =
	| "figures.kindImage"
	| "figures.kindChart"
	| "figures.kindTable"
	| "figures.kindAlgorithm"
	| "figures.kindFormula"
	| "figures.kindFormulaNumber"
	| "figures.kindFigureTitle"
	| "figures.kindHeader"
	| "figures.kindAbstract"
	| "figures.kindText";

export function layoutKindI18nKey(kind: PdfLayoutKind): LayoutKindI18nKey {
	switch (kind) {
		case "image":
			return "figures.kindImage";
		case "chart":
			return "figures.kindChart";
		case "table":
			return "figures.kindTable";
		case "algorithm":
			return "figures.kindAlgorithm";
		case "formula":
			return "figures.kindFormula";
		case "formula_number":
			return "figures.kindFormulaNumber";
		case "figure_title":
			return "figures.kindFigureTitle";
		case "header":
			return "figures.kindHeader";
		case "abstract":
			return "figures.kindAbstract";
		case "text":
			return "figures.kindText";
	}
}

/**
 * NMS group key: image and chart compete as one “figure” class so
 * overlapping image/chart boxes do not both appear.
 */
export function layoutDedupeGroup(kind: PdfLayoutKind): string {
	if (isFigureLayoutKind(kind)) return "figure";
	return kind;
}
