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
import { groupReadingLines } from "@/lib/pdf/layout/reading-order";
import { captionRoleFromText } from "@/lib/pdf/layout/title-text";
import {
	isReferenceLayoutLabel,
	isReferenceSectionTitle,
} from "@/lib/pdf/layout/translation-exclusions";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

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
	excludedRects: readonly Rect[] = [],
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
		if (insideAnyRect(rect, excludedRects)) {
			flush();
			continue;
		}

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

function mergeLineFragments(
	fragments: TextFragment[],
	excludedRects: readonly Rect[] = [],
): Rect[] {
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
		const joined = unionRects(previous.rect, fragment.rect);
		const crossesExcluded = excludedRects.some(
			(box) =>
				joined.origin.x < box.origin.x + box.size.width &&
				joined.origin.x + joined.size.width > box.origin.x &&
				joined.origin.y < box.origin.y + box.size.height &&
				joined.origin.y + joined.size.height > box.origin.y,
		);
		if (gap > maximumGap || gap < -maximumGap || crossesExcluded) {
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

function insideAnyRect(rect: Rect, excluded: readonly Rect[]): boolean {
	const x = rect.origin.x + rect.size.width / 2;
	const y = rect.origin.y + rect.size.height / 2;
	return excluded.some(
		(box) =>
			x >= box.origin.x &&
			x <= box.origin.x + box.size.width &&
			y >= box.origin.y &&
			y <= box.origin.y + box.size.height,
	);
}

type SelectionInsertionRegion = Pick<
	PdfLayoutRegion,
	"pageIndex" | "kind" | "rect"
> &
	Partial<Pick<PdfLayoutRegion, "label" | "captionRole" | "text" | "title">>;

/** Standalone inserted blocks do not interrupt body selections. */
export function isSelectionInsertionRegion(
	region: SelectionInsertionRegion,
): boolean {
	if (region.kind === "formula" && region.label === "inline_formula")
		return false;
	if (
		[
			"table",
			"image",
			"chart",
			"algorithm",
			"figure_title",
			"formula",
			"formula_number",
		].includes(region.kind)
	)
		return true;
	if (
		["footnote", "vision_footnote", "aside_text", "footer", "seal"].includes(
			region.label?.trim().toLowerCase() ?? "",
		)
	)
		return true;
	if (isReferenceLayoutLabel(region.label ?? "")) return true;
	if (region.captionRole && region.captionRole !== "other") return true;
	// Some providers label numbered table/figure captions as headings.
	const text = region.text ?? region.title ?? "";
	if (region.kind === "header" && isReferenceSectionTitle(text)) return true;
	return (
		region.kind === "header" &&
		/\d/u.test(text) &&
		["figure_main", "table_main", "algorithm_main"].includes(
			captionRoleFromText(text),
		)
	);
}

const inlineSelectionFormulaCache = new WeakMap<
	PdfPageGeometry,
	WeakMap<SelectionInsertionRegion, boolean>
>();

/** Adjacent prose on the same line keeps a detected formula in the body flow. */
function isInlineSelectionFormula(
	region: SelectionInsertionRegion,
	geometry: PdfPageGeometry | undefined,
	regions: readonly SelectionInsertionRegion[],
): boolean {
	if (region.kind !== "formula" || !geometry) return false;
	const cached = inlineSelectionFormulaCache.get(geometry)?.get(region);
	if (cached != null) return cached;
	const inline = formulaHasInlineNeighbours(region, geometry, regions);
	const byRegion =
		inlineSelectionFormulaCache.get(geometry) ??
		new WeakMap<SelectionInsertionRegion, boolean>();
	byRegion.set(region, inline);
	inlineSelectionFormulaCache.set(geometry, byRegion);
	return inline;
}

function formulaHasInlineNeighbours(
	region: SelectionInsertionRegion,
	geometry: PdfPageGeometry,
	regions: readonly SelectionInsertionRegion[],
): boolean {
	const { x, y, w, h } = region.rect;
	const formula = { origin: { x, y }, size: { width: w, height: h } };
	const numbers = regions
		.filter(
			(other) =>
				other.pageIndex === region.pageIndex && other.kind === "formula_number",
		)
		.map(({ rect }) => ({
			origin: { x: rect.x, y: rect.y },
			size: { width: rect.w, height: rect.h },
		}));
	let neighbours = 0;
	for (const run of geometry.runs) {
		for (const glyph of run.glyphs) {
			const rect = glyphRect(glyph);
			if (!rect || insideAnyRect(rect, [formula, ...numbers])) continue;
			const midY = rect.origin.y + rect.size.height / 2;
			const slack = rect.size.height * 0.35;
			// A tall formula box can graze the previous line. Same-line prose
			// is centered in the formula band; an equation number is not.
			if (midY < y - slack || midY > y + h + slack) continue;
			const gap = Math.max(
				x - rect.origin.x - rect.size.width,
				rect.origin.x - x - w,
				0,
			);
			if (gap <= Math.max(8, rect.size.height * 1.5) && ++neighbours >= 2)
				return true;
		}
	}
	return false;
}

type InkLine = {
	visual: Rect[];
	excluded: Rect[];
	left: number;
	right: number;
	top: number;
	bottom: number;
};

type TextColumn = { left: number; right: number; width: number };

function median(values: readonly number[]): number {
	if (!values.length) return 0;
	const sorted = values.slice().sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] ?? 0)
		: ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function looseGlyphRect(glyph: PdfGlyphSlim): Rect | null {
	const { x, y, width, height } = glyph;
	if (
		!Number.isFinite(x) ||
		!Number.isFinite(y) ||
		!isFinitePositive(width) ||
		!isFinitePositive(height)
	)
		return null;
	return { origin: { x, y }, size: { width, height } };
}

/** Cover both the tight ink center and the loose glyph center. */
function centerSpan(rects: readonly Rect[]): Rect | null {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const rect of rects) {
		const x = rect.origin.x + rect.size.width / 2;
		const y = rect.origin.y + rect.size.height / 2;
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	if (!Number.isFinite(minX)) return null;
	return {
		origin: { x: minX - 0.01, y: minY - 0.01 },
		size: { width: maxX - minX + 0.02, height: maxY - minY + 0.02 },
	};
}

function inkLines(geometry: PdfPageGeometry): InkLine[] {
	const glyphs: { visual: Rect; exclusion: Rect }[] = [];
	for (const run of geometry.runs) {
		for (const glyph of run.glyphs) {
			if (glyph.flags === GLYPH_FLAG_SPACE || glyph.flags === GLYPH_FLAG_EMPTY)
				continue;
			const visual = glyphRect(glyph);
			const loose = looseGlyphRect(glyph);
			const exclusion = centerSpan(
				[visual, loose].filter((rect): rect is Rect => rect != null),
			);
			if (!visual || !exclusion) continue;
			glyphs.push({ visual, exclusion });
		}
	}
	return groupReadingLines(glyphs, (glyph) => ({
		x: glyph.visual.origin.x,
		y: glyph.visual.origin.y,
		width: glyph.visual.size.width,
		height: glyph.visual.size.height,
	})).flatMap((line) => {
		const ordered = line.items
			.slice()
			.sort(
				(a, b) =>
					a.visual.origin.x - b.visual.origin.x ||
					a.visual.origin.y - b.visual.origin.y,
			);
		const groups: (typeof ordered)[] = [];
		for (const item of ordered) {
			const group = groups.at(-1);
			const previous = group?.at(-1);
			const gap = previous
				? item.visual.origin.x -
					(previous.visual.origin.x + previous.visual.size.width)
				: 0;
			// A column gutter or the space before an equation number is wider
			// than a word space, so same-baseline columns stay separate.
			if (!group || gap >= 24) groups.push([item]);
			else group.push(item);
		}
		return groups.map((group) => {
			const union = unionRectsAll(group.map((item) => item.visual));
			return {
				visual: group.map((item) => item.visual),
				excluded: group.map((item) => item.exclusion),
				left: union?.origin.x ?? 0,
				right: (union?.origin.x ?? 0) + (union?.size.width ?? 0),
				top: union?.origin.y ?? line.top,
				bottom:
					(union?.origin.y ?? line.top) +
					(union?.size.height ?? line.bottom - line.top),
			};
		});
	});
}

function largestGap(rects: readonly Rect[]): number {
	const ordered = rects
		.slice()
		.sort((a, b) => a.origin.x - b.origin.x || a.origin.y - b.origin.y);
	let gap = 0;
	for (let index = 1; index < ordered.length; index++) {
		const previous = ordered[index - 1];
		const current = ordered[index];
		if (!previous || !current) continue;
		gap = Math.max(
			gap,
			current.origin.x - (previous.origin.x + previous.size.width),
		);
	}
	return gap;
}

function textColumns(lines: readonly InkLine[], typical: number): TextColumn[] {
	const gapCut = Math.max(16, typical * 0.045);
	const body = lines.filter((line) => {
		const width = line.right - line.left;
		return (
			line.visual.length >= 8 &&
			width >= typical * 0.75 &&
			width <= typical * 1.2 &&
			largestGap(line.visual) < gapCut
		);
	});
	if (body.length < 2) return [];
	const ordered = body.slice().sort((a, b) => a.left - b.left);
	const groups: InkLine[][] = [];
	for (const line of ordered) {
		const group = groups.at(-1);
		const anchor = group ? median(group.map((item) => item.left)) : 0;
		if (!group || line.left - anchor > typical * 0.45) groups.push([line]);
		else group.push(line);
	}
	return groups.map((group) => {
		const left = median(group.map((line) => line.left));
		const right = median(group.map((line) => line.right));
		return { left, right, width: Math.max(0, right - left) };
	});
}

function columnFor(
	line: InkLine,
	columns: readonly TextColumn[],
): TextColumn | null {
	const center = (line.left + line.right) / 2;
	let best: TextColumn | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const column of columns) {
		if (center < column.left - 12 || center > column.right + 12) continue;
		const distance = Math.abs(center - (column.left + column.right) / 2);
		if (distance < bestDistance) {
			best = column;
			bestDistance = distance;
		}
	}
	return best;
}

