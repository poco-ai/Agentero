import { pointInBbox } from "@/lib/pdf/layout/hit-test";
import {
	groupReflowUnitsBySentence,
	layoutTranslateSentenceNodes,
} from "@/lib/pdf/layout/layout-sentences";
import { groupReadingLines } from "@/lib/pdf/layout/reading-order";
import type { LayoutTranslateSentence } from "@/lib/pdf/layout/types";
import { mergeClientRectsIntoLines } from "@/lib/pdf/layout/visible-selection-rects";

export type SentenceFractionRect = {
	x: number;
	y: number;
	w: number;
	h: number;
};

/** Union varying glyph tops and descenders into one flat band per line. */
export function sentenceHoverBands(
	rects: readonly SentenceFractionRect[],
	width = 1000,
	height = 1000,
): SentenceFractionRect[] {
	return mergeClientRectsIntoLines(
		rects.map((rect) => ({
			left: rect.x * width,
			top: rect.y * height,
			width: rect.w * width,
			height: rect.h * height,
		})),
	).map((rect) => ({
		x: rect.left / width,
		y: rect.top / height,
		w: rect.width / width,
		h: rect.height / height,
	}));
}

const sourceLineCache = new WeakMap<
	readonly SentenceFractionRect[],
	Map<string, ReturnType<typeof groupReadingLines<SentenceFractionRect>>>
>();

/** Source glyphs have tight ink bounds; add equal breathing room around each line. */
export function sourceSentenceHoverBands(
	rects: readonly SentenceFractionRect[],
	width: number,
	height: number,
	lineRects: readonly SentenceFractionRect[] = rects,
	paddingRatio = 0.2,
): SentenceFractionRect[] {
	if (!(width > 0) || !(height > 0)) return [];
	let sizes = sourceLineCache.get(lineRects);
	if (!sizes) {
		sizes = new Map();
		sourceLineCache.set(lineRects, sizes);
	}
	const sizeKey = `${width}:${height}`;
	let lines = sizes.get(sizeKey);
	if (!lines) {
		lines = groupReadingLines(lineRects, (rect) => ({
			x: rect.x * width,
			y: rect.y * height,
			width: rect.w * width,
			height: rect.h * height,
		}));
		if (sizes.size >= 4) sizes.clear();
		sizes.set(sizeKey, lines);
	}
	return lines.flatMap((line) => {
		const lineHeight = line.bottom - line.top;
		const segments: { left: number; right: number }[] = [];
		const selected = rects
			.filter((rect) => {
				const center = (rect.y + rect.h / 2) * height;
				return (
					center >= line.top &&
					center <= line.bottom &&
					line.items.some(
						(item) => rect.x + rect.w >= item.x && rect.x <= item.x + item.w,
					)
				);
			})
			.sort((a, b) => a.x - b.x);
		for (const rect of selected) {
			const left = rect.x * width;
			const right = (rect.x + rect.w) * width;
			const previous = segments.at(-1);
			if (previous && left - previous.right <= lineHeight * 2.5)
				previous.right = Math.max(previous.right, right);
			else segments.push({ left, right });
		}
		const padding = lineHeight * paddingRatio;
		return segments.map((segment) => ({
			x: segment.left / width,
			y: (line.top - padding) / height,
			w: (segment.right - segment.left) / width,
			h: (lineHeight + padding * 2) / height,
		}));
	});
}

type ReflowHoverUnit = {
	translatedOffset: number;
	x: number;
	y: number;
	width: number;
	height: number;
	fontSize: number;
	formula?: unknown;
};

type ReflowHoverItem = {
	id: string;
	bbox: { w: number; h: number };
	reflow?: { box: { w: number; h: number } };
	reflowLayout?: { units: readonly ReflowHoverUnit[] };
	translated?: string;
	sentences?: readonly { translated: string; display?: string }[];
};

/**
 * Translated line bands for one reflowed page, in page fractions.
 * Returns null when the page is still showing source glyphs. A block whose
 * pairs do not rebuild the translation contributes its whole placed paragraph.
 */
