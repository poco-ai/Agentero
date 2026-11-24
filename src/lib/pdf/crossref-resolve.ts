/**
 * Resolve a hyperref cross-reference destination to the layout region it points
 * at, so a hovered `\ref` link can preview the figure / table / equation /
 * algorithm crop.
 *
 * The destination carries a page + PDF-native y (origin bottom-left). Layout
 * regions are normalized top-left, so the y is converted and used to pick the
 * region of the matching kind whose vertical span contains the anchor — the
 * hyperref `\label` sits inside the merged float bbox (caption included). When
 * nothing contains it, the nearest region of that kind by vertical centre wins;
 * with no page height we fall back to the largest candidate.
 */

import { clamp01 } from "@/lib/core/math";
import type { CrossrefKind } from "@/lib/pdf/citation-dest-keys";
import {
	bboxArea,
	hoverableLayoutRegionsOnPage,
} from "@/lib/pdf/layout/hit-test";
import {
	isAlgorithmLayoutKind,
	isFigureLayoutKind,
	isFormulaLayoutKind,
	isTableLayoutKind,
} from "@/lib/pdf/layout/labels";
import type { PdfLayoutKind, PdfLayoutRegion } from "@/lib/pdf/layout/types";

/** Parsed label from a hovered link, e.g. "Figure 1" → { kind: "figure", number: 1 }. */
export type CrossrefLabel = {
	kind: CrossrefKind;
	/**
	 * Parent figure number for "Figure N—figure supplement M", or the plain
	 * float number for ordinary labels. Standalone medical/biology supplements
	 * ("Fig. S1", "Supplementary Figure 1", "S1 Fig") use `number: 0` and put
	 * the S-index in `supplement`.
	 */
	number: number;
	/**
	 * Figure supplement number for publisher-style labels such as eLife's
	 * "Figure 5—figure supplement 1" or standalone "Fig. S1". These targets
	 * are usually online-only, so a crop of the main figure would be wrong.
	 */
	supplement?: number;
};

/** Whether a layout region is a valid target for a cross-reference kind. */
export function matchesCrossrefKind(
	kind: CrossrefKind,
	layoutKind: PdfLayoutKind,
): boolean {
	switch (kind) {
		case "figure":
			return isFigureLayoutKind(layoutKind);
		case "table":
			return isTableLayoutKind(layoutKind);
		case "equation":
			return isFormulaLayoutKind(layoutKind);
		case "algorithm":
			return isAlgorithmLayoutKind(layoutKind);
		case "reference":
			return false;
	}
}

/** Vertical centre of a normalized region. */
function centreY(region: PdfLayoutRegion): number {
	return region.bbox.y + region.bbox.h / 2;
}

/**
 * Pick the layout region a cross-reference points at, or null when the target
 * page has no region of that kind.
 */
export function pickCrossrefRegion(
	regions: readonly PdfLayoutRegion[],
	pageIndex: number,
	pdfY: number,
	pageHeightPt: number | null,
	kind: CrossrefKind,
): PdfLayoutRegion | null {
	const candidates = hoverableLayoutRegionsOnPage(regions, pageIndex).filter(
		(region) => matchesCrossrefKind(kind, region.kind),
	);
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0] ?? null;

	// No page height → cannot place the anchor; prefer the largest float.
	if (!pageHeightPt || pageHeightPt <= 0) {
		return candidates.reduce((best, region) =>
			bboxArea(region.bbox) > bboxArea(best.bbox) ? region : best,
		);
	}

	const normY = clamp01(1 - pdfY / pageHeightPt);
	const containing = candidates.filter(
		(region) =>
			normY >= region.bbox.y && normY <= region.bbox.y + region.bbox.h,
	);
	const pool = containing.length > 0 ? containing : candidates;
	return pool.reduce((best, region) =>
		Math.abs(centreY(region) - normY) < Math.abs(centreY(best) - normY)
			? region
			: best,
	);
}

/**
 * "Figure 5—figure supplement 1" (eLife). Must be tested before the plain
 * figure pattern, which would otherwise label it "Figure 5".
 */
const FIGURE_SUPPLEMENT_PATTERN =
	/\b(?:Figures?|Figs?\.?)\s*(\d+)\s*(?:[—–‐‑-]\s*)?(?:Figure\s+)?Supplement\s*(\d+)/i;

/**
 * "Supplementary Figure 3" / "Supplemental Fig. 2". Must precede the plain
 * figure pattern so "Supplementary Figure 3" is not read as main Figure 3.
 */
const SUPPLEMENTARY_FIGURE_PATTERN =
	/\bSupplementa(?:ry|l)\s+(?:Figures?|Figs?\.?)\s*(\d+)/i;

/** "Fig. S1" / "Figure S2" / "Figs S3". */
const FIGURE_S_PATTERN = /\b(?:Figures?|Figs?\.?)\s*S(\d+)\b/i;

/** PLOS-style "S1 Fig" / "S2 Figure". */
const S_FIG_PATTERN = /\bS(\d+)\s*(?:Figures?|Figs?\.?)\b/i;

