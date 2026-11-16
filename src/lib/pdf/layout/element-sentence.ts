import { pointInBbox } from "@/lib/pdf/layout/hit-test";
import type { LayoutTranslateSentence } from "@/lib/pdf/layout/types";

export type SentenceFractionRect = {
	x: number;
	y: number;
	w: number;
	h: number;
};

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
			const nextCount = item.sentences?.length ?? 0;
			const prevCount = existing?.sentences?.length ?? 0;
			if (!existing || nextCount >= prevCount) byId.set(item.id, item);
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
	x: number;
	y: number;
	span?: { itemId: string; sentenceIndex: number } | null;
}): SentenceLocate {
	const item =
		options.items.find((entry) => entry.id === options.regionId) ?? null;
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