export function companionReflowSentenceBands(
	items: readonly ReflowHoverItem[],
	members: readonly {
		itemId: string;
		pageIndex: number;
		sentenceIndex: number;
	}[],
	pageIndex: number,
): SentenceFractionRect[] | null {
	const rects: SentenceFractionRect[] = [];
	let sawLayout = false;
	for (const member of members) {
		if (member.pageIndex !== pageIndex) continue;
		const item = items.find((entry) => entry.id === member.itemId);
		const units = item?.reflowLayout?.units;
		if (
			!item?.reflow ||
			!units?.length ||
			!(item.bbox.w > 0) ||
			!(item.bbox.h > 0)
		)
			continue;
		const pageWidth = item.reflow.box.w / item.bbox.w;
		const pageHeight = item.reflow.box.h / item.bbox.h;
		if (!(pageWidth > 0) || !(pageHeight > 0)) continue;
		sawLayout = true;
		const split = layoutTranslateSentenceNodes(
			item.translated ?? "",
			item.sentences,
		);
		const groups = groupReflowUnitsBySentence(
			item.translated ?? "",
			item.sentences,
			units,
		);
		const chosen = split
			? groups.filter((group) => group.index === member.sentenceIndex)
			: groups;
		for (const group of chosen) {
			for (const unit of group.units) {
				if (!(unit.width > 0) || !(unit.height > 0)) continue;
				const top = unit.y - (unit.formula ? unit.height : unit.fontSize * 0.8);
				rects.push({
					x: unit.x / pageWidth,
					y: top / pageHeight,
					w: unit.width / pageWidth,
					h: unit.height / pageHeight,
				});
			}
		}
	}
	if (!sawLayout) return null;
	return sentenceHoverBands(rects);
}

/** One painted slice of a sentence. Split boxes share `quote`. */
export type ElementSentenceMember = {
	itemId: string;
	pageIndex: number;
	sentenceIndex: number;
	quote: string;
};

export type ElementSentenceHit = {
	/** Same quote and translation, including slices on other pages. */
	key: string;
	quote: string;
	members: ElementSentenceMember[];
	/** Glyph boxes of the pointed block. Empty until those boxes are known. */
	rects: SentenceFractionRect[];
};

export type SentenceItem = {
	id: string;
	pageIndex: number;
	/** Layout box in page fractions. Hover uses it to skip the rest of the page. */
	bbox?: { x: number; y: number; w: number; h: number };
	sentences?: readonly Pick<LayoutTranslateSentence, "quote" | "translated">[];
};

const POINTER_BBOX_PAD = 0.006;
/** A box this large is the whole page, not a block the pointer is "inside". */
const TIGHT_PAGE_AREA = 0.85;

/**
 * Blocks on one page whose box contains the pointer.
 * A full-page box loses to any tighter block. No containing box falls back
 * to the whole page so a line that sits just outside its box still hits.
 */
export function sentenceItemsUnderPoint<T extends SentenceItem>(
	items: readonly T[],
	pageIndex: number,
	x: number,
	y: number,
): T[] {
	const onPage: T[] = [];
	const hits: T[] = [];
	const tight: T[] = [];
	for (const item of items) {
		if (item.pageIndex !== pageIndex) continue;
		onPage.push(item);
		const box = item.bbox;
		if (!box || !(box.w > 0) || !(box.h > 0)) {
			hits.push(item);
			tight.push(item);
			continue;
		}
		if (
			!pointInBbox(x, y, {
				x: box.x - POINTER_BBOX_PAD,
				y: box.y - POINTER_BBOX_PAD,
				w: box.w + POINTER_BBOX_PAD * 2,
				h: box.h + POINTER_BBOX_PAD * 2,
			})
		) {
			continue;
		}
		hits.push(item);
		if (box.w * box.h < TIGHT_PAGE_AREA) tight.push(item);
	}
	if (tight.length > 0) return tight;
	if (hits.length > 0) return hits;
	return onPage;
}

export type SentenceLocate =
	| { status: "sentence"; hit: ElementSentenceHit }
	| { status: "pending" }
	| { status: "element" };

function rectArea(rects: readonly SentenceFractionRect[]): number {
	let area = 0;
	for (const rect of rects) area += rect.w * rect.h;
	return area;
}

