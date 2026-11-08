/**
 * Page ↔ screen coordinate mapping for the PDF reader.
 *
 * Two directions live here on purpose: EmbedPDF reports geometry in PDF points
 * while overlays, cards and marks work in page fractions or client pixels.
 */

import type { Rect, Size } from "@embedpdf/models";
import type { FormattedSelection } from "@embedpdf/plugin-selection/react";
import { clamp01 } from "@/lib/core/math";
import type {
	PdfAskAnchor,
	PdfAskNormalizedRect,
	PdfAskTrigger,
} from "@/lib/pdf/ask/types";

/** Marks a rendered page wrapper so overlays/menus can map page↔screen coords. */
export const EMBED_PAGE_ATTR = "data-embed-pdf-page";

export function pageElByIndex(
	host: HTMLElement | null,
	pageIndex: number,
): HTMLElement | null {
	if (!host) return null;
	return host.querySelector<HTMLElement>(`[${EMBED_PAGE_ATTR}="${pageIndex}"]`);
}

/** Map the union of normalized selection rects to the viewport. */
export function selectionBoundsOnScreen(
	pageEl: HTMLElement | null,
	rects: PdfAskNormalizedRect[],
) {
	if (!pageEl || !rects.length) return null;
	const page = pageEl.getBoundingClientRect();
	let left = 1;
	let top = 1;
	let right = 0;
	let bottom = 0;
	for (const rect of rects) {
		left = Math.min(left, rect.x);
		top = Math.min(top, rect.y);
		right = Math.max(right, rect.x + rect.w);
		bottom = Math.max(bottom, rect.y + rect.h);
	}
	return {
		left: page.left + left * page.width,
		top: page.top + top * page.height,
		right: page.left + right * page.width,
		bottom: page.top + bottom * page.height,
	};
}

/**
 * Map a page-coordinate rect (PDF points) to a screen point. The rendered page
 * element is `points * zoom` CSS px, so a point offset maps to `offset * zoom`
 * px within the element's client box.
 */
export function rectTopCenterScreen(
	pageEl: HTMLElement,
	rect: Rect,
	zoom: number,
): { x: number; y: number } {
	const box = pageEl.getBoundingClientRect();
	return {
		x: box.left + (rect.origin.x + rect.size.width / 2) * zoom,
		y: box.top + rect.origin.y * zoom,
	};
}

export function rectBottomCenterScreen(
	pageEl: HTMLElement,
	rect: Rect,
	zoom: number,
): { x: number; y: number; top: number; bottom: number } {
	const box = pageEl.getBoundingClientRect();
	const bottom = box.top + (rect.origin.y + rect.size.height) * zoom;
	const top = box.top + rect.origin.y * zoom;
	return {
		x: box.left + (rect.origin.x + rect.size.width / 2) * zoom,
		y: bottom,
		top,
		bottom,
	};
}

/**
 * Build a normalized {@link PdfAskAnchor} from an EmbedPDF text selection.
 * EmbedPDF reports rects in PDF page coordinates (points); dividing by the page
 * size yields the 0–1 rects the Ask/Translate marks + pins use.
 *
 * Ask/Translate anchor to a single page. Use `preferredPageIndex` (e.g. the
 * page where the cursor ended) when available; otherwise fall back to the first
 * page of the selection.
 */
export function anchorFromEmbedSelection(
	pages: FormattedSelection[],
	quote: string,
	pageSizePoints: (pageIndex: number) => Size | null,
	trigger: PdfAskTrigger = "selection",
	preferredPageIndex?: number,
): PdfAskAnchor | null {
	const first = pages[0];
	if (!first) return null;
	const page =
		preferredPageIndex != null
			? (pages.find((p) => p.pageIndex === preferredPageIndex) ?? first)
			: first;
	const size = pageSizePoints(page.pageIndex);
	if (!size || size.width <= 0 || size.height <= 0) return null;
	const rects: PdfAskNormalizedRect[] = page.segmentRects
		.filter((r) => r.size.width > 0 && r.size.height > 0)
		.map((r) => ({
			x: clamp01(r.origin.x / size.width),
			y: clamp01(r.origin.y / size.height),
			w: clamp01(r.size.width / size.width),
			h: clamp01(r.size.height / size.height),
		}));
	if (!rects.length) return null;
	return {
		page: page.pageIndex + 1,
		rects,
		quote: quote.trim() || undefined,
		trigger,
	};
}
