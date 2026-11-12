/**
 * Which translated sentence an English highlight should color.
 *
 * The highlight already stores the English glyph boxes the reader marked.
 * Each sentence can be located to its own English glyph boxes. Overlap picks
 * the sentence. Text is only a stand-in until those boxes have been read.
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

/** A sentence this much smaller than the best overlap is a border sliver. */
const MIN_SHARE_OF_BEST = 0.2;

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
	sentenceRects: readonly (readonly PdfHighlightRect[])[],
	highlightRects: readonly PdfHighlightRect[],
): number[] {
	if (!highlightRects.length) return [];
	const areas = sentenceRects.map((rects) => {
		let area = 0;
		for (const sentence of rects) {
			for (const highlight of highlightRects) {
				area += intersectionArea(sentence, highlight);
			}
		}
		return area;
	});
	const best = areas.reduce((max, area) => Math.max(max, area), 0);
	if (best <= 0) return [];
	const cutoff = best * MIN_SHARE_OF_BEST;
	const indexes: number[] = [];
	areas.forEach((area, index) => {
		if (area >= cutoff) indexes.push(index);
	});
	return indexes;
}

/**
 * Prefer glyph-box overlap. Fall back to an exact quote match when this
 * block's sentences have not been located on the text layer yet.
 */
export function sentenceIndexesForHighlightTint(options: {
	sentences: readonly { quote: string }[] | undefined;
	quote: string;
	sentenceRects: readonly (readonly PdfHighlightRect[])[] | undefined;
	highlightRects: readonly PdfHighlightRect[] | undefined;
}): number[] {
	const sentences = options.sentences ?? [];
	const highlightRects = options.highlightRects ?? [];
	const located =
		options.sentenceRects?.some((rects) => rects.length > 0) ?? false;
	if (located && highlightRects.length > 0 && options.sentenceRects) {
		return sentenceIndexesOverlappingHighlight(
			options.sentenceRects,
			highlightRects,
		);
	}
	return sentenceIndexesCoveredByQuote(sentences, options.quote);
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
	const byItem = new Map<string, ReadonlyMap<number, TranslateSentenceTint>>();
	const quotes = options.highlightQuotes;
	const items = options.layoutItems;
	if (!quotes?.length || !items?.length) return byItem;
	for (const item of items) {
		if (!isLayoutTranslateItemPainted(item) || !item.sentences?.length) {
			continue;
		}
		const tints = new Map<number, TranslateSentenceTint>();
		for (const quote of quotes) {
			const matchedIndexes = sentenceIndexesForHighlightTint({
				sentences: item.sentences,
				quote: quote.quote,
				sentenceRects: options.sentenceRectsByItemId?.get(item.id),
				highlightRects: quote.rects,
			});
			for (const index of matchedIndexes) {
				if (!tints.has(index)) {
					tints.set(index, {
						color: quote.color,
						shape: quote.shape,
						highlightId: quote.id,
					});
				}
			}
		}
		if (tints.size > 0) byItem.set(item.id, tints);
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
