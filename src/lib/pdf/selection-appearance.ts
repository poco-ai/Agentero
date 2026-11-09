import type {
	PdfGlyphSlim,
	PdfPageGeometry,
	PdfRun,
	Rect,
} from "@embedpdf/models";
import type {
	FormattedSelection,
	SelectionRangeX,
} from "@embedpdf/plugin-selection";

type TextFragment = {
	rect: Rect;
	charCount: number;
	averageGlyphWidth: number;
};

const GLYPH_FLAG_SPACE = 1;
const GLYPH_FLAG_EMPTY = 2;
const MAX_GLYPH_GAP_FACTOR = 2.5;
const MIN_VERTICAL_OVERLAP = 0.5;

function isFinitePositive(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value);
}

function glyphRect(glyph: PdfGlyphSlim): Rect | null {
	if (glyph.flags === GLYPH_FLAG_SPACE || glyph.flags === GLYPH_FLAG_EMPTY) {
		return null;
	}

	const { tightX, tightY, tightWidth, tightHeight } = glyph;
	if (
		isFiniteNumber(tightX) &&
		isFiniteNumber(tightY) &&
		isFinitePositive(tightWidth) &&
		isFinitePositive(tightHeight)
	) {
		return {
			origin: { x: tightX, y: tightY },
			size: { width: tightWidth, height: tightHeight },
		};
	}

	const { x, y, width, height } = glyph;

	if (
		!Number.isFinite(x) ||
		!Number.isFinite(y) ||
		!isFinitePositive(width) ||
		!isFinitePositive(height)
	) {
		return null;
	}

	return {
		origin: { x, y },
		size: { width, height },
	};
}

function unionRects(first: Rect, second: Rect): Rect {
	const left = Math.min(first.origin.x, second.origin.x);
	const top = Math.min(first.origin.y, second.origin.y);
	const right = Math.max(
		first.origin.x + first.size.width,
		second.origin.x + second.size.width,
	);
	const bottom = Math.max(
		first.origin.y + first.size.height,
		second.origin.y + second.size.height,
	);
	return {
		origin: { x: left, y: top },
		size: { width: right - left, height: bottom - top },
	};
}

export function unionRectsAll(rects: Rect[]): Rect | null {
	if (!rects.length) return null;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const r of rects) {
		minX = Math.min(minX, r.origin.x);
		minY = Math.min(minY, r.origin.y);
		maxX = Math.max(maxX, r.origin.x + r.size.width);
		maxY = Math.max(maxY, r.origin.y + r.size.height);
	}
	return {
		origin: { x: minX, y: minY },
		size: { width: maxX - minX, height: maxY - minY },
	};
}

function verticalOverlap(first: Rect, second: Rect): number {
	const top = Math.max(first.origin.y, second.origin.y);
	const bottom = Math.min(
		first.origin.y + first.size.height,
		second.origin.y + second.size.height,
	);
	return (
		Math.max(0, bottom - top) / Math.min(first.size.height, second.size.height)
	);
}

function sameVisualLine(first: Rect, second: Rect): boolean {
	return verticalOverlap(first, second) >= MIN_VERTICAL_OVERLAP;
}

function selectedRunFragments(
	run: PdfRun,
	selectionStart: number,
	selectionEnd: number,
): TextFragment[] {
	const runStart = run.charStart;
	const runEnd = runStart + run.glyphs.length - 1;
	if (runEnd < selectionStart || runStart > selectionEnd) return [];

	const startIndex = Math.max(selectionStart, runStart) - runStart;
	const endIndex = Math.min(selectionEnd, runEnd) - runStart;
	const fragments: TextFragment[] = [];
	let currentRect: Rect | null = null;
	let glyphCount = 0;
	let glyphWidthSum = 0;

	const flush = () => {
		if (currentRect && glyphCount > 0) {
			fragments.push({
				rect: currentRect,
				charCount: glyphCount,
				averageGlyphWidth: glyphWidthSum / glyphCount,
			});
		}
		currentRect = null;
		glyphCount = 0;
		glyphWidthSum = 0;
	};

	for (let index = startIndex; index <= endIndex; index += 1) {
		const rect = glyphRect(run.glyphs[index]);
		if (!rect) continue;

		if (currentRect) {
			const gap =
				rect.origin.x - (currentRect.origin.x + currentRect.size.width);
			const averageWidth = glyphWidthSum / glyphCount;
			if (
				!sameVisualLine(currentRect, rect) ||
				gap > averageWidth * MAX_GLYPH_GAP_FACTOR ||
				gap < -averageWidth * MAX_GLYPH_GAP_FACTOR
			) {
				flush();
			}
		}

		currentRect = currentRect ? unionRects(currentRect, rect) : rect;
		glyphCount += 1;
		glyphWidthSum += rect.size.width;
	}

	flush();
	return fragments;
}