function expandLine(line: InkLine, extra: InkLine) {
	line.visual.push(...extra.visual);
	line.excluded.push(...extra.excluded);
	line.left = Math.min(line.left, extra.left);
	line.right = Math.max(line.right, extra.right);
	line.top = Math.min(line.top, extra.top);
	line.bottom = Math.max(line.bottom, extra.bottom);
}

/** Pull a detached right-margin equation number back onto its formula line. */
function joinRightNumbers(
	lines: readonly InkLine[],
	columns: readonly TextColumn[],
	gapCut: number,
): InkLine[] {
	const consumed = new Set<InkLine>();
	for (const line of lines) {
		const column = columnFor(line, columns);
		if (!column) continue;
		const width = line.right - line.left;
		if (
			line.visual.length > 8 ||
			width > Math.max(42, column.width * 0.12) ||
			column.right - line.right > Math.max(22, column.width * 0.07)
		)
			continue;
		const mid = (line.top + line.bottom) / 2;
		let host: InkLine | null = null;
		let best = Number.POSITIVE_INFINITY;
		for (const other of lines) {
			if (other === line || consumed.has(other)) continue;
			const otherMid = (other.top + other.bottom) / 2;
			const vertical = Math.abs(mid - otherMid);
			if (vertical > 8) continue;
			const gap = line.left - other.right;
			if (gap < gapCut || gap > column.width * 0.75) continue;
			if (vertical < best) {
				host = other;
				best = vertical;
			}
		}
		if (!host) continue;
		expandLine(host, line);
		consumed.add(line);
	}
	return lines.filter((line) => !consumed.has(line));
}

