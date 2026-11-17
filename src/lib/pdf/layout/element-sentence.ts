import { pointInBbox } from "@/lib/pdf/layout/hit-test";
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
	sentences?: readonly Pick<LayoutTranslateSentence, "quote" | "translated">[];
};

export type SentenceLocate =
	| { status: "sentence"; hit: ElementSentenceHit }
	| { status: "pending" }
	| { status: "element" };

function rectArea(rects: readonly SentenceFractionRect[]): number {
	let area = 0;
	for (const rect of rects) area += rect.w * rect.h;
	return area;
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
		const hits = options.items
			.filter((entry) => entry.pageIndex === options.pageIndex)
			.flatMap((entry) => {
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
		return options.items.some(
			(entry) =>
				entry.pageIndex === options.pageIndex && !options.glyphs.has(entry.id),
		)
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
