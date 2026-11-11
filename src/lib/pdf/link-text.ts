/**
 * Read the page text around a hovered link from PDFium character geometry.
 *
 * Character advances and shared baseline ink bands preserve proportional
 * spacing without joining neighbouring lines. Rects are grouped into line
 * segments per column; engines without glyph data fall back to spreading
 * each text rect evenly. Geometry uses multiples of line height rather than
 * absolute points, so it holds for 8 pt footnotes and 12 pt body text alike.
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

import type { PdfGlyphObject } from "@embedpdf/models";

export type TextRectLike = {
	origin: { x: number; y: number };
	size: { width: number; height: number };
};

export type PageTextRect = {
	rect: TextRectLike;
	content: string;
};

/** Preserve character advances and word spaces, with a common ink band for
 * each baseline. Full font boxes overlap adjacent lines; individual tight
 * boxes make commas and narrow digits fall out of their own citation. */
export function pageTextRectsFromGlyphs(
	glyphs: readonly (PdfGlyphObject | null | undefined)[],
	text: readonly string[],
): PageTextRect[] {
	const bands = new Map<number, { top: number; bottom: number }>();
	// The text-object matrix can cover several lines or a rotated chart label.
	// Device-space advances describe the individual character's actual row.
	const baselineKey = (glyph: PdfGlyphObject): number =>
		Math.round((glyph.origin.y + glyph.size.height) * 2) / 2;
	const horizontal = (glyph: PdfGlyphObject) =>
		Math.abs(
			(glyph as PdfGlyphObject & { textAngle?: number }).textAngle ?? 0,
		) < 0.01;
	glyphs.forEach((glyph, index) => {
		if (
			!glyph ||
			!horizontal(glyph) ||
			!text[index]?.trim() ||
			!glyph.tightOrigin ||
			!glyph.tightSize?.height
		)
			return;
		const key = baselineKey(glyph);
		const band = bands.get(key) ?? { top: Infinity, bottom: -Infinity };
		band.top = Math.min(band.top, glyph.tightOrigin.y);
		band.bottom = Math.max(
			band.bottom,
			glyph.tightOrigin.y + glyph.tightSize.height,
		);
		bands.set(key, band);
	});
	return glyphs.flatMap((glyph, index) => {
		const content = text[index];
		if (
			!glyph ||
			!horizontal(glyph) ||
			!content ||
			/[\r\n]/.test(content) ||
			glyph.size.width <= 0 ||
			glyph.size.height <= 0
		)
			return [];
		const band = bands.get(baselineKey(glyph));
		return [
			{
				content,
				rect: {
					origin: { x: glyph.origin.x, y: band?.top ?? glyph.origin.y },
					size: {
						width: glyph.size.width,
						height: band ? band.bottom - band.top : glyph.size.height,
					},
				},
			},
		];
	});
}

export type CitationRange = { start: number; end: number };

export type BracketCitation = {
	/** Bibliography number under the hovered link. */
	entry: number;
	/**
	 * The `a–b` range the linked number belongs to (`[8–12]`, the `28–30` of
	 * `[14, 28–30]`), or null for a single entry.
	 */
	range: CitationRange | null;
	/** All numbers in the enclosing citation, including comma-separated items. */
	entries?: number[];
};

const OPEN_BRACKETS = "[［";
const CLOSE_BRACKETS = "]］";
// Keep the ASCII hyphen last when interpolating into a character class.
const DASHES = "‐‑‒–—−-";
/** Characters allowed between the brackets besides digits. */
const BODY_FILLER = new RegExp(`[\\s,${DASHES}]`);
const DIGIT = /\d/;
const NUMBER_OR_RANGE = `\\d+(?:\\s*[${DASHES}]\\s*\\d+)?`;
/** Wider "ranges" (`[1–2000]`) are not bibliography spans. */
const MAX_RANGE_SPAN = 30;
const BRACKET_BODY = new RegExp(
	`^\\s*${NUMBER_OR_RANGE}(?:\\s*,\\s*${NUMBER_OR_RANGE})*\\s*$`,
);
const NUMERIC_RUN = new RegExp(`^[\\d\\s,${DASHES}]+$`);

function citationEntries(body: string): number[] {
	const entries = new Set<number>();
	for (const match of body.matchAll(new RegExp(NUMBER_OR_RANGE, "g"))) {
		const range = rangeAt(body, match.index);
		const first = Number.parseInt(match[0], 10);
		for (let n = range?.start ?? first; n <= (range?.end ?? first); n++)
			entries.add(n);
	}
	return [...entries];
}

