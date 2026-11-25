/**
 * Which translated sentence an English highlight should color.
 *
 * The highlight already stores the English glyph boxes the reader marked.
 * Each sentence can be located to its own English glyph boxes. Overlap picks
 * the sentence across the page. Text is a stand-in for unlocated blocks.
 */

import type { HighlightColor } from "@/lib/pdf/highlight/palette";
import type { HighlightQuoteTint } from "@/lib/pdf/highlight/translated-geometry";
import type {
	PdfHighlightRect,
	PdfTextMarkupKind,
} from "@/lib/pdf/highlight/types";
import { sentenceIndexesCoveredByQuote } from "@/lib/pdf/layout/layout-sentences";
import { isLayoutTranslateItemPainted } from "@/lib/pdf/layout/layout-translate-reliable";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";

/** Sentence-level tint: the color and shape to paint plus the owning highlight. */
export type TranslateSentenceTint = {
	color: HighlightColor;
	shape: PdfTextMarkupKind;
	highlightId: string;
};

/** Minimum share of the best overlap or of the sentence's own glyph area. */
const MIN_OVERLAP_SHARE = 0.2;

function intersectionArea(a: PdfHighlightRect, b: PdfHighlightRect): number {
	const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
	const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
	if (width <= 0 || height <= 0) return 0;
	return width * height;
}

/**
 * Sentence indexes whose English boxes meet the highlight.
 * A box that only clips the neighbor's edge stays out.
 */
export function sentenceIndexesOverlappingHighlight(
	sentenceRects: readonly (readonly PdfHighlightRect[] | undefined)[],
	highlightRects: readonly PdfHighlightRect[],
): number[] {
	if (!highlightRects.length) return [];
	const areas = sentenceRects.map((rects) => {
		let overlap = 0;
		let area = 0;
		for (const sentence of rects ?? []) {
			area += sentence.w * sentence.h;
			for (const highlight of highlightRects) {
				overlap += intersectionArea(sentence, highlight);
			}
		}
		return { overlap, area };
	});
	const best = areas.reduce((max, { overlap }) => Math.max(max, overlap), 0);
	if (best <= 0) return [];
	const indexes: number[] = [];
	areas.forEach(({ overlap, area }, index) => {
		// A short sentence can be covered even beside a much longer one.
		if (overlap > 0 && overlap >= Math.min(best, area) * MIN_OVERLAP_SHARE) {
			indexes.push(index);
		}
	});
	return indexes;
}

/** Use geometry across the page, with quote matching for unlocated blocks. */
export function sentenceIndexesForHighlightTint(options: {
	sentences: readonly { quote: string }[] | undefined;
	quote: string;
	sentenceRects:
		| readonly (readonly PdfHighlightRect[] | undefined)[]
		| undefined;
	highlightRects: readonly PdfHighlightRect[] | undefined;
}): number[] {
	const { sentenceRects, highlightRects } = options;
	const byQuote = sentenceIndexesCoveredByQuote(
		options.sentences ?? [],
		options.quote,
	);
	if (
		!highlightRects?.length ||
		!sentenceRects?.some((rects) => rects?.length)
	) {
		return byQuote;
	}
	return [
		...sentenceIndexesOverlappingHighlight(sentenceRects, highlightRects),
		...byQuote.filter((index) => sentenceRects[index] === undefined),
	];
}

/**
 * Sentence → tint map for the translated overlay. One shared source for both
 * painting the tint and resolving a click back to the owning highlight.
 */
export function sentenceHighlightTints(options: {
	layoutItems?: readonly LayoutTranslateItem[];
	highlightQuotes?: readonly HighlightQuoteTint[];
	sentenceRectsByItemId?: ReadonlyMap<
		string,
		readonly (readonly PdfHighlightRect[])[]
	>;
}): Map<string, ReadonlyMap<number, TranslateSentenceTint>> {
	const byItem = new Map<string, Map<number, TranslateSentenceTint>>();
	const quotes = options.highlightQuotes;
	const items = options.layoutItems;
	if (!quotes?.length || !items?.length) return byItem;
	const sentences = items.flatMap((item) => {
		if (!isLayoutTranslateItemPainted(item) || !item.sentences?.length)
			return [];
		const rects = options.sentenceRectsByItemId?.get(item.id);
		const located = rects?.some((sentence) => sentence.length > 0);
		return item.sentences.map(({ quote }, index) => ({
			itemId: item.id,
			index,
			quote,
			rects: located ? (rects?.[index] ?? []) : undefined,
		}));
	});
	const sentenceRects = sentences.map(({ rects }) => rects);
	for (const highlight of quotes) {
		const matched = sentenceIndexesForHighlightTint({
			sentences,
			quote: highlight.quote,
			sentenceRects,
			highlightRects: highlight.rects,
		});
		for (const match of matched) {
			const { itemId, index } = sentences[match];
			let tints = byItem.get(itemId);
			if (!tints) {
				tints = new Map();
				byItem.set(itemId, tints);
			}
			if (!tints.has(index)) {
				tints.set(index, {
					color: highlight.color,
					shape: highlight.shape,
					highlightId: highlight.id,
				});
			}
		}
	}
	return byItem;
}

/**
 * Highlight IDs on a page that have an active translated visual replacement.
 *
 * A highlight is suppressed from the English annotation layer only when:
 * 1. It was recorded directly on the translation overlay (has `translatedPaints`), or
 * 2. It matches at least one sentence in an actively painted layout translation block.
 *
 * Highlights outside translated blocks (references, algorithms, untranslated
 * sections) keep their English annotation rendering and annotation menu.
 */
export function resolveTranslatedHighlightIds(options: {
	translatedPaints?: readonly { id: string }[];
	highlightQuotes?: readonly HighlightQuoteTint[];
	layoutItems?: readonly LayoutTranslateItem[];
	sentenceRectsByItemId?: ReadonlyMap<
		string,
		readonly (readonly PdfHighlightRect[])[]
	>;
}): Set<string> {
	const resolved = new Set<string>();
	if (options.translatedPaints) {
		for (const paint of options.translatedPaints) {
			resolved.add(paint.id);
		}
	}
	for (const tints of sentenceHighlightTints(options).values()) {
		for (const tint of tints.values()) resolved.add(tint.highlightId);
	}
	return resolved;
}