const sentenceHitBandCache = new WeakMap<
	readonly (readonly SentenceFractionRect[])[],
	SentenceFractionRect[][]
>();

/** Joined quotes of one block, used to spot a bbox that clipped a larger block. */
export function sentenceListText(item: SentenceItem): string {
	return (item.sentences ?? [])
		.map((sentence) => sentence.quote.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join(" ");
}

function isStrictSentencePrefix(shorter: string, longer: string): boolean {
	if (!shorter || shorter.length >= longer.length) return false;
	if (!longer.startsWith(shorter)) return false;
	return longer[shorter.length] === " ";
}

function sentenceBlockArea(item: SentenceItem): number {
	const box = item.bbox;
	if (!box || !(box.w > 0) || !(box.h > 0)) return Number.POSITIVE_INFINITY;
	return box.w * box.h;
}

/**
 * Drop a detection whose sentence list is only the start of a larger block.
 *
 * A clipped line box is smaller, so the minimum-area hit would light that
 * fragment and hide the real sentence. The larger block has to contain the
 * same point; this does not compare blocks the pointer missed.
 */
export function dropTruncatedSentencePrefixes<T extends SentenceItem>(
	items: readonly T[],
): T[] {
	const texts = items.map(sentenceListText);
	return items.filter((item, index) => {
		const text = texts[index] ?? "";
		if (!text) return true;
		const area = sentenceBlockArea(item);
		return !items.some((other, otherIndex) => {
			if (otherIndex === index || other.pageIndex !== item.pageIndex)
				return false;
			if (!(sentenceBlockArea(other) > area + 1e-12)) return false;
			return isStrictSentencePrefix(text, texts[otherIndex] ?? "");
		});
	});
}

/** Adjacent lines share a hit boundary at their midpoint; painted boxes stay tight. */
function sentenceHitBands(
	bands: readonly (readonly SentenceFractionRect[])[],
): SentenceFractionRect[][] {
	const cached = sentenceHitBandCache.get(bands);
	if (cached) return cached;
	const lines = groupReadingLines(bands.flat(), (rect) => ({
		x: rect.x * 1000,
		y: rect.y * 1000,
		width: rect.w * 1000,
		height: rect.h * 1000,
	}));
	const expanded = new Map<SentenceFractionRect, SentenceFractionRect>();
	lines.forEach((line, index) => {
		for (const rect of line.items) {
			const overlapsColumn = (neighbor: (typeof lines)[number]) =>
				neighbor.items.some(
					(other) => rect.x < other.x + other.w && other.x < rect.x + rect.w,
				);
			const previous = lines.slice(0, index).reverse().find(overlapsColumn);
			const next = lines.slice(index + 1).find(overlapsColumn);
			const top = previous
				? Math.min(line.top, (previous.bottom + line.top) / 2)
				: line.top;
			const bottom = next
				? Math.max(line.bottom, (line.bottom + next.top) / 2)
				: line.bottom;
			expanded.set(rect, { ...rect, y: top / 1000, h: (bottom - top) / 1000 });
		}
	});
	const result = bands.map((rects) =>
		rects.map((rect) => expanded.get(rect) ?? rect),
	);
	sentenceHitBandCache.set(bands, result);
	return result;
}

function chainKey(quote: string, translated: string): string {
	return `${quote}\u0000${translated}`;
}

/**
 * Merge sentence catalogs from panes that share one paper.
 * An empty publish must not erase the other pane. Equal counts keep the
 * later group so a fresher pane wins.
 */
export function mergeSentenceItems<T extends SentenceItem>(
	groups: readonly (readonly T[])[],
): T[] {
	const byId = new Map<string, T>();
	for (const group of groups) {
		for (const item of group) {
			const existing = byId.get(item.id);
			const nextPaired =
				item.sentences?.some((sentence) => sentence.translated.trim()) ?? false;
			const prevPaired =
				existing?.sentences?.some((sentence) => sentence.translated.trim()) ??
				false;
			const nextCount = item.sentences?.length ?? 0;
			const prevCount = existing?.sentences?.length ?? 0;
			if (
				!existing ||
				(nextPaired && !prevPaired) ||
				(nextPaired === prevPaired && nextCount >= prevCount)
			)
				byId.set(item.id, item);
		}
	}
	return [...byId.values()];
}

/**
 * Sentence under a point in one text element.
 * `glyphs` maps an item id to per-sentence boxes. A missing entry means the
 * page's text runs have not been read yet (`pending`). An empty sentence list
 * means that sentence was not found (`element` — keep the element frame).
 * `span` is the overlay sentence under the pointer, when the event target is
 * a `[data-sentence]` node.
 */
export function elementSentenceAtPoint(options: {
	items: readonly SentenceItem[];
	glyphs: ReadonlyMap<string, readonly (readonly SentenceFractionRect[])[]>;
	regionId: string;
	/** Source layout and translated paragraphs can have different IDs. */
	pageIndex?: number;
	x: number;
	y: number;
	span?: { itemId: string; sentenceIndex: number } | null;
}): SentenceLocate {
	const item =
		options.items.find((entry) => entry.id === options.regionId) ?? null;
	if (options.pageIndex != null && !options.span) {
		const candidates = dropTruncatedSentencePrefixes(
			sentenceItemsUnderPoint(
				options.items,
				options.pageIndex,
				options.x,
				options.y,
			),
		);
		const hits = candidates.flatMap((entry) => {
			const result = elementSentenceAtPoint({
				...options,
				regionId: entry.id,
				pageIndex: undefined,
			});
			return result.status === "sentence" ? [result] : [];
		});
		hits.sort(
			(left, right) => rectArea(left.hit.rects) - rectArea(right.hit.rects),
		);
		if (hits[0]) return hits[0];
		return candidates.some((entry) => !options.glyphs.has(entry.id))
			? { status: "pending" }
			: { status: "element" };
	}
	const sentences = item?.sentences ?? [];
	if (!item || sentences.length === 0) return { status: "element" };

	const span = options.span;
	const spanMatches =
		span != null &&
		span.itemId === item.id &&
		span.sentenceIndex >= 0 &&
		span.sentenceIndex < sentences.length;
	if (!spanMatches && !options.glyphs.has(item.id))
		return { status: "pending" };

	const boxes = options.glyphs.get(item.id);
	let sentenceIndex = spanMatches ? span.sentenceIndex : -1;
	if (!spanMatches) {
		let bestArea = Number.POSITIVE_INFINITY;
		boxes?.forEach((rects, index) => {
			if (!rects.some((rect) => pointInBbox(options.x, options.y, rect))) {
				return;
			}
			const area = rectArea(rects);
			if (area + 1e-12 < bestArea) {
				bestArea = area;
				sentenceIndex = index;
			}
		});
	}
	if (!spanMatches && sentenceIndex < 0 && boxes) {
		const hitBands = sentenceHitBands(boxes);
		let bestArea = Number.POSITIVE_INFINITY;
		hitBands.forEach((rects, index) => {
			if (!rects.some((rect) => pointInBbox(options.x, options.y, rect)))
				return;
			const area = rectArea(boxes[index] ?? []);
			if (area + 1e-12 < bestArea) {
				bestArea = area;
				sentenceIndex = index;
			}
		});
	}
	const sentence = sentences[sentenceIndex];
	if (!sentence?.quote.trim()) return { status: "element" };

	const key = chainKey(sentence.quote, sentence.translated);
	const members: ElementSentenceMember[] = [];
	for (const entry of options.items) {
		entry.sentences?.forEach((pair, index) => {
			if (chainKey(pair.quote, pair.translated) !== key) return;
			const quote = pair.quote.replace(/\s+/g, " ").trim();
			if (!quote) return;
			members.push({
				itemId: entry.id,
				pageIndex: entry.pageIndex,
				sentenceIndex: index,
				quote,
			});
		});
	}
	if (members.length === 0) return { status: "element" };
	const quote = sentence.quote.replace(/\s+/g, " ").trim();
	return {
		status: "sentence",
		hit: {
			key,
			quote,
			members,
			rects: (boxes?.[sentenceIndex] ?? []).map((rect) => ({ ...rect })),
		},
	};
}
