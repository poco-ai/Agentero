import { LAYOUT_SIDEBAR_MIN_SCORE } from "@/lib/pdf/layout/constants";
import {
	isAlgorithmLayoutKind,
	isLayoutTranslatableKind,
} from "@/lib/pdf/layout/labels";
import { normalizeLayoutSourceText } from "@/lib/pdf/layout/layout-translate-source";
import { bboxCoveredBy } from "@/lib/pdf/layout/merge-captions";
import { preservedLayoutRegions } from "@/lib/pdf/layout/translation-exclusions";
import type {
	LayoutTranslateRegion,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";

/** Prefer body extract; fall back to caption title for headers. */
export function layoutRegionSourceText(region: PdfLayoutRegion): string {
	return (region.text ?? region.title ?? "").replace(/\s+/g, " ").trim();
}

/** True when most of `region` sits inside an algorithm detection box. */
export function isInsideAlgorithmRegion(
	region: PdfLayoutRegion,
	algorithms: readonly PdfLayoutRegion[],
	coverage = 0.45,
): boolean {
	for (const alg of algorithms) {
		if (alg.pageIndex !== region.pageIndex) continue;
		if (bboxCoveredBy(region.bbox, alg.bbox) >= coverage) return true;
	}
	return false;
}

/** "Algorithm 1" / "Alg. 2" style titles — keep original, do not translate. */
export function isAlgorithmTitleText(text: string): boolean {
	const t = text.trim();
	if (!t) return false;
	return /^(algorithm|alg\.?)\s*\d/i.test(t);
}

/** PP-DocLayoutV3 side-margin text (`aside_text` → kind text; keep raw label). */
export function isAsideTextLayoutLabel(label: string): boolean {
	return label.trim().toLowerCase() === "aside_text";
}

/**
 * Reading-order list of regions with extractable source text
 * (body, abstract, headers, figure/table captions).
 * Skips algorithm, aside_text, and bibliography regions and headings.
 */
export function listTranslatableLayoutRegions(
	regions: readonly PdfLayoutRegion[],
	minScore: number = LAYOUT_SIDEBAR_MIN_SCORE,
): LayoutTranslateRegion[] {
	const algorithms = regions.filter(
		(r) => isAlgorithmLayoutKind(r.kind) && r.score >= minScore,
	);
	const preserved = preservedLayoutRegions(regions, minScore);
	const out: LayoutTranslateRegion[] = [];
	for (const r of regions) {
		if (preserved.has(r.id)) continue;
		if (isAlgorithmLayoutKind(r.kind)) continue;
		if (isAsideTextLayoutLabel(r.label)) continue;
		if (!isLayoutTranslatableKind(r.kind)) continue;
		if (!(r.score >= minScore)) continue;
		if (!(r.bbox.w > 0 && r.bbox.h > 0)) continue;
		if (isInsideAlgorithmRegion(r, algorithms)) continue;
		const raw = layoutRegionSourceText(r);
		const full = normalizeLayoutSourceText(raw, r.kind);
		if (!full) continue;
		if (isAlgorithmTitleText(full)) continue;
		out.push({
			id: r.id,
			pageIndex: r.pageIndex,
			bbox: r.bbox,
			kind: r.kind,
			readingOrder: r.readingOrder,
			source: full,
			raw,
			...(r.sourceStyle ? { sourceStyle: r.sourceStyle } : {}),
		});
	}
	out.sort(
		(a, b) =>
			a.pageIndex - b.pageIndex ||
			a.readingOrder - b.readingOrder ||
			a.bbox.y - b.bbox.y ||
			a.bbox.x - b.bbox.x,
	);
	return out;
}