/** Keep superscripts and subscripts with the formula line that owns them. */
function attachScripts(lines: readonly InkLine[]): InkLine[] {
	const consumed = new Set<InkLine>();
	for (const line of lines) {
		if (line.visual.length > 4 || line.right - line.left > 36) continue;
		const mid = (line.top + line.bottom) / 2;
		const center = (line.left + line.right) / 2;
		let host: InkLine | null = null;
		let best = Number.POSITIVE_INFINITY;
		for (const other of lines) {
			if (other === line || consumed.has(other)) continue;
			if (other.visual.length <= line.visual.length) continue;
			if (center < other.left - 4 || center > other.right + 4) continue;
			const distance = Math.abs(mid - (other.top + other.bottom) / 2);
			if (distance > Math.max(12, (other.bottom - other.top) * 0.9)) continue;
			if (distance < best) {
				host = other;
				best = distance;
			}
		}
		if (!host) continue;
		expandLine(host, line);
		consumed.add(line);
	}
	return lines.filter((line) => !consumed.has(line));
}

function hasScripts(rects: readonly Rect[]): boolean {
	const heights = rects
		.map((rect) => rect.size.height)
		.filter((height) => height > 0);
	const typical = median(heights);
	if (!(typical > 0)) return false;
	const mid = median(rects.map((rect) => rect.origin.y + rect.size.height / 2));
	return rects.some((rect) => {
		const center = rect.origin.y + rect.size.height / 2;
		return (
			rect.size.height < typical * 0.75 &&
			Math.abs(center - mid) > typical * 0.12
		);
	});
}