function citationGroup(body: string): { entries?: number[] } {
	const entries = citationEntries(body);
	return entries.length > 1 ? { entries } : {};
}

/** Individual hit tokens retain the entire enclosing citation's members. */
export function bracketCitationTokens(text: string): {
	start: number;
	end: number;
	citation: BracketCitation;
}[] {
	const result: ReturnType<typeof bracketCitationTokens> = [];
	for (const group of text.matchAll(/[[［]([^\]］]+)[\]］]/g)) {
		const body = group[1];
		if (!BRACKET_BODY.test(body)) continue;
		for (const token of body.matchAll(new RegExp(NUMBER_OR_RANGE, "g"))) {
			const start = group.index + 1 + token.index;
			result.push({
				start,
				end: start + token[0].length,
				citation: {
					entry: Number.parseInt(token[0], 10),
					range: rangeAt(body, token.index),
					...citationGroup(body),
				},
			});
		}
	}
	return result;
}

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
		.map((r) => {
			if (r.content.trim()) return r;
			// Synthetic spaces can inherit a multiline text object's height.
			// They may separate words, but cannot establish or connect baselines.
			const neighbours = textRects.filter(
				(other) =>
					other.content.trim() &&
					other.rect.size.height > 0 &&
					other.rect.size.height < r.rect.size.height * 0.65 &&
					Math.abs(other.rect.origin.x - r.rect.origin.x) <
						r.rect.size.height * 3 &&
					other.rect.origin.y <= r.rect.origin.y + 1 &&
					other.rect.origin.y + other.rect.size.height >= r.rect.origin.y,
			);
			const nearest = neighbours.sort(
				(a, b) =>
					Math.abs(a.rect.origin.x - r.rect.origin.x) -
					Math.abs(b.rect.origin.x - r.rect.origin.x),
			)[0];
			return nearest
				? {
						...r,
						rect: {
							origin: { x: r.rect.origin.x, y: nearest.rect.origin.y },
							size: {
								width: r.rect.size.width,
								height: nearest.rect.size.height,
							},
						},
					}
				: r;
		})
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
		// PDFium can synthesize a thin space at exactly the same advance as
		// the next glyph. It is not a word gap ("28" must not become "2 8").
		group = group.filter((r) => {
			if (r.content.trim()) return true;
			const mid = r.rect.origin.x + r.rect.size.width / 2;
			return !group.some(
				(other) =>
					other.content.trim() &&
					mid >= other.rect.origin.x &&
					mid < other.rect.origin.x + other.rect.size.width &&
					verticalOverlap(
						r.rect.origin.y,
						r.rect.origin.y + r.rect.size.height,
						other.rect.origin.y,
						other.rect.origin.y + other.rect.size.height,
					) > 0,
			);
		});
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

/** Continue a citation through an actual column boundary, never sideways
 * between neighbouring lines in the middle of two columns. */
function citationAdjacentSegment(
	segments: readonly LineSegment[],
	current: LineSegment,
	dir: -1 | 1,
): LineSegment | null {
	const adjacent = adjacentSegment(segments, current, dir);
	if (
		adjacent &&
		Math.abs(adjacent.coreTop - current.coreTop) <= current.height * 2
	)
		return adjacent;
	const peers = segments.filter(
		(line) =>
			Math.abs(line.left - current.left) < current.height * 2 &&
			line.height >= current.height * 0.8 &&
			line.right - line.left <=
				Math.max((current.right - current.left) * 1.6, current.height * 30),
	);
	if (peers.some((line) => (line.coreTop - current.coreTop) * dir > 0))
		return null;
	const right = Math.max(...peers.map((line) => line.right));
	const candidates = segments.filter(
		(line) =>
			line.height >= current.height * 0.8 &&
			(dir < 0
				? line.right < current.left && line.coreTop >= current.coreTop
				: line.left > right &&
					line.left - right < current.height * 12 &&
					line.coreTop <= current.coreTop),
	);
	if (!candidates.length) return null;
	const edge =
		dir < 0
			? Math.max(...candidates.map((line) => line.left))
			: Math.min(...candidates.map((line) => line.left));
	return (
		candidates
			.filter((line) => Math.abs(line.left - edge) < current.height * 2)
			.sort((a, b) => (a.coreTop - b.coreTop) * dir)[0] ?? null
	);
}

