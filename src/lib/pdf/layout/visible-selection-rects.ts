/**
 * Page-fraction boxes of a translation-overlay selection.
 *
 * The saved annotation keeps the English glyph boxes and, when the selection
 * was made on a translation, these boxes too. The toolbar, the right-rail
 * note chip, and the tint drawn while that chip is open follow these boxes.
 */

import { clamp01 } from "@/lib/core/math";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";

export type ClientRectLike = {
	left: number;
	top: number;
	width: number;
	height: number;
};

export type PageFrame = {
	pageIndex: number;
	left: number;
	top: number;
	width: number;
	height: number;
};

export type VisibleSelectionPage = {
	/** 0-based page index, same as EmbedPDF. */
	pageIndex: number;
	rects: PdfAskNormalizedRect[];
};

const MIN_CLIENT_PX = 0.5;
/** Same line rule as the English glyph highlight (`selection-appearance.ts`). */
const MIN_VERTICAL_OVERLAP = 0.5;
/** Justification and sentence-span seams stay inside one band; a column gutter does not. */
const MAX_GAP_FACTOR = 2.5;

function verticalOverlapRatio(
	first: ClientRectLike,
	second: ClientRectLike,
): number {
	const top = Math.max(first.top, second.top);
	const bottom = Math.min(first.top + first.height, second.top + second.height);
	const overlap = Math.max(0, bottom - top);
	const minHeight = Math.min(first.height, second.height);
	return minHeight > 0 ? overlap / minHeight : 0;
}

/**
 * Join selection fragments that sit on one visual line.
 *
 * A translation paragraph is split into sentence spans, and justified CJK
 * yields a client rect per character. Native `::selection` paints each of
 * those separately, so a drag looks like disconnected blocks. English text
 * selection unions glyph boxes on the same line; this is that union for DOM
 * client rects, in document order.
 */
export function mergeClientRectsIntoLines(
	rects: readonly ClientRectLike[],
): ClientRectLike[] {
	const merged: ClientRectLike[] = [];
	for (const rect of rects) {
		if (rect.width < MIN_CLIENT_PX || rect.height < MIN_CLIENT_PX) continue;
		const previous = merged.at(-1);
		const glyph = Math.min(
			rect.width,
			rect.height,
			previous?.height ?? rect.height,
		);
		const maximumGap = Math.max(glyph, 1) * MAX_GAP_FACTOR;
		const gap = previous
			? rect.left - (previous.left + previous.width)
			: Number.POSITIVE_INFINITY;
		if (
			!previous ||
			verticalOverlapRatio(previous, rect) < MIN_VERTICAL_OVERLAP ||
			gap > maximumGap
		) {
			merged.push({
				left: rect.left,
				top: rect.top,
				width: rect.width,
				height: rect.height,
			});
			continue;
		}
		const left = Math.min(previous.left, rect.left);
		const top = Math.min(previous.top, rect.top);
		const right = Math.max(
			previous.left + previous.width,
			rect.left + rect.width,
		);
		const bottom = Math.max(
			previous.top + previous.height,
			rect.top + rect.height,
		);
		previous.left = left;
		previous.top = top;
		previous.width = right - left;
		previous.height = bottom - top;
	}
	return separateStackedLines(merged);
}

/**
 * Reflow gives every character the font's full height, which is taller than
 * the gap to the next baseline. Each line stays its own band, but the two
 * bands share a strip. Split that strip so the highlight is not painted twice.
 */
function separateStackedLines(rects: ClientRectLike[]): ClientRectLike[] {
	const lines = rects.map((rect) => ({ ...rect }));
	for (let index = 1; index < lines.length; index += 1) {
		const previous = lines[index - 1];
		const current = lines[index];
		if (!previous || !current) continue;
		const overlap = previous.top + previous.height - current.top;
		const minHeight = Math.min(previous.height, current.height);
		if (overlap <= 0 || minHeight <= 0) continue;
		if (overlap >= minHeight * MIN_VERTICAL_OVERLAP) continue;
		const shared =
			Math.min(previous.left + previous.width, current.left + current.width) -
			Math.max(previous.left, current.left);
		if (shared <= 0) continue;
		const mid = current.top + overlap / 2;
		const bottom = current.top + current.height;
		previous.height = mid - previous.top;
		current.top = mid;
		current.height = bottom - mid;
	}
	return lines;
}

function roundFraction(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

/**
 * Bucket client rects into the page whose box contains each rect's center.
 * Rects that hang off the page are clipped to it.
 */
export function visiblePagesFromClientRects(
	clientRects: readonly ClientRectLike[],
	pages: readonly PageFrame[],
): VisibleSelectionPage[] {
	const buckets = new Map<number, PdfAskNormalizedRect[]>();
	for (const rect of clientRects) {
		if (rect.width < MIN_CLIENT_PX || rect.height < MIN_CLIENT_PX) continue;
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		const page = pages.find(
			(frame) =>
				frame.width > 0 &&
				frame.height > 0 &&
				cx >= frame.left &&
				cx <= frame.left + frame.width &&
				cy >= frame.top &&
				cy <= frame.top + frame.height,
		);
		if (!page) continue;
		const x0 = clamp01((rect.left - page.left) / page.width);
		const y0 = clamp01((rect.top - page.top) / page.height);
		const x1 = clamp01((rect.left + rect.width - page.left) / page.width);
		const y1 = clamp01((rect.top + rect.height - page.top) / page.height);
		const w = roundFraction(x1 - x0);
		const h = roundFraction(y1 - y0);
		if (w < 0.001 || h < 0.001) continue;
		const list = buckets.get(page.pageIndex) ?? [];
		list.push({
			x: roundFraction(x0),
			y: roundFraction(y0),
			w,
			h,
		});
		buckets.set(page.pageIndex, list);
	}
	return [...buckets.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([pageIndex, rects]) => ({ pageIndex, rects }));
}

/** Last visible page, and the top of its rects. Page number is 1-based. */
export function selectionAnchorFromVisible(
	pages: readonly VisibleSelectionPage[],
): { page: number; anchorY: number } | null {
	const chip = pages[pages.length - 1];
	if (!chip?.rects.length) return null;
	return {
		page: chip.pageIndex + 1,
		anchorY: Math.min(...chip.rects.map((rect) => rect.y)),
	};
}

/** Union top-center in page fractions. */
export function visibleTopCenter(
	rects: readonly PdfAskNormalizedRect[],
): { x: number; y: number } | null {
	if (!rects.length) return null;
	let minX = 1;
	let minY = 1;
	let maxX = 0;
	for (const rect of rects) {
		minX = Math.min(minX, rect.x);
		minY = Math.min(minY, rect.y);
		maxX = Math.max(maxX, rect.x + rect.w);
	}
	return { x: (minX + maxX) / 2, y: minY };
}

/**
 * Screen point for the floating toolbar. Prefers `preferredPageIndex` when
 * that page has visible rects; otherwise the last page.
 */
export function visibleMenuPoint(
	pages: readonly VisibleSelectionPage[],
	preferredPageIndex: number,
	pageBox: (pageIndex: number) => PageFrame | null,
): { x: number; y: number } | null {
	if (!pages.length) return null;
	const page =
		pages.find((item) => item.pageIndex === preferredPageIndex) ??
		pages[pages.length - 1];
	if (!page) return null;
	const point = visibleTopCenter(page.rects);
	const box = pageBox(page.pageIndex);
	if (!point || !box || box.width <= 0 || box.height <= 0) return null;
	return {
		x: box.left + point.x * box.width,
		y: box.top + point.y * box.height,
	};
}
