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
	/** The numeric part of the label ("Figure 1a" → 1). */
	number: number;
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

const CROSSREF_LABEL_PATTERNS: {
	kind: CrossrefKind;
	regex: RegExp;
}[] = [
	{
		kind: "figure",
		regex: /(?:\b(?:Figures?|Figs?)\.?|[图圖])\s*(\d+(?:[a-z])?)\b/i,
	},
	{
		kind: "table",
		regex: /(?:\b(?:Tables?|Tbls?)\.?|表)\s*(\d+(?:[a-z])?|[ivxlcdm]+)\b/i,
	},
	{
		kind: "equation",
		regex: /\b(?:Equations?|Eqs?)\.?\s*\(?(\d+(?:[a-z])?)\)?\b/i,
	},
	{
		kind: "algorithm",
		regex: /\b(?:Algorithms?|Algs?)\.?\s*(\d+(?:[a-z])?)\b/i,
	},
];

/**
 * Extract a cross-reference label like "Figure 1" / "Table 2" / "Eq. (3)" from
 * the text surrounding a link. Returns null when the text is not a recognized
 * cross-reference label.
 */
export function extractCrossrefLabel(text: string): CrossrefLabel | null {
	for (const { kind, regex } of CROSSREF_LABEL_PATTERNS) {
		const match = regex.exec(text);
		if (match) {
			const raw = match[1];
			let number = Number.parseInt(raw, 10);
			if (
				Number.isNaN(number) &&
				/^(?=.)M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i.test(
					raw,
				)
			) {
				const roman: Record<string, number> = {
					I: 1,
					V: 5,
					X: 10,
					L: 50,
					C: 100,
					D: 500,
					M: 1000,
				};
				const values = [...raw.toUpperCase()].map((c) => roman[c]);
				number = values.reduce(
					(sum, value, i) =>
						sum + (value < (values[i + 1] ?? 0) ? -value : value),
					0,
				);
			}
			if (Number.isNaN(number)) continue;
			return { kind, number };
		}
	}
	return null;
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
	const candidates = hoverableLayoutRegionsOnPage(regions, pageIndex).filter(
		(region) => {
			if (!matchesCrossrefKind(label.kind, region.kind)) return false;
			const caption = extractCrossrefLabel(region.title ?? "");
			return (
				!caption ||
				(caption.kind === label.kind && caption.number === label.number)
			);
		},
	);
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0] ?? null;

	const match = candidates.find((region) => {
		const caption = extractCrossrefLabel(region.title ?? "");
		return caption?.kind === label.kind && caption.number === label.number;
	});
	if (match) return match;

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
