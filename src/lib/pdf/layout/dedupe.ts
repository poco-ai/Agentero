import { isFigureLayoutKind, layoutDedupeGroup } from "@/lib/pdf/layout/labels";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

/** Intersection-over-union for normalized bboxes. */
export function bboxIoU(
	a: PdfLayoutRegion["bbox"],
	b: PdfLayoutRegion["bbox"],
): number {
	const ax2 = a.x + a.w;
	const ay2 = a.y + a.h;
	const bx2 = b.x + b.w;
	const by2 = b.y + b.h;
	const ix1 = Math.max(a.x, b.x);
	const iy1 = Math.max(a.y, b.y);
	const ix2 = Math.min(ax2, bx2);
	const iy2 = Math.min(ay2, by2);
	const iw = Math.max(0, ix2 - ix1);
	const ih = Math.max(0, iy2 - iy1);
	const inter = iw * ih;
	if (inter <= 0) return 0;
	const union = a.w * a.h + b.w * b.h - inter;
	return union > 0 ? inter / union : 0;
}

/** How much of the smaller box is covered by the larger (containment ratio). */
export function bboxContainment(
	a: PdfLayoutRegion["bbox"],
	b: PdfLayoutRegion["bbox"],
): number {
	const ax2 = a.x + a.w;
	const ay2 = a.y + a.h;
	const bx2 = b.x + b.w;
	const by2 = b.y + b.h;
	const ix1 = Math.max(a.x, b.x);
	const iy1 = Math.max(a.y, b.y);
	const ix2 = Math.min(ax2, bx2);
	const iy2 = Math.min(ay2, by2);
	const iw = Math.max(0, ix2 - ix1);
	const ih = Math.max(0, iy2 - iy1);
	const inter = iw * ih;
	const smaller = Math.min(a.w * a.h, b.w * b.h);
	return smaller > 0 ? inter / smaller : 0;
}

export type DedupeLayoutOptions = {
	/** Drop detections below this confidence (0–1). Default 0.3. */
	minScore?: number;
	/** IoU threshold for same-kind NMS. Default 0.45. */
	iouThreshold?: number;
	/** Containment threshold for same-kind suppression. Default 0.85. */
	containmentThreshold?: number;
	/** Drop boxes smaller than this fraction of page area. Default 0.002 (0.2%). */
	minArea?: number;
};

/** Comparable-confidence whole figures should not be erased by nested fragments. */
function preferCompleteFigure(
	outer: PdfLayoutRegion,
	inner: PdfLayoutRegion,
	containment: number,
): boolean {
	if (
		!isFigureLayoutKind(outer.kind) ||
		!isFigureLayoutKind(inner.kind) ||
		outer.titleBbox ||
		inner.titleBbox ||
		outer.captionBbox ||
		inner.captionBbox ||
		outer.title ||
		inner.title
	)
		return false;
	const ratio = (outer.bbox.w * outer.bbox.h) / (inner.bbox.w * inner.bbox.h);
	return (
		ratio >= 1.4 &&
		ratio <= 4 &&
		outer.score >= inner.score * 0.75 &&
		bboxContainment(outer.bbox, inner.bbox) >= containment
	);
}

/**
 * Keep figure/table/algorithm regions unique:
 * 1) score + size gates
 * 2) per-page, per-kind non-maximum suppression (IoU + containment)
 */
export function dedupeLayoutRegions(
	regions: PdfLayoutRegion[],
	options: DedupeLayoutOptions = {},
): PdfLayoutRegion[] {
	const minScore = options.minScore ?? 0.3;
	const iouThreshold = options.iouThreshold ?? 0.45;
	const containmentThreshold = options.containmentThreshold ?? 0.85;
	const minArea = options.minArea ?? 0.002;

	const candidates = regions.filter((r) => {
		if (!(r.score >= minScore)) return false;
		const area = r.bbox.w * r.bbox.h;
		return area >= minArea;
	});

	// Group by page + dedupe class (image+chart share “figure”).
	const groups = new Map<string, PdfLayoutRegion[]>();
	for (const r of candidates) {
		const key = `${r.pageIndex}::${layoutDedupeGroup(r.kind)}`;
		const list = groups.get(key);
		if (list) list.push(r);
		else groups.set(key, [r]);
	}

	const kept: PdfLayoutRegion[] = [];
	for (const group of groups.values()) {
		// Highest confidence first.
		const sorted = [...group].sort(
			(a, b) =>
				b.score - a.score ||
				b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h ||
				a.readingOrder - b.readingOrder,
		);
		const selected: PdfLayoutRegion[] = [];
		for (const cand of sorted) {
			let suppressed = false;
			const replaced = new Set<string>();
			for (const prev of selected) {
				if (preferCompleteFigure(cand, prev, containmentThreshold)) {
					replaced.add(prev.id);
					continue;
				}
				if (preferCompleteFigure(prev, cand, containmentThreshold)) {
					suppressed = true;
					break;
				}
				const iou = bboxIoU(cand.bbox, prev.bbox);
				if (iou >= iouThreshold) {
					suppressed = true;
					break;
				}
				const cont = bboxContainment(cand.bbox, prev.bbox);
				if (cont >= containmentThreshold) {
					suppressed = true;
					break;
				}
			}
			if (!suppressed) {
				for (let i = selected.length - 1; i >= 0; i--)
					if (replaced.has(selected[i].id)) selected.splice(i, 1);
				selected.push(cand);
			}
		}
		kept.push(...selected);
	}

	kept.sort(
		(a, b) =>
			a.pageIndex - b.pageIndex ||
			a.readingOrder - b.readingOrder ||
			a.kind.localeCompare(b.kind),
	);
	return kept;
}