function isBodyChar(ch: string): boolean {
	return DIGIT.test(ch) || BODY_FILLER.test(ch);
}

/** Index of the digit glyph the link covers, preferring glyph centres inside it. */
function linkedDigitIndex(
	glyphs: readonly Glyph[],
	link: TextRectLike,
	pointerX?: number,
): number {
	const left = link.origin.x;
	const right = left + link.size.width;
	const mid =
		pointerX == null
			? (left + right) / 2
			: Math.max(left, Math.min(right, pointerX));
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
	includeContext = true,
): string {
	const segments = groupLineSegments(textRects);
	const segment = linkSegment(segments, linkRect);
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
	let label = glyphs
		.slice(start, last + 1)
		.map((g) => g.ch)
		.join("");
	const linked = glyphs
		.slice(first, last + 1)
		.map((g) => g.ch)
		.join("");
	if (!includeContext) return linked.trim();
	if (/^\s*\(?\s*\d/.test(linked)) {
		const prefix = glyphs
			.slice(0, first)
			.map((g) => g.ch)
			.join("")
			.match(/\b(?:Equations?|Eqs?)\.?\s*\(?\s*$/i)?.[0];
		if (prefix) label = prefix + linked;
	}
	if (/[图圖表]\s*$/.test(label)) {
		const suffix = glyphs
			.slice(last + 1)
			.map((g) => g.ch)
			.join("")
			.match(/^\s*\d+(?:\([a-z]\d*\))?/i)?.[0];
		if (suffix) label += suffix;
	}
	// Publishers often omit the repeated noun: “Figs. 4(a) and 4(b)”.
	// Only a connected list of panel numbers may borrow that shared prefix.
	if (/^\d+\([a-z]\)/i.test(linked)) {
		let before = glyphs
			.slice(0, first)
			.map((g) => g.ch)
			.join("");
		if (first === 0 || /^\s*(?:and|,)\s*$/.test(before)) {
			const previous = adjacentSegment(segments, segment, -1);
			before = `${previous?.glyphs.map((g) => g.ch).join("") ?? ""} ${before}`;
		}
		const shared = before.match(
			/\b(Figures?|Figs?\.?)\s+\d+\([a-z]\)(?:\s*(?:,\s*(?:and\s+)?|and\s+)\d+\([a-z]\))*\s*(?:,\s*(?:and\s+)?|and\s+)$/i,
		);
		if (shared) return `${shared[1]} ${linked}`;
	}
	if (
		first > start &&
		/^(?:Fig(?:ure)?\.?|Table|Tbl\.?|Eq(?:uation)?\.?|Alg(?:orithm)?\.?)\s*\(?\d/i.test(
			linked,
		) &&
		/\S/.test(glyphs[first - 1].ch)
	)
		label = `${glyphs
			.slice(start, first)
			.map((g) => g.ch)
			.join("")} ${linked}`;
	if (start === 0) {
		const previous = adjacentSegment(segments, segment, -1);
		const previousText = previous?.glyphs.map((g) => g.ch).join("") ?? "";
		const prefix = previousText.match(
			/\b(?:Fig(?:ure)?\.?|Table|Tbl\.?|Eq(?:uation)?\.?|Alg(?:orithm)?\.?)\s*$/i,
		)?.[0];
		if (prefix && first === 0 && /^\s*\(?\d/.test(label))
			label = `${prefix.trim()} ${label}`;
		const tail = previous?.glyphs
			.map((g) => g.ch)
			.join("")
			.match(/([A-Za-z]+)[\u00ad‐-]\s*$/)?.[1];
		if (tail) return `${tail}${label}`;
	}
	if (
		/\b(?:Fig(?:ure)?\.?|Table|Tbl\.?|Eq(?:uation)?\.?|Alg(?:orithm)?\.?)\s*$/i.test(
			label,
		)
	) {
		const next = adjacentSegment(segments, segment, 1);
		const number = next?.glyphs
			.map((g) => g.ch)
			.join("")
			.match(/^\s*(\d+[a-z]?)(?=[\s.,;()]|$)/i)?.[1];
		if (number) label += ` ${number}`;
	}
	return label.replace(/\u00ad/g, "");
}

/** Author-year papers often link only the year. Read its adjacent author
 * phrase in this column, retaining accents and institutional author names. */
export function authorYearLinkText(
	textRects: readonly PageTextRect[],
	linkRect: TextRectLike,
	previousPageText?: readonly PageTextRect[],
): string | null {
	const linked = linkLabelText(textRects, linkRect, false);
	const year = /^[\s(,;.]*((?:18|19|20)\d{2}[a-z]?)[\s),;.]*$/i.exec(
		linked,
	)?.[1];
	if (!year) return null;
	const segments = groupLineSegments(textRects);
	const segment = linkSegment(segments, linkRect);
	if (!segment) return null;
	let before = segment.glyphs
		.filter((g) => (g.x0 + g.x1) / 2 < linkRect.origin.x)
		.map((g) => g.ch)
		.join("");
	let current = segment;
	if (
		previousPageText?.length &&
		segment.coreTop < segment.height * 10 &&
		!segments.some(
			(line) => line.coreTop < segment.coreTop && overlapX(line, segment) > 0,
		)
	) {
		const body = groupLineSegments(previousPageText).filter(
			(line) =>
				line.right - line.left > line.height * 12 &&
				/\p{L}/u.test(line.glyphs.map((g) => g.ch).join("")),
		);
		const rightMargin = Math.max(...body.map((line) => line.right));
		const last = body
			.filter((line) => line.right > rightMargin - line.height * 3)
			.sort((a, b) => b.coreTop - a.coreTop)[0];
		if (last) before = `${last.glyphs.map((g) => g.ch).join("")} ${before}`;
	}
	// At a column break an author list can begin at the bottom of the left
	// column and finish at the top of the next one. Only join an unfinished
	// author conjunction, with no earlier line in the destination column.
	if (
		!segments.some(
			(line) =>
				line.coreTop < segment.coreTop &&
				Math.abs(line.left - segment.left) < segment.height * 2,
		)
	) {
		const previousColumn = citationAdjacentSegment(segments, segment, -1);
		if (
			previousColumn &&
			previousColumn.right < segment.left &&
			/(?:,\s*(?:and\s*)?|\band\s*|&\s*)$/.test(
				previousColumn.glyphs.map((g) => g.ch).join(""),
			)
		) {
			before = `${previousColumn.glyphs.map((g) => g.ch).join("")} ${before}`;
			current = previousColumn;
		}
	}
	// A long institutional author can occupy several lines. Keep the nearest
	// preceding lines in this column; the citation grammar below bounds the name.
	for (let i = 0; i < 3; i++) {
		const previous = adjacentSegment(segments, current, -1);
		if (!previous || current.coreTop - previous.coreTop > current.height * 2)
			break;
		before = `${previous.glyphs.map((g) => g.ch).join("")}\n${before}`;
		current = previous;
	}
	before = before.replace(/([\p{L}\p{M}])[\u00ad‐-]\s+(?=\p{Lu})/gu, "$1-");
	before = before.replace(/([\p{L}\p{M}])[\u00ad‐-]\s+(?=\p{Ll})/gu, "$1");
	before = before.replace(/([\p{L}\p{M}])et\s*al\./gu, "$1 et al.");
	before = before.replace(/\bet\s*al\./gu, "et al.");
	before = before.replace(/,(?=\p{Lu})/gu, ", ");
	before = before.replace(/\band(?=\p{Lu})/gu, "and ");
	before = before.replace(/([\p{L}\p{M}])and(?=\s+\p{Lu})/gu, "$1 and");
	before = before.replace(/\b(of|for|in|van|von|de|del|da)(?=\p{Lu})/gu, "$1 ");
	before = before.replace(/\s*&\s*/g, " & ");
	// Some fonts expose no character for a discretionary line-end hyphen.
	// This is restricted to a capitalized surname continued before "et al.".
	before = before.replace(
		/(\p{Lu}[\p{L}\p{M}]+)[ \t]*\n[ \t]*((?!(?:and|of|in|for|the|et)\b)\p{Ll}[\p{L}\p{M}]+)(?=\s*(?:et\s+al\.|[, (]*$))/gu,
		"$1$2",
	);
	before = before.replace(/\s+/g, " ");
	// The repeated-year form “Author (2020, 2021)” shares an author. Stop at
	// semicolons/closed parentheses so a different citation cannot lend its name.
	before = before.replace(/(?:\s*(?:18|19|20)\d{2}[a-z]?\s*,)+\s*$/i, "");
	// An article after a comma belongs to the introductory clause, not the
	// cited name. Do not strip particles inside institutional author names.
	before = before.replace(/^.*(?:[,.;]\s*|\band\s+)the\s+(?=\p{Lu})/u, "");
	const acronym = /\(([\p{Lu}\d][\p{Lu}\d .-]+)\)\s*[, (]*$/u.exec(before)?.[1];
	before = before.replace(
		/\(([\p{Lu}\d][\p{Lu}\d .-]+)\)(?=\s*[, (]*$)/u,
		"$1",
	);
	const authors =
		/(?<![\p{L}\p{M}\p{N}'’´`./-])([\p{Lu}][\p{L}\p{M}'’´`.-]*(?:(?:\s*,?\s+)(?:et\s+al\.?|and|&|van|von|de|del|da|of|the|for|in|[\p{Lu}][\p{L}\p{M}'’´`.-]*))*)\s*[, (]*$/u.exec(
			before,
		)?.[1];
	return authors
		? `${authors
				.replace(
					/^(?:(?:See|Also|Following|The|As|Cf|Further|Similarly|Conversely|However|Moreover|Furthermore|Additionally)[,.]?\s+)+/u,
					"",
				)
				.replace(/['’]s$/u, "")
				.replace(
					acronym
						? new RegExp(` ${acronym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)
						: /$^/,
					acronym ? ` (${acronym})` : "",
				)} (${year})`
		: null;
}

/** Collect native targets inside one printed author/year group. Geometry only
 * determines membership; each target retains its visible author and year. */
export function authorYearCitationGroup(
	textRects: readonly PageTextRect[],
	linkRect: TextRectLike,
	links: readonly { key: string; rect: TextRectLike }[],
): { key: string; citationText: string }[] {
	const segments = groupLineSegments(textRects);
	const hovered = linkSegment(segments, linkRect);
	if (!hovered) return [];
	const lines = [hovered];
	for (const dir of [-1, 1] as const) {
		let line = hovered;
		for (let i = 0; i < 10; i++) {
			const next = citationAdjacentSegment(segments, line, dir);
			if (!next) break;
			if (lines.includes(next)) break;
			if (dir < 0) lines.unshift(next);
			else lines.push(next);
			line = next;
		}
	}
	const chars = lines.flatMap((line) => [
		...line.glyphs.map((glyph) => ({ ...glyph, line })),
		{ ch: " ", x0: line.right, x1: line.right, line },
	]);
	const touches = (g: (typeof chars)[number], rect: TextRectLike) =>
		(g.x0 + g.x1) / 2 >= rect.origin.x &&
		(g.x0 + g.x1) / 2 <= rect.origin.x + rect.size.width &&
		verticalOverlap(
			g.line.coreTop,
			g.line.coreBottom,
			rect.origin.y,
			rect.origin.y + rect.size.height,
		) >=
			Math.min(g.line.coreBottom - g.line.coreTop, rect.size.height) * 0.5;
	const at = chars.findIndex((g) => /\d/.test(g.ch) && touches(g, linkRect));
	if (at < 0) return [];
	const text = chars.map((g) => g.ch).join("");
	const opens: number[] = [];
	for (let i = 0; i <= at; i++) {
		if (/[([]/.test(text[i])) opens.push(i);
		else if (/[)\]]/.test(text[i])) opens.pop();
	}
	const start = opens[opens.length - 1];
	if (start == null) return [];
	let end = at;
	while (end < text.length && !/[)\]]/.test(text[end])) end++;
	if (end === text.length) return [];
	const members = links
		.flatMap((candidate) => {
			const indices = chars.flatMap((g, i) =>
				i > start && i < end && touches(g, candidate.rect) ? [i] : [],
			);
			if (!indices.length) return [];
			const from = Math.min(...indices),
				to = Math.max(...indices) + 1;
			const year = /(?:18|19|20)\d{2}[a-z]?/i.exec(text.slice(from, to));
			if (!year) return [];
			const glyphs = chars.slice(
				from + year.index,
				from + year.index + year[0].length,
			);
			const line = glyphs[0].line;
			const x = Math.min(...glyphs.map((g) => g.x0));
			const citationText = authorYearLinkText(textRects, {
				origin: { x, y: line.coreTop },
				size: {
					width: Math.max(...glyphs.map((g) => g.x1)) - x,
					height: line.height,
				},
			});
			return citationText
				? [{ key: candidate.key, citationText, at: from }]
				: [];
		})
		.sort((a, b) => a.at - b.at);
	const seen = new Set<string>();
	return members.flatMap(({ key, citationText }) => {
		if (seen.has(key)) return [];
		seen.add(key);
		return [{ key, citationText }];
	});
}

/**
 * Parse the `[…]` citation group around a link. Returns null unless the link
 * covers a number inside brackets whose body holds only numbers, commas,
 * whitespace and dashes.
 */
export function parseBracketCitation(
	textRects: readonly PageTextRect[],
	linkRect: TextRectLike,
	pointer?: { x: number; y: number },
): BracketCitation | null {
	const segments = groupLineSegments(textRects);
	const segment = linkSegment(segments, linkRect);
	if (!segment) return null;
	const glyphs = segment.glyphs;
	const digitAt = linkedDigitIndex(glyphs, linkRect, pointer?.x);
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
	return { entry, range: rangeAt(body, before.length), ...citationGroup(body) };
}

/** Bare numeric links are citations only when raised above nearby prose.
 * The destination must still contain the numbered bibliography entry before
 * the caller displays it. Baseline section/figure numbers never use this path.
 */
export function parseSuperscriptCitation(
	textRects: readonly PageTextRect[],
	linkRect: TextRectLike,
	pointer?: { x: number; y: number },
): BracketCitation | null {
	const numeric = textRects.filter((r) => NUMERIC_RUN.test(r.content));
	const seed = numeric.find((r) => {
		const { origin: a, size: s } = r.rect;
		return (
			/\d/.test(r.content) &&
			a.x < linkRect.origin.x + linkRect.size.width &&
			a.x + s.width > linkRect.origin.x &&
			verticalOverlap(
				a.y,
				a.y + s.height,
				linkRect.origin.y,
				linkRect.origin.y + linkRect.size.height,
			) >
				Math.min(s.height, linkRect.size.height) * 0.5
		);
	});
	if (!seed) return null;
	const baseline = seed.rect.origin.y + seed.rect.size.height;
	const segments = groupLineSegments(
		numeric.filter(
			(r) =>
				Math.abs(r.rect.origin.y + r.rect.size.height - baseline) <=
				Math.max(1.5, seed.rect.size.height * 0.3),
		),
	);
	const segment = linkSegment(segments, linkRect);
	if (!segment) return null;
	const neighbours = textRects.flatMap((r) => {
		if (!/[\p{L}\p{N}]/u.test(r.content)) return [];
		const { origin: a, size: s } = r.rect;
		const rise = a.y + s.height - segment.coreBottom;
		const gap = Math.max(segment.left - a.x - s.width, a.x - segment.right);
		if (
			gap >= -1 &&
			gap <= s.height * 3 &&
			verticalOverlap(
				a.y,
				a.y + s.height,
				segment.coreTop,
				segment.coreBottom,
			) > 0
		)
			return [
				{
					gap,
					before: a.x + s.width <= segment.left + 1,
					raised:
						rise >= s.height * 0.2 &&
						rise <= s.height * 0.9 &&
						segment.coreTop <= a.y,
				},
			];
		return [];
	});
	// Use the closest prose, not any lower glyph within three font heights:
	// descenders and staggered adjacent columns otherwise turn Fig. 4 into ref 4.
	neighbours.sort((a, b) => a.gap - b.gap);
	if (!neighbours[0]?.raised || !neighbours.some((n) => n.before && n.raised))
		return null;
	let body = segment.glyphs.map((g) => g.ch).join("");
	let digit = linkedDigitIndex(segment.glyphs, linkRect, pointer?.x);
	if (digit < 0) return null;
	if (!BRACKET_BODY.test(body)) {
		// An adjacent exponent can share the raised baseline: “10⁶ ⁴¹”.
		// Whitespace-separated numbers are not a citation list; retain only
		// the numeric token under the native link, then verify its destination.
		const token = [...body.matchAll(new RegExp(NUMBER_OR_RANGE, "g"))].find(
			(m) => digit >= m.index && digit < m.index + m[0].length,
		);
		if (!token) return null;
		digit -= token.index;
		body = token[0];
	}
	const before = body.slice(0, digit),
		after = body.slice(digit);
	const entry = Number.parseInt(
		(/\d*$/.exec(before)?.[0] ?? "") + (/^\d+/.exec(after)?.[0] ?? ""),
		10,
	);
	return entry > 0
		? { entry, range: rangeAt(body, digit), ...citationGroup(body) }
		: null;
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
