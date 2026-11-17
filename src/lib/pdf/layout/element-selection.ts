import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import { isLayoutElementTextKind } from "@/lib/pdf/layout/labels";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

export type LayoutElementBoxKey = "bbox" | "title" | "caption";

export type LayoutElementBox = {
	key: LayoutElementBoxKey;
	bbox: PdfAskNormalizedRect;
};

const SAME_BOX = 1e-4;

function sameBox(a: PdfAskNormalizedRect, b: PdfAskNormalizedRect): boolean {
	return (
		Math.abs(a.x - b.x) < SAME_BOX &&
		Math.abs(a.y - b.y) < SAME_BOX &&
		Math.abs(a.w - b.w) < SAME_BOX &&
		Math.abs(a.h - b.h) < SAME_BOX
	);
}

function usableBox(
	bbox: PdfAskNormalizedRect | undefined,
): bbox is PdfAskNormalizedRect {
	return !!bbox && bbox.w > 0 && bbox.h > 0;
}

/**
 * Boxes that belong to one post-merge element on its own page.
 * A caption that lives on another page is not projected into this page.
 */
export function layoutElementBoxes(
	region: PdfLayoutRegion,
): LayoutElementBox[] {
	const boxes: LayoutElementBox[] = [{ key: "bbox", bbox: region.bbox }];
	if (usableBox(region.titleBbox) && !sameBox(region.titleBbox, region.bbox)) {
		boxes.push({ key: "title", bbox: region.titleBbox });
	}
	const captionOnThisPage =
		region.captionPageIndex == null ||
		region.captionPageIndex === region.pageIndex;
	if (
		captionOnThisPage &&
		usableBox(region.captionBbox) &&
		!sameBox(region.captionBbox, region.bbox) &&
		!boxes.some((box) => sameBox(box.bbox, region.captionBbox!))
	) {
		boxes.push({ key: "caption", bbox: region.captionBbox });
	}
	return boxes;
}

/** 1-based page of a caption that was not merged onto this page. */
export function layoutElementCaptionPage(
	region: PdfLayoutRegion,
): number | null {
	if (
		region.captionPageIndex == null ||
		region.captionPageIndex === region.pageIndex ||
		!usableBox(region.captionBbox)
	) {
		return null;
	}
	return region.captionPageIndex + 1;
}

/**
 * Quote carried into chat and selection-translate.
 * Body / abstract / header / caption use `text`; figures, tables and
 * algorithms use the merged title. Category-chip activation keeps this whole
 * block quote; activation on a sentence uses the pointed sentence instead.
 */
export function layoutElementQuote(region: PdfLayoutRegion): string {
	const text = region.text?.replace(/\s+/g, " ").trim() ?? "";
	const title = region.title?.replace(/\s+/g, " ").trim() ?? "";
	if (isLayoutElementTextKind(region.kind)) return text || title;
	return title || text;
}

/** Non-text elements go to the Agent as a crop, not a visual mark. */
export function layoutElementNeedsCrop(kind: PdfLayoutRegion["kind"]): boolean {
	return !isLayoutElementTextKind(kind);
}

const PREVIEW_LIMIT = 72;

/** One-line preview. Empty when the element has no text. */
export function layoutElementPreview(
	quote: string,
	limit: number = PREVIEW_LIMIT,
): string {
	const flat = quote.replace(/\s+/g, " ").trim();
	if (!flat) return "";
	if (flat.length <= limit) return flat;
	return `${flat.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}
