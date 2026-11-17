import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import {
	LAYOUT_SELECT_MIN_AREA,
	LAYOUT_SIDEBAR_MIN_SCORE,
} from "@/lib/pdf/layout/constants";
import { dedupeLayoutRegions } from "@/lib/pdf/layout/dedupe";
import { layoutElementBoxes } from "@/lib/pdf/layout/element-selection";
import { isSidebarLayoutKind } from "@/lib/pdf/layout/labels";
import { suppressSpuriousFigureDetections } from "@/lib/pdf/layout/merge-captions";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

export function bboxArea(bbox: PdfLayoutRegion["bbox"]): number {
	return Math.max(0, bbox.w) * Math.max(0, bbox.h);
}

/**
 * Same region set as the figures rail: sidebar kinds, min-score + NMS dedupe.
 */
export function hoverableLayoutRegions(
	regions: readonly PdfLayoutRegion[],
	minScore: number = LAYOUT_SIDEBAR_MIN_SCORE,
): PdfLayoutRegion[] {
	const sidebarOnly = regions.filter((r) => isSidebarLayoutKind(r.kind));
	return dedupeLayoutRegions(sidebarOnly, { minScore });
}

function groupByPage(
	regions: readonly PdfLayoutRegion[],
): Map<number, PdfLayoutRegion[]> {
	const byPage = new Map<number, PdfLayoutRegion[]>();
	for (const region of regions) {
		const page = byPage.get(region.pageIndex);
		if (page) page.push(region);
		else byPage.set(region.pageIndex, [region]);
	}
	return byPage;
}

function sortLargestFirst(regions: PdfLayoutRegion[]): PdfLayoutRegion[] {
	return regions.sort((a, b) => bboxArea(b.bbox) - bboxArea(a.bbox));
}

/**
 * Hoverable regions bucketed by page, largest first (paint order: smaller boxes
 * later so they win hits). NMS runs once for the whole document — callers that
 * render many pages must reuse one map instead of deduping per page.
 */
export function hoverableLayoutRegionsByPage(
	regions: readonly PdfLayoutRegion[],
	minScore: number = LAYOUT_SIDEBAR_MIN_SCORE,
): Map<number, PdfLayoutRegion[]> {
	const byPage = groupByPage(hoverableLayoutRegions(regions, minScore));
	for (const page of byPage.values()) sortLargestFirst(page);
	return byPage;
}

/** Regions for one page, largest first. */
export function hoverableLayoutRegionsOnPage(
	regions: readonly PdfLayoutRegion[],
	pageIndex: number,
	minScore: number = LAYOUT_SIDEBAR_MIN_SCORE,
): PdfLayoutRegion[] {
	return hoverableLayoutRegionsByPage(regions, minScore).get(pageIndex) ?? [];
}

/**
 * Debug overlay: pre-merge detections bucketed by page (all kinds, no NMS).
 * Drops boxes below minScore (default 0.3). Largest first so smaller paint on top.
 * Also drops image/chart that are really text/header dual-labels.
 */
export function rawLayoutRegionsByPage(
	regions: readonly PdfLayoutRegion[],
	minScore: number = LAYOUT_SIDEBAR_MIN_SCORE,
): Map<number, PdfLayoutRegion[]> {
	const byPage = groupByPage(
		regions.filter((r) => r.bbox.w > 0 && r.bbox.h > 0 && r.score >= minScore),
	);
	// Suppress needs full-page body blocks at minScore; pass page slice only
	// (body blocks below minScore already excluded — matches Eye gate).
	for (const [pageIndex, page] of byPage) {
		byPage.set(
			pageIndex,
			sortLargestFirst(suppressSpuriousFigureDetections(page)),
		);
	}
	return byPage;
}

export function pointInBbox(
	x: number,
	y: number,
	bbox: PdfLayoutRegion["bbox"],
): boolean {
	return (
		x >= bbox.x && y >= bbox.y && x <= bbox.x + bbox.w && y <= bbox.y + bbox.h
	);
}

/**
 * Pick the best region under a normalized page point.
 * Prefers the smallest-area hit (most specific); ties break by higher score.
 */
export function pickLayoutRegionAtPoint(
	regions: readonly PdfLayoutRegion[],
	pageIndex: number,
	x: number,
	y: number,
	minScore: number = LAYOUT_SIDEBAR_MIN_SCORE,
): PdfLayoutRegion | null {
	const hits = hoverableLayoutRegions(regions, minScore).filter(
		(r) => r.pageIndex === pageIndex && pointInBbox(x, y, r.bbox),
	);
	if (hits.length === 0) return null;
	hits.sort((a, b) => {
		const areaDiff = bboxArea(a.bbox) - bboxArea(b.bbox);
		if (Math.abs(areaDiff) > 1e-12) return areaDiff;
		return b.score - a.score;
	});
	return hits[0] ?? null;
}

export function rectsIntersect(
	a: PdfAskNormalizedRect,
	b: PdfAskNormalizedRect,
): boolean {
	return (
		a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
	);
}

/**
 * Post-merge regions the element selection view can hit: every kind, not
 * only the figures rail. NMS runs once for the document. Small headers stay;
 * speck boxes drop.
 */
export function selectableLayoutRegions(
	regions: readonly PdfLayoutRegion[],
	minScore: number = LAYOUT_SIDEBAR_MIN_SCORE,
): PdfLayoutRegion[] {
	return dedupeLayoutRegions(
		regions.filter((region) => region.bbox.w > 0 && region.bbox.h > 0),
		{ minScore, minArea: LAYOUT_SELECT_MIN_AREA },
	);
}

/** Selectable regions bucketed by page, largest first. */
export function selectableLayoutRegionsByPage(
	regions: readonly PdfLayoutRegion[],
	minScore: number = LAYOUT_SIDEBAR_MIN_SCORE,
): Map<number, PdfLayoutRegion[]> {
	const byPage = groupByPage(selectableLayoutRegions(regions, minScore));
	for (const page of byPage.values()) sortLargestFirst(page);
	return byPage;
}

function hitBoxArea(
	region: PdfLayoutRegion,
	x: number,
	y: number,
	line?: PdfAskNormalizedRect,
): number {
	let best = Number.POSITIVE_INFINITY;
	for (const box of layoutElementBoxes(region)) {
		const containsPoint = pointInBbox(x, y, box.bbox);
		const hitsLine = line ? rectsIntersect(box.bbox, line) : false;
		if (!containsPoint && !hitsLine) continue;
		best = Math.min(best, bboxArea(box.bbox));
	}
	return best;
}

/**
 * Smallest merged box under the point, or intersecting `line` when the
 * pointer sits on a text line that crosses the element. Ties break by score.
 * `regions` is one page's selectable bucket — no document-wide NMS here.
 */
export function pickSelectableLayoutRegion(
	regions: readonly PdfLayoutRegion[],
	x: number,
	y: number,
	line?: PdfAskNormalizedRect,
): PdfLayoutRegion | null {
	let best: PdfLayoutRegion | null = null;
	let bestArea = Number.POSITIVE_INFINITY;
	for (const region of regions) {
		const area = hitBoxArea(region, x, y, line);
		if (!Number.isFinite(area)) continue;
		if (
			!best ||
			area + 1e-12 < bestArea ||
			(Math.abs(area - bestArea) <= 1e-12 && region.score > best.score)
		) {
			best = region;
			bestArea = area;
		}
	}
	return best;
}
