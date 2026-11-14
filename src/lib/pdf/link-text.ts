/**
 * Read the page text around a hovered link from PDFium text rects.
 *
 * Rects are grouped into line segments (per column), each character spread
 * evenly across its rect, so the text right under the link can be told apart
 * from the rest of a long run. Geometry is in multiples of the line height
 * rather than absolute points, so it holds for 8 pt footnotes and 12 pt body
 * text alike.
 *
 * `parseBracketCitation` recognizes a numeric in-text citation and the range
 * it belongs to. It is used only
 * when the link's own destination name does not identify a bibliography entry
 * (explicit `/Dest` arrays, publisher-specific names), and is deliberately
 * strict so Theorem / Listing / line / section links never pass: the linked
 * number must sit inside a `[…]` group whose body holds only numbers, commas,
 * whitespace and dashes — `[12]`, `[3, 7]`, `[8–12]`, `[14, 28–30]`. The group
 * may wrap onto the previous / next line.
 *
 * `linkLabelText` returns the linked text plus the word before it, enough to
 * read "Figure 3" / "Table 1" when only the number is linked.
 */

export type TextRectLike = {
	origin: { x: number; y: number };
	size: { width: number; height: number };
};

export type PageTextRect = {
	rect: TextRectLike;
	content: string;
};

export type CitationRange = { start: number; end: number };

export type BracketCitation = {
	/** Bibliography number under the hovered link. */
	entry: number;
	/**
	 * The `a–b` range the linked number belongs to (`[8–12]`, the `28–30` of
	 * `[14, 28–30]`), or null for a single entry.
	 */
	range: CitationRange | null;
};

const OPEN_BRACKETS = "[［";
const CLOSE_BRACKETS = "]］";
const DASHES = "-‐‑‒–—−";
/** Characters allowed between the brackets besides digits. */
const BODY_FILLER = new RegExp(`[\\s,${DASHES}]`);
const DIGIT = /\d/;
const NUMBER_OR_RANGE = `\\d+(?:\\s*[${DASHES}]\\s*\\d+)?`;
/** Wider "ranges" (`[1–2000]`) are not bibliography spans. */
const MAX_RANGE_SPAN = 30;
const BRACKET_BODY = new RegExp(
	`^\\s*${NUMBER_OR_RANGE}(?:\\s*,\\s*${NUMBER_OR_RANGE})*\\s*$`,
);

/**
 * Rects of similar height (body text, linked numbers) share a line only when
 * they overlap by this fraction — staggered baselines of two columns do not.
 */
const SAME_BASELINE_OVERLAP = 0.7;
/** Below this height ratio a rect is a superscript / comma / dash fragment… */
const FRAGMENT_HEIGHT_RATIO = 0.7;
/** …which joins a line on a looser overlap of its own height. */
const FRAGMENT_OVERLAP = 0.3;
/** A horizontal gap wider than this (× line height) splits columns. */
const SEGMENT_GAP = 1;
/** A gap wider than this (× line height) between runs counts as a space. */
const WORD_GAP = 0.15;
/** How far (× line height) the wrapped previous / next line may sit. */
const WRAP_LINE_REACH = 2.5;

type Glyph = { ch: string; x0: number; x1: number };

/** One line of text within one column: horizontally adjacent rects. */
export type LineSegment = {
	glyphs: Glyph[];
	left: number;
	right: number;
	/** Band of the tallest rect — the body text, not superscripts. */
	coreTop: number;
	coreBottom: number;
	height: number;
};

function verticalOverlap(
	aTop: number,
	aBottom: number,
	bTop: number,
	bBottom: number,
): number {
	return Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
}

function overlapX(
	a: { left: number; right: number },
	b: { left: number; right: number },
): number {
	return Math.min(a.right, b.right) - Math.max(a.left, b.left);
}

/** Spread each rect's characters evenly across its width. */
function glyphsOf(rect: PageTextRect): Glyph[] {
	const chars = [...rect.content];
	const step = rect.rect.size.width / chars.length;
	return chars.map((ch, i) => ({
		ch,
		x0: rect.rect.origin.x + i * step,
		x1: rect.rect.origin.x + (i + 1) * step,
	}));
}

/**
 * Group page rects into line segments: rects that share a line (vertical
 * overlap) and sit next to each other (no column-sized gap). Joining on both
 * keeps two columns with staggered baselines apart.
 */