const CROSSREF_LABEL_PATTERNS: {
	kind: CrossrefKind;
	regex: RegExp;
}[] = [
	{ kind: "figure", regex: /\b(?:Figures?|Figs?\.?)\s*(\d+(?:[a-z])?)\b/i },
	{ kind: "table", regex: /\b(?:Table|Tbl\.?)\s*(\d+(?:[a-z])?)\b/i },
	{
		kind: "equation",
		regex: /\b(?:Equation|Eq\.?)\s*\(?(\d+(?:[a-z])?)\)?\b/i,
	},
	{ kind: "algorithm", regex: /\b(?:Algorithm|Alg\.?)\s*(\d+(?:[a-z])?)\b/i },
];

/** Parse a positive integer capture, or null when missing / non-numeric. */
function parseLabelNumber(raw: string | undefined): number | null {
	if (raw == null) return null;
	const number = Number.parseInt(raw, 10);
	return Number.isNaN(number) ? null : number;
}

/**
 * Standalone supplement label ("Fig. S1", "Supplementary Figure 1", "S1 Fig"):
 * no parent figure, S-index in `supplement`.
 */
function standaloneSupplement(supplement: number): CrossrefLabel {
	return { kind: "figure", number: 0, supplement };
}

/**
 * Extract a cross-reference label like "Figure 1" / "Table 2" / "Eq. (3)" from
 * the text surrounding a link. Returns null when the text is not a recognized
 * cross-reference label.
 */
export function extractCrossrefLabel(text: string): CrossrefLabel | null {
	const parentSupplement = FIGURE_SUPPLEMENT_PATTERN.exec(text);
	if (parentSupplement) {
		const number = parseLabelNumber(parentSupplement[1]);
		const supplementNumber = parseLabelNumber(parentSupplement[2]);
		if (number != null && supplementNumber != null) {
			return { kind: "figure", number, supplement: supplementNumber };
		}
	}

	const supplementary = SUPPLEMENTARY_FIGURE_PATTERN.exec(text);
	if (supplementary) {
		const supplementNumber = parseLabelNumber(supplementary[1]);
		if (supplementNumber != null) return standaloneSupplement(supplementNumber);
	}

	const figureS = FIGURE_S_PATTERN.exec(text);
	if (figureS) {
		const supplementNumber = parseLabelNumber(figureS[1]);
		if (supplementNumber != null) return standaloneSupplement(supplementNumber);
	}

	const sFig = S_FIG_PATTERN.exec(text);
	if (sFig) {
		const supplementNumber = parseLabelNumber(sFig[1]);
		if (supplementNumber != null) return standaloneSupplement(supplementNumber);
	}

	for (const { kind, regex } of CROSSREF_LABEL_PATTERNS) {
		const match = regex.exec(text);
		if (match) {
			const number = parseLabelNumber(match[1]);
			if (number == null) continue;
			return { kind, number };
		}
	}
	return null;
}

/** Title prefixes that identify a numbered float in the PDF text layer. */
function labelTitlePrefixes(label: CrossrefLabel): string[] {
	const { kind, number } = label;
	switch (kind) {
		case "figure":
			return [`Figure ${number}`, `Fig. ${number}`, `Fig ${number}`];
		case "table":
			return [`Table ${number}`, `Tbl. ${number}`, `Tbl ${number}`];
		case "equation":
			return [`Equation ${number}`, `Eq. ${number}`, `Eq ${number}`];
		case "algorithm":
			return [`Algorithm ${number}`, `Alg. ${number}`, `Alg ${number}`];
		case "reference":
			return [];
	}
}

/**
 * Pick the layout region for a numbered float by its label text, used as a
 * fallback when the PDF destination only resolves to a page (e.g. ACS `/FitR`
 * targets). Tries to match the region caption title first, otherwise falls back
 * to the only candidate of that kind on the page.
 */
export function pickCrossrefRegionByLabel(
	regions: readonly PdfLayoutRegion[],
	pageIndex: number,
	label: CrossrefLabel,
): PdfLayoutRegion | null {
	// Supplement targets are online-only (or a separate file). Never fall back
	// to cropping the parent / nearest main figure.
	if (label.supplement != null) return null;

	const candidates = hoverableLayoutRegionsOnPage(regions, pageIndex).filter(
		(region) => matchesCrossrefKind(label.kind, region.kind),
	);
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0] ?? null;

	const prefixes = labelTitlePrefixes(label);
	for (const prefix of prefixes) {
		const match = candidates.find((region) => {
			const title = region.title?.toLowerCase();
			return (
				title?.startsWith(prefix.toLowerCase()) &&
				!/\d/.test(title.slice(prefix.length, prefix.length + 1))
			);
		});
		if (match) return match;
	}

	// Multiple candidates and no title match. Equations rarely carry caption
	// titles, so order them top-to-bottom by normalized y and pick the N-th one.
	if (label.kind === "equation" && candidates.length >= label.number) {
		const ordered = [...candidates].sort((a, b) => a.bbox.y - b.bbox.y);
		return ordered[label.number - 1] ?? null;
	}

	// Otherwise fall back to the largest candidate.
	return candidates.reduce((best, region) =>
		bboxArea(region.bbox) > bboxArea(best.bbox) ? region : best,
	);
}