function mergeLineFragments(fragments: TextFragment[]): Rect[] {
	const merged: TextFragment[] = [];

	for (const fragment of fragments) {
		const previous = merged.at(-1);
		if (!previous || !sameVisualLine(previous.rect, fragment.rect)) {
			merged.push(fragment);
			continue;
		}

		const gap =
			fragment.rect.origin.x -
			(previous.rect.origin.x + previous.rect.size.width);
		const maximumGap =
			Math.max(previous.averageGlyphWidth, fragment.averageGlyphWidth) *
			MAX_GLYPH_GAP_FACTOR;
		if (gap > maximumGap || gap < -maximumGap) {
			merged.push(fragment);
			continue;
		}

		const charCount = previous.charCount + fragment.charCount;
		previous.averageGlyphWidth =
			(previous.averageGlyphWidth * previous.charCount +
				fragment.averageGlyphWidth * fragment.charCount) /
			charCount;
		previous.charCount = charCount;
		previous.rect = unionRects(previous.rect, fragment.rect);
	}

	return merged.map((fragment) => fragment.rect);
}

/** Turn matched glyphs in reading order into continuous bands on each line. */
export function mergeTightGlyphRects(rects: readonly Rect[]): Rect[] {
	return mergeLineFragments(
		rects.map((rect) => ({
			rect,
			charCount: 1,
			averageGlyphWidth: rect.size.width,
		})),
	);
}

function orderedSelection(selection: SelectionRangeX): SelectionRangeX {
	const startBeforeEnd =
		selection.start.page < selection.end.page ||
		(selection.start.page === selection.end.page &&
			selection.start.index <= selection.end.index);
	return startBeforeEnd
		? selection
		: { start: selection.end, end: selection.start };
}

/**
 * Rebuild the visible selection from PDFium's tight glyph boxes. EmbedPDF's
 * default renderer uses loose character boxes, which can include full leading
 * and oversized whitespace rectangles. Tight boxes keep the tint on the ink,
 * while line-aware merging preserves a continuous highlight across words.
 */
export function buildTightSelectionRects(
	geometry: PdfPageGeometry | undefined,
	selection: SelectionRangeX | null,
	pageIndex: number,
): Rect[] {
	if (!geometry || !selection) return [];

	const ordered = orderedSelection(selection);
	if (pageIndex < ordered.start.page || pageIndex > ordered.end.page) return [];

	const firstRun = geometry.runs[0];
	const lastRun = geometry.runs.at(-1);
	if (!firstRun || !lastRun) return [];

	const pageStart = firstRun.charStart;
	const pageEnd = lastRun.charStart + lastRun.glyphs.length - 1;
	const selectionStart =
		pageIndex === ordered.start.page ? ordered.start.index : pageStart;
	const selectionEnd =
		pageIndex === ordered.end.page ? ordered.end.index : pageEnd;

	const fragments = geometry.runs.flatMap((run) =>
		selectedRunFragments(run, selectionStart, selectionEnd),
	);
	return mergeLineFragments(fragments);
}

export function tightenFormattedSelection(
	pages: FormattedSelection[],
	geometry: Record<number, PdfPageGeometry> | undefined,
	selection: SelectionRangeX | null,
): FormattedSelection[] {
	if (!geometry || !selection) return pages;

	return pages.map((page) => {
		const tightRects = buildTightSelectionRects(
			geometry[page.pageIndex],
			selection,
			page.pageIndex,
		);
		if (!tightRects.length) return page;

		const rect = unionRectsAll(tightRects) ?? page.rect;
		return {
			...page,
			rect,
			segmentRects: tightRects,
		};
	});
}