export function groupLineSegments(
	textRects: readonly PageTextRect[],
): LineSegment[] {
	const rects = textRects
		.filter((r) => r.content.length > 0)
		.sort((a, b) => a.rect.origin.y - b.rect.origin.y);
	const parent = rects.map((_, i) => i);
	const find = (i: number): number => {
		let root = i;
		while (parent[root] !== root) root = parent[root] ?? root;
		parent[i] = root;
		return root;
	};
	for (let i = 0; i < rects.length; i++) {
		const a = rects[i];
		if (!a) continue;
		const aTop = a.rect.origin.y;
		const aBottom = aTop + a.rect.size.height;
		for (let j = i + 1; j < rects.length; j++) {
			const b = rects[j];
			if (!b || b.rect.origin.y > aBottom) break;
			const bBottom = b.rect.origin.y + b.rect.size.height;
			const minH = Math.max(
				0.5,
				Math.min(a.rect.size.height, b.rect.size.height),
			);
			const maxH = Math.max(a.rect.size.height, b.rect.size.height);
			const gap = -overlapX(
				{ left: a.rect.origin.x, right: a.rect.origin.x + a.rect.size.width },
				{ left: b.rect.origin.x, right: b.rect.origin.x + b.rect.size.width },
			);
			const required =
				minH / maxH >= FRAGMENT_HEIGHT_RATIO
					? SAME_BASELINE_OVERLAP
					: FRAGMENT_OVERLAP;
			if (
				verticalOverlap(aTop, aBottom, b.rect.origin.y, bBottom) >=
					required * minH &&
				gap <= SEGMENT_GAP * maxH
			) {
				parent[find(j)] = find(i);
			}
		}
	}
	const groups = new Map<number, PageTextRect[]>();
	rects.forEach((r, i) => {
		const root = find(i);
		const group = groups.get(root);
		if (group) group.push(r);
		else groups.set(root, [r]);
	});
	return [...groups.values()].map((group) => {
		group.sort((a, b) => a.rect.origin.x - b.rect.origin.x);
		const tallest = group.reduce((best, r) =>
			r.rect.size.height > best.rect.size.height ? r : best,
		);
		// A visible gap between runs reads as a space, so "Figure"+"3" stays
		// two words and "5"+"8" never fuses into 58.
		const glyphs: Glyph[] = [];
		for (const r of group) {
			const prev = glyphs[glyphs.length - 1];
			const next = glyphsOf(r);
			if (
				prev &&
				next[0] &&
				!/\s/.test(prev.ch) &&
				!/\s/.test(next[0].ch) &&
				r.rect.origin.x - prev.x1 > WORD_GAP * tallest.rect.size.height
			) {
				glyphs.push({ ch: " ", x0: prev.x1, x1: r.rect.origin.x });
			}
			glyphs.push(...next);
		}
		return {
			glyphs,
			left: Math.min(...group.map((r) => r.rect.origin.x)),
			right: Math.max(...group.map((r) => r.rect.origin.x + r.rect.size.width)),
			coreTop: tallest.rect.origin.y,
			coreBottom: tallest.rect.origin.y + tallest.rect.size.height,
			height: Math.max(0.5, tallest.rect.size.height),
		};
	});
}

/**
 * The wrapped line just above (`dir = -1`) or below (`dir = 1`) `current`, in
 * the same column.
 */
function adjacentSegment(
	segments: readonly LineSegment[],
	current: LineSegment,
	dir: -1 | 1,
): LineSegment | null {
	const reach = WRAP_LINE_REACH * current.height;
	let best: LineSegment | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const segment of segments) {
		if (segment === current || overlapX(current, segment) <= 0) continue;
		const distance = (segment.coreTop - current.coreTop) * dir;
		if (distance <= 0 || distance > reach || distance >= bestDistance) continue;
		best = segment;
		bestDistance = distance;
	}
	return best;
}

function isBodyChar(ch: string): boolean {
	return DIGIT.test(ch) || BODY_FILLER.test(ch);
}

/** Index of the digit glyph the link covers, preferring glyph centres inside it. */
function linkedDigitIndex(
	glyphs: readonly Glyph[],
	link: TextRectLike,
): number {
	const left = link.origin.x;
	const right = left + link.size.width;
	const mid = (left + right) / 2;
	let best = -1;
	let bestDist = Number.POSITIVE_INFINITY;
	glyphs.forEach((glyph, i) => {
		if (!DIGIT.test(glyph.ch)) return;
		const centre = (glyph.x0 + glyph.x1) / 2;
		const width = glyph.x1 - glyph.x0;
		if (centre < left - width || centre > right + width) return;
		const dist = Math.abs(centre - mid);
		if (dist < bestDist) {
			bestDist = dist;
			best = i;
		}
	});
	return best;
}

/** The line segment under a link whose body band it overlaps most. */
function linkSegment(
	segments: readonly LineSegment[],
	linkRect: TextRectLike,
): LineSegment | null {
	const link = {
		left: linkRect.origin.x,
		right: linkRect.origin.x + linkRect.size.width,
	};
	const top = linkRect.origin.y;
	const bottom = top + linkRect.size.height;
	let segment: LineSegment | null = null;
	let best = 0;
	for (const candidate of segments) {
		if (overlapX(link, candidate) < -0.5) continue;
		const overlap = verticalOverlap(
			top,
			bottom,
			candidate.coreTop,
			candidate.coreBottom,
		);
		if (overlap > best) {
			best = overlap;
			segment = candidate;
		}
	}
	return segment;
}