function segments(rects: readonly Rect[], minGap: number): Rect[][] {
	const ordered = rects
		.slice()
		.sort((a, b) => a.origin.x - b.origin.x || a.origin.y - b.origin.y);
	const groups: Rect[][] = [];
	for (const rect of ordered) {
		const group = groups.at(-1);
		const previous = group?.at(-1);
		if (
			!group ||
			!previous ||
			rect.origin.x - (previous.origin.x + previous.size.width) >= minGap
		)
			groups.push([rect]);
		else group.push(rect);
	}
	return groups;
}

function isDisplayFormulaLine(
	line: InkLine,
	column: TextColumn,
	gapCut: number,
): boolean {
	const parts = segments(line.visual, gapCut);
	const number = parts.length >= 2 ? parts.at(-1) : undefined;
	const numberBox = number ? unionRectsAll(number) : null;
	const content = parts.slice(0, -1).flat();
	const contentBox = unionRectsAll(content);
	if (
		number &&
		numberBox &&
		contentBox &&
		number.length <= 8 &&
		numberBox.size.width <= Math.max(42, column.width * 0.12) &&
		column.right - (numberBox.origin.x + numberBox.size.width) <=
			Math.max(22, column.width * 0.07) &&
		(contentBox.origin.x - column.left >= Math.max(16, column.width * 0.06) ||
			hasScripts(content))
	)
		return true;
	const width = line.right - line.left;
	const leftInset = line.left - column.left;
	const rightInset = column.right - line.right;
	return (
		leftInset >= Math.max(28, column.width * 0.12) &&
		rightInset >= Math.max(28, column.width * 0.12) &&
		width <= column.width * 0.72 &&
		hasScripts(line.visual)
	);
}

const displayFormulaRectCache = new WeakMap<PdfPageGeometry, Rect[]>();

/**
 * Display equations are centered or separated from a right-margin number.
 * Layout analysis misses some of them; the glyph gaps still identify the line.
 * Page geometry is stable, and this runs on every drag move for every mounted
 * page, so the line scan is cached.
 */
function displayFormulaExclusionRects(geometry: PdfPageGeometry): Rect[] {
	const cached = displayFormulaRectCache.get(geometry);
	if (cached) return cached;
	const rects = findDisplayFormulaExclusionRects(geometry);
	displayFormulaRectCache.set(geometry, rects);
	return rects;
}

/** True when this call did the line scan. Page geometry is stable, so repeat calls are free. */
export function warmDisplayFormulaExclusions(
	geometry: PdfPageGeometry,
): boolean {
	if (displayFormulaRectCache.has(geometry)) return false;
	displayFormulaExclusionRects(geometry);
	return true;
}

function findDisplayFormulaExclusionRects(geometry: PdfPageGeometry): Rect[] {
	const lines = inkLines(geometry);
	const typical = median(
		lines.map((line) => line.right - line.left).filter((width) => width > 40),
	);
	if (typical < 80) return [];
	const columns = textColumns(lines, typical);
	if (!columns.length) return [];
	const gapCut = Math.max(16, typical * 0.045);
	const prepared = joinRightNumbers(attachScripts(lines), columns, gapCut);
	const rects: Rect[] = [];
	for (const line of prepared) {
		const column = columnFor(line, columns);
		if (column == null || !isDisplayFormulaLine(line, column, gapCut)) continue;
		const rect = unionRectsAll(line.excluded);
		if (rect) rects.push(rect);
	}
	return rects;
}

