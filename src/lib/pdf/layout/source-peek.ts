/**
 * Read-only source context for a translated block.
 *
 * A middle click on a translated paragraph opens the English text of that
 * block plus its reading-order neighbours. Nothing is translated or cached:
 * the block's `source` is already in memory, and the sentence pairs only tell
 * which sentence the pointer was on.
 */

import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";

/** Layout markers for preserved formulas / style spans are not prose. */
const PROTECTED_TOKEN = /⟪(?:F|\/?S)\d+⟫/gu;

/** Source text without layout markers, so the card reads as the paper does. */
function displaySource(text: string): string {
	return text
		.replace(PROTECTED_TOKEN, " ")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

/** How many blocks on each side of the clicked one the card includes. */
export const SOURCE_PEEK_RADIUS = 2;

export type LayoutSourcePeekBlock = {
	id: string;
	source: string;
	sentences?: LayoutTranslateItem["sentences"];
};

export type LayoutSourcePeekSelection = {
	/** Contiguous reading-order window, same page only. */
	blocks: LayoutSourcePeekBlock[];
	/** Index of the clicked block inside `blocks`. */
	clickedIndex: number;
};

/**
 * The clicked block and up to {@link SOURCE_PEEK_RADIUS} blocks around it, in
 * reading order. Blocks never cross the page: `items` is already one page.
 * Returns null when the clicked id does not name a source-bearing block.
 */
export function layoutSourcePeekBlocks(
	items: readonly LayoutTranslateItem[],
	clickedId: string,
	radius: number = SOURCE_PEEK_RADIUS,
): LayoutSourcePeekSelection | null {
	if (!clickedId) return null;
	const byId = new Map<string, LayoutTranslateItem>();
	for (const item of items) {
		if (byId.has(item.id)) continue;
		const source = displaySource(item.source);
		if (!source) continue;
		byId.set(item.id, { ...item, source });
	}
	const usable = [...byId.values()].sort(
		(a, b) =>
			a.readingOrder - b.readingOrder ||
			a.bbox.y - b.bbox.y ||
			a.bbox.x - b.bbox.x,
	);
	const index = usable.findIndex((item) => item.id === clickedId);
	if (index < 0) return null;
	const reach = Math.max(0, Math.floor(radius));
	const start = Math.max(0, index - reach);
	const end = Math.min(usable.length, index + reach + 1);
	return {
		blocks: usable.slice(start, end).map((item) => ({
			id: item.id,
			source: item.source,
			...(item.sentences?.length ? { sentences: item.sentences } : {}),
		})),
		clickedIndex: index - start,
	};
}

export type LayoutSourceSentenceRange = { start: number; end: number };

/**
 * Character range of sentence `index` inside a block's source text, so the
 * card can tint the English sentence the pointer rested on. Quotes keep
 * line-break spacing and hyphens from the text layer while `source` is
 * normalized, so compare with whitespace ignored. A block holding a single
 * sentence falls back to the whole block; otherwise an unmatched sentence
 * leaves the text unhighlighted rather than guessing another sentence.
 */
export function layoutSourceSentenceRange(
	source: string,
	sentences: LayoutTranslateItem["sentences"] | undefined,
	index: number | null | undefined,
): LayoutSourceSentenceRange | null {
	if (index == null || !Number.isInteger(index)) return null;
	if (!sentences?.length || !source) return null;
	const sentence = sentences[index];
	if (!sentence) return null;
	const text = displaySource(sentence.source || sentence.quote);
	if (text) {
		const located = locateIgnoringWhitespace(source, text);
		if (located) return located;
	}
	if (sentences.length === 1) return { start: 0, end: source.length };
	return null;
}

/** Find `needle` in `haystack` ignoring whitespace, mapped back to source offsets. */
function locateIgnoringWhitespace(
	haystack: string,
	needle: string,
): LayoutSourceSentenceRange | null {
	const chars: string[] = [];
	const positions: number[] = [];
	for (let index = 0; index < haystack.length; index++) {
		const char = haystack[index];
		if (!char || /\s/.test(char)) continue;
		chars.push(char);
		positions.push(index);
	}
	const compact = chars.join("");
	const target = needle.replace(/\s+/g, "");
	if (!target) return null;
	const at = compact.indexOf(target);
	if (at < 0) return null;
	const first = positions[at];
	const last = positions[at + target.length - 1];
	if (first === undefined || last === undefined) return null;
	return { start: first, end: last + 1 };
}