/**
 * The text under a link plus the word just before it — "Figure 3" when only
 * "3" is linked — without the rest of a long text run.
 */
export function linkLabelText(
	textRects: readonly PageTextRect[],
	linkRect: TextRectLike,
): string {
	const segment = linkSegment(groupLineSegments(textRects), linkRect);
	if (!segment) return "";
	const left = linkRect.origin.x;
	const right = left + linkRect.size.width;
	const glyphs = segment.glyphs;
	const inside = glyphs
		.map((g, i) => ({ i, centre: (g.x0 + g.x1) / 2 }))
		.filter(({ centre }) => centre >= left && centre <= right)
		.map(({ i }) => i);
	const first = inside[0];
	const last = inside[inside.length - 1];
	if (first == null || last == null) return "";
	// Step back over the gap, then over one word.
	let start = first;
	while (start > 0 && /\s/.test(glyphs[start - 1]?.ch ?? "")) start--;
	while (start > 0 && /\S/.test(glyphs[start - 1]?.ch ?? "")) start--;
	return glyphs
		.slice(start, last + 1)
		.map((g) => g.ch)
		.join("");
}

/**
 * Parse the `[…]` citation group around a link. Returns null unless the link
 * covers a number inside brackets whose body holds only numbers, commas,
 * whitespace and dashes.
 */
export function parseBracketCitation(
	textRects: readonly PageTextRect[],
	linkRect: TextRectLike,
): BracketCitation | null {
	const segments = groupLineSegments(textRects);
	const segment = linkSegment(segments, linkRect);
	if (!segment) return null;
	const glyphs = segment.glyphs;
	const digitAt = linkedDigitIndex(glyphs, linkRect);
	if (digitAt < 0) return null;

	// Walk left to the opening bracket, wrapping onto the previous line once.
	let before = "";
	let opened = false;
	for (let i = digitAt - 1; i >= 0 && !opened; i--) {
		const ch = glyphs[i]?.ch ?? "";
		if (OPEN_BRACKETS.includes(ch)) opened = true;
		else if (isBodyChar(ch)) before = ch + before;
		else return null;
	}
	if (!opened) {
		before = ` ${before}`;
		const prev = adjacentSegment(segments, segment, -1);
		const prevGlyphs = prev?.glyphs ?? [];
		for (let i = prevGlyphs.length - 1; i >= 0 && !opened; i--) {
			const ch = prevGlyphs[i]?.ch ?? "";
			if (OPEN_BRACKETS.includes(ch)) opened = true;
			else if (isBodyChar(ch)) before = ch + before;
			else return null;
		}
		if (!opened) return null;
	}

	// Walk right to the closing bracket, wrapping onto the next line once.
	let after = "";
	let closed = false;
	for (let i = digitAt; i < glyphs.length && !closed; i++) {
		const ch = glyphs[i]?.ch ?? "";
		if (CLOSE_BRACKETS.includes(ch)) closed = true;
		else if (isBodyChar(ch)) after += ch;
		else return null;
	}
	if (!closed) {
		const next = adjacentSegment(segments, segment, 1);
		after += " ";
		for (const glyph of next?.glyphs ?? []) {
			if (CLOSE_BRACKETS.includes(glyph.ch)) {
				closed = true;
				break;
			}
			if (!isBodyChar(glyph.ch)) return null;
			after += glyph.ch;
		}
		if (!closed) return null;
	}

	const body = before + after;
	if (!BRACKET_BODY.test(body)) return null;
	// The linked number: digits touching the hovered glyph on either side.
	const lead = /\d*$/.exec(before)?.[0] ?? "";
	const tail = /^\d+/.exec(after)?.[0] ?? "";
	const entry = Number.parseInt(lead + tail, 10);
	if (Number.isNaN(entry)) return null;
	return { entry, range: rangeAt(body, before.length) };
}

/** The `a–b` token of a bracket body covering `offset`, if it is a range. */
function rangeAt(body: string, offset: number): CitationRange | null {
	for (const match of body.matchAll(new RegExp(NUMBER_OR_RANGE, "g"))) {
		const start = match.index ?? 0;
		if (offset < start || offset >= start + match[0].length) continue;
		const [from, to] = match[0].split(new RegExp(`\\s*[${DASHES}]\\s*`));
		if (to == null) return null;
		const a = Number.parseInt(from ?? "", 10);
		const b = Number.parseInt(to, 10);
		return b > a && b - a <= MAX_RANGE_SPAN ? { start: a, end: b } : null;
	}
	return null;
}