/** Body-to-body selections skip detected insertions; explicit selections keep them. */
export function selectionInsertionExclusions(
	geometry: Readonly<Record<number, PdfPageGeometry>>,
	selection: SelectionRangeX | null,
	regions: readonly SelectionInsertionRegion[],
	startPageIndex?: number | null,
	formulaLines: "scan" | "cached" = "scan",
): ReadonlyMap<number, readonly Rect[]> {
	const insertions = new Map<number, Rect[]>();
	if (!selection) return insertions;
	const ordered = orderedSelection(selection);
	const samePage = ordered.start.page === ordered.end.page;
	for (const region of regions) {
		if (
			region.pageIndex < ordered.start.page ||
			region.pageIndex > ordered.end.page
		)
			continue;
		if (!isSelectionInsertionRegion(region)) continue;
		// Same-page drags still include tables, captions and headings. A display
		// formula between body lines is skipped on one page as well.
		if (
			samePage &&
			region.kind !== "formula" &&
			region.kind !== "formula_number"
		)
			continue;
		if (isInlineSelectionFormula(region, geometry[region.pageIndex], regions))
			continue;
		const { x, y, w, h } = region.rect;
		// Detector boxes can stop just before a table's coloured superscripts.
		const pad = region.kind === "table" ? 2 : 0;
		const rect = {
			origin: { x: x - pad, y: y - pad },
			size: { width: w + 2 * pad, height: h + 2 * pad },
		};
		const list = insertions.get(region.pageIndex) ?? [];
		list.push(rect);
		insertions.set(region.pageIndex, list);
	}
	for (let page = ordered.start.page; page <= ordered.end.page; page++) {
		const pageGeometry = geometry[page];
		if (!pageGeometry) continue;
		const formulas =
			formulaLines === "cached"
				? displayFormulaRectCache.get(pageGeometry)
				: displayFormulaExclusionRects(pageGeometry);
		if (!formulas?.length) continue;
		const list = insertions.get(page) ?? [];
		list.push(...formulas);
		insertions.set(page, list);
	}
	// A drag starting in an inserted block is deliberate. Merely releasing
	// over a caption must not re-select every table crossed from the body.
	const origin =
		startPageIndex === selection.end.page ? selection.end : selection.start;
	const run = geometry[origin.page]?.runs.find(
		(run) =>
			origin.index >= run.charStart &&
			origin.index < run.charStart + run.glyphs.length,
	);
	const glyph = run?.glyphs[origin.index - run.charStart];
	const rect = glyph && glyphRect(glyph);
	if (rect && insideAnyRect(rect, insertions.get(origin.page) ?? []))
		return new Map();
	return insertions;
}

/** Preserve an explicitly selected caption/margin at the gesture's actual origin. */
export function selectionTextExclusionsForPage(
	rects: readonly Rect[],
	geometry: Readonly<Record<number, PdfPageGeometry>>,
	selection: SelectionRangeX | null,
	pageIndex: number,
	startPageIndex?: number | null,
): readonly Rect[] {
	if (!selection) return rects;
	const origin =
		startPageIndex === selection.end.page ? selection.end : selection.start;
	if (origin.page !== pageIndex) return rects;
	const run = geometry[pageIndex]?.runs.find(
		(run) =>
			origin.index >= run.charStart &&
			origin.index < run.charStart + run.glyphs.length,
	);
	const glyph = run?.glyphs[origin.index - run.charStart];
	const rect = glyph && glyphRect(glyph);
	return rect ? rects.filter((box) => !insideAnyRect(rect, [box])) : rects;
}

/** Keep PDFium character indexes aligned while skipping excluded glyphs. */
export function selectionTextSlices(
	geometry: PdfPageGeometry,
	start: number,
	count: number,
	excluded: readonly Rect[],
): { start: number; count: number }[] {
	const omitted = new Set<number>();
	for (const run of geometry.runs) {
		for (let i = 0; i < run.glyphs.length; i++) {
			const glyph = run.glyphs[i];
			const rect = {
				origin: { x: glyph.x, y: glyph.y },
				size: { width: glyph.width, height: glyph.height },
			};
			if (insideAnyRect(rect, excluded)) omitted.add(run.charStart + i);
		}
	}
	const slices: { start: number; count: number }[] = [];
	for (let index = start; index < start + count; index++) {
		if (omitted.has(index)) continue;
		const previous = slices.at(-1);
		if (previous && previous.start + previous.count === index) previous.count++;
		else slices.push({ start: index, count: 1 });
	}
	return slices;
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
	excludedMarginRects: readonly Rect[] = [],
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

	const excluded = excludedMarginRects;
	const fragments = geometry.runs.flatMap((run) =>
		selectedRunFragments(run, selectionStart, selectionEnd, excluded),
	);
	return mergeLineFragments(fragments, excluded);
}

export function tightenFormattedSelection(
	pages: FormattedSelection[],
	geometry: Record<number, PdfPageGeometry> | undefined,
	selection: SelectionRangeX | null,
	excludedMargins?: ReadonlyMap<number, readonly Rect[]>,
): FormattedSelection[] {
	if (!geometry || !selection) return pages;

	return pages.flatMap((page) => {
		const excluded = excludedMargins?.get(page.pageIndex) ?? [];
		const tightRects = buildTightSelectionRects(
			geometry[page.pageIndex],
			selection,
			page.pageIndex,
			excluded,
		);
		if (!tightRects.length && excluded.length) return [];
		if (!tightRects.length) return page;

		const rect = unionRectsAll(tightRects) ?? page.rect;
		return {
			...page,
			rect,
			segmentRects: tightRects,
		};
	});
}
