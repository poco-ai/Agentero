import {
	type Character,
	type Paragraph,
	reflowDisplayText,
} from "@/lib/pdf/reflow/types";
/**
 * Resolve a translation-overlay selection to English sentence quotes and the
 * PDF text-layer boxes that should carry the annotation.
 *
 * The overlay selection stays on the translated spans. Highlight, note, and
 * chat store the English sentences. Copy keeps the visible translation.
 */

import type { Rect } from "@embedpdf/models";
import {
	joinTranslatedDisplays,
	normalizeSentenceKey,
} from "@/lib/pdf/layout/layout-sentences";
import {
	orderByReadingLine,
	type ReadingBox,
} from "@/lib/pdf/layout/reading-order";
import type { LayoutTranslateSentence } from "@/lib/pdf/layout/types";

export type TranslationBlockRef = {
	reflow?: Paragraph;
	id: string;
	pageIndex: number;
	bbox: { x: number; y: number; w: number; h: number };
	source: string;
	raw?: string;
	translated?: string;
	sentences?: LayoutTranslateSentence[];
};

/** One selected span, or a whole block when it has no sentence spans. */
export type TranslationSpanHit = {
	itemId: string;
	sentenceIndex: number | null;
};

export type TranslationPagePick = {
	glyphRects?: Rect[];
	pageIndex: number;
	bbox: TranslationBlockRef["bbox"];
	/** Text-layer slice to search on this page. */
	locateText: string;
	/** The whole box may be used only when all of this member is selected. */
	wholeBlock: boolean;
};

export type TranslationSelection = {
	copyText: string;
	quote: string;
	paired: string;
	pages: TranslationPagePick[];
};

function memberLocateText(block: string, quote: string): string {
	const key = normalizeSentenceKey(quote);
	if (!key || !block) return "";
	if (block.includes(key)) return key;
	if (key.includes(block)) return block;
	for (let len = Math.min(block.length, key.length); len >= 8; len--) {
		const suffix = block.slice(block.length - len);
		if (key.startsWith(suffix)) return suffix;
		const prefix = block.slice(0, len);
		if (key.endsWith(prefix)) return prefix;
	}
	return "";
}

function characterRects(characters: readonly Character[]): Rect[] {
	return characters
		.filter((c) => c.text.trim())
		.map(({ visualBox: { x, y, w, h } }) => ({
			origin: { x, y },
			size: { width: w, height: h },
		}));
}

/** Match the paragraph's reading-order text back to its PDF glyphs. Source
 * offsets can differ from glyph indexes after inserted spaces, line-end
 * dehyphenation or ligature expansion. */
function reflowSentenceRects(
	paragraph: Paragraph,
	parts: readonly string[],
): (Rect[] | undefined)[] {
	for (const ignoreHyphens of [false, true]) {
		const key = (text: string) =>
			text
				.normalize("NFKD")
				.replace(ignoreHyphens ? /[\s\u00ad-]/g : /[\s\u00ad]/g, "");
		const refs: number[] = [];
		const text = paragraph.characters
			.map((character, index) => {
				const value = key(character.text);
				for (let i = 0; i < value.length; i++) refs.push(index);
				return value;
			})
			.join("");
		if (text !== key(paragraph.source)) continue;
		let cursor = 0;
		return parts.map((part) => {
			const needle = key(part);
			if (!needle) return undefined;
			const start = text.indexOf(needle, cursor);
			if (start < 0) return undefined;
			cursor = start + needle.length;
			const first = refs[start];
			const last = refs[cursor - 1];
			return characterRects(paragraph.characters.slice(first, last + 1));
		});
	}
	return [];
}

/**
 * Turn span hits into the English quote, the paired translation, and one
 * locate requests for its source fragments. A split sentence is quoted once.
 */
export function translationSelectionFromHits(
	hits: readonly TranslationSpanHit[],
	items: readonly TranslationBlockRef[],
	targetLang: string,
	copyText: string,
): TranslationSelection | null {
	if (!hits.length || !copyText.trim()) return null;
	const byId = new Map(items.map((item) => [item.id, item]));
	const groups: { itemId: string; indexes: (number | null)[] }[] = [];
	for (const hit of hits) {
		const last = groups[groups.length - 1];
		if (last?.itemId === hit.itemId) last.indexes.push(hit.sentenceIndex);
		else groups.push({ itemId: hit.itemId, indexes: [hit.sentenceIndex] });
	}
	const sentenceQuotes: string[] = [];
	const pairedParts: string[] = [];
	const seenSplitSentences = new Map<string, string>();
	const pages: TranslationPagePick[] = [];
	for (const group of groups) {
		const item = byId.get(group.itemId);
		if (!item) continue;
		const wholeBlock = group.indexes.includes(null);
		const chosen = wholeBlock
			? []
			: [...new Set(group.indexes)].flatMap((index) => {
					if (index === null) return [];
					const sentence = item.sentences?.[index];
					return sentence?.quote ? [{ index, sentence }] : [];
				});
		if (!wholeBlock && !chosen.length) continue;
		const pairs = chosen.length
			? chosen.map(({ sentence }) => sentence)
			: [
					{
						quote: item.reflow?.source ?? item.source,
						translated: item.translated ?? "",
						display: undefined,
					},
				];
		for (const { quote, translated, display } of pairs) {
			if (!quote.trim()) continue;
			if (display !== undefined) {
				const key = `${quote}\u0000${translated}`;
				const prior = seenSplitSentences.get(key);
				if (prior && prior !== item.id) continue;
				seenSplitSentences.set(key, item.id);
			}
			sentenceQuotes.push(quote);
			const text = (
				item.reflow ? reflowDisplayText(item.reflow, translated) : translated
			).trim();
			if (text) pairedParts.push(text);
		}
		const blockText = normalizeSentenceKey(
			item.raw || item.reflow?.source || item.source,
		);
		const picks = chosen.length
			? (item.sentences ?? []).map((sentence) =>
					memberLocateText(blockText, sentence.quote),
				)
			: [];
		const sentenceRects =
			item.reflow && picks.length
				? reflowSentenceRects(item.reflow, picks)
				: [];
		for (const index of chosen.length
			? chosen.map(({ index }) => index)
			: [null]) {
			const locateText =
				index === null
					? blockText
					: picks[index] ||
						normalizeSentenceKey(item.sentences?.[index]?.quote ?? "");
			pages.push({
				pageIndex: item.pageIndex,
				bbox: item.bbox,
				locateText,
				wholeBlock: index === null || picks[index] === blockText,
				glyphRects:
					index === null && item.reflow
						? characterRects(item.reflow.characters)
						: index === null
							? undefined
							: sentenceRects[index],
			});
		}
	}
	const quote = sentenceQuotes.join(" ");
	if (!quote || pages.length === 0) return null;
	return {
		copyText: copyText.trim(),
		quote,
		paired: joinTranslatedDisplays(pairedParts, targetLang),
		pages,
	};
}

/**
 * Text of `element` that `range` actually covers.
 *
 * Chinese sentence spans sit against each other with no gap node. A selection
 * that starts on the boundary is reported by `intersectsNode` as also hitting
 * the previous span, which then anchors that previous English sentence.
 * Boundary contact with no characters does not count.
 */
export function selectedTextWithin(range: Range, element: HTMLElement): string {
	const nodeRange = document.createRange();
	try {
		nodeRange.selectNodeContents(element);
		// Constant names are this-point to source-point, but the spec pairs
		// END_TO_START with (this start, source end) and START_TO_END with
		// (this end, source start). A shared boundary has no characters.
		const startBeforeNodeEnd =
			range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0;
		const endAfterNodeStart =
			range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0;
		if (!startBeforeNodeEnd || !endAfterNodeStart) return "";
		const slice = range.cloneRange();
		if (slice.compareBoundaryPoints(Range.START_TO_START, nodeRange) < 0) {
			slice.setStart(nodeRange.startContainer, nodeRange.startOffset);
		}
		if (slice.compareBoundaryPoints(Range.END_TO_END, nodeRange) > 0) {
			slice.setEnd(nodeRange.endContainer, nodeRange.endOffset);
		}
		return slice.collapsed ? "" : slice.toString();
	} catch {
		return "";
	}
}

/** Span hits inside `root` covered by `range`, in document order. */
export function translationHitsFromRange(
	range: Range,
	root: ParentNode,
): TranslationSpanHit[] {
	if (range.collapsed) return [];
	const hits: TranslationSpanHit[] = [];
	for (const block of root.querySelectorAll<HTMLElement>(
		"[data-layout-item]",
	)) {
		const itemId = block.getAttribute("data-layout-item");
		if (!itemId || !range.intersectsNode(block)) continue;
		const spans = block.querySelectorAll<HTMLElement>("[data-sentence]");
		if (!spans.length && selectedTextWithin(range, block).trim())
			hits.push({ itemId, sentenceIndex: null });
		for (const span of spans) {
			const sentenceIndex = Number(span.getAttribute("data-sentence"));
			if (
				Number.isInteger(sentenceIndex) &&
				selectedTextWithin(range, span).trim()
			)
				hits.push({ itemId, sentenceIndex });
		}
	}
	return hits;
}

type TextPiece = { text: string; rect: Rect };

type PieceRef = { piece: number; offset: number };

function centerInBbox(
	rect: Rect,
	bbox: { x: number; y: number; w: number; h: number },
	pageWidth: number,
	pageHeight: number,
): boolean {
	const cx = (rect.origin.x + rect.size.width / 2) / pageWidth;
	const cy = (rect.origin.y + rect.size.height / 2) / pageHeight;
	return (
		cx >= bbox.x &&
		cx <= bbox.x + bbox.w &&
		cy >= bbox.y &&
		cy <= bbox.y + bbox.h
	);
}

function pieceReadingBox(piece: TextPiece): ReadingBox {
	return {
		x: piece.rect.origin.x,
		y: piece.rect.origin.y,
		width: piece.rect.size.width,
		height: piece.rect.size.height,
	};
}

/**
 * Same join as the layout text that sentences were cut from: trim each run,
 * separate runs with one space, in baseline reading order.
 */
function joinedPieces(pieces: readonly TextPiece[]): {
	text: string;
	refs: PieceRef[];
	trimmed: string[];
} {
	let text = "";
	const refs: PieceRef[] = [];
	const trimmed: string[] = [];
	const ordered = orderByReadingLine(
		pieces.map((piece, index) => ({ piece, index })),
		(item) => pieceReadingBox(item.piece),
	);
	for (const { piece, index } of ordered) {
		const value = piece.text.replace(/\s+/g, " ").trim();
		trimmed[index] = value;
		if (!value) continue;
		if (text) {
			text += " ";
			refs.push({ piece: -1, offset: -1 });
		}
		for (let offset = 0; offset < value.length; offset++) {
			text += value[offset] ?? "";
			refs.push({ piece: index, offset });
		}
	}
	return { text, refs, trimmed };
}

/** Drop a line-break hyphen (`repre- sentation`) so both sides can still meet. */
function foldHyphenBreak(text: string): { text: string; map: number[] } {
	let index = 0;
	const out: string[] = [];
	const map: number[] = [];
	while (index < text.length) {
		const ch = text[index] ?? "";
		if (
			(ch === "-" || ch === "\u00ad") &&
			index + 1 < text.length &&
			/\s/.test(text[index + 1] ?? "")
		) {
			index += 1;
			while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;
			continue;
		}
		if (ch === "\u00ad") {
			index += 1;
			continue;
		}
		out.push(ch);
		map.push(index);
		index += 1;
	}
	return { text: out.join(""), map };
}

function rectsForPieceRange(
	pieces: readonly TextPiece[],
	trimmed: readonly string[],
	refs: readonly PieceRef[],
	start: number,
	end: number,
): Rect[] {
	const covered = new Map<number, { start: number; end: number }>();
	for (let index = start; index < end; index++) {
		const ref = refs[index];
		if (!ref || ref.piece < 0 || ref.offset < 0) continue;
		const current = covered.get(ref.piece);
		if (!current) {
			covered.set(ref.piece, { start: ref.offset, end: ref.offset + 1 });
		} else {
			current.start = Math.min(current.start, ref.offset);
			current.end = Math.max(current.end, ref.offset + 1);
		}
	}
	const rects: Rect[] = [];
	for (const [pieceIndex, range] of covered) {
		const piece = pieces[pieceIndex];
		const length = trimmed[pieceIndex]?.length ?? 0;
		if (!piece || length <= 0) continue;
		if (range.start <= 0 && range.end >= length) {
			rects.push(piece.rect);
			continue;
		}
		const unit = piece.rect.size.width / length;
		const from = Math.max(0, range.start);
		const to = Math.min(length, range.end);
		rects.push({
			origin: {
				x: piece.rect.origin.x + from * unit,
				y: piece.rect.origin.y,
			},
			size: {
				width: Math.max(unit * (to - from), 0.4),
				height: piece.rect.size.height,
			},
		});
	}
	return rects;
}

function matchJoined(
	pieces: readonly TextPiece[],
	quote: string,
): Rect[] | null {
	const needle = normalizeSentenceKey(quote);
	if (!needle) return null;
	const joined = joinedPieces(pieces);
	const start = joined.text.indexOf(needle);
	if (start < 0) return null;
	const rects = rectsForPieceRange(
		pieces,
		joined.trimmed,
		joined.refs,
		start,
		start + needle.length,
	);
	return rects.length > 0 ? rects : null;
}

function matchFolded(
	pieces: readonly TextPiece[],
	quote: string,
): Rect[] | null {
	const joined = joinedPieces(pieces);
	const hay = foldHyphenBreak(joined.text);
	const needle = foldHyphenBreak(normalizeSentenceKey(quote));
	if (!needle.text) return null;
	const start = hay.text.indexOf(needle.text);
	if (start < 0) return null;
	const from = hay.map[start];
	const to = hay.map[start + needle.text.length - 1];
	if (from == null || to == null) return null;
	const rects = rectsForPieceRange(
		pieces,
		joined.trimmed,
		joined.refs,
		from,
		to + 1,
	);
	return rects.length > 0 ? rects : null;
}

function sliceByBlockOffset(
	pieces: readonly TextPiece[],
	quote: string,
	blockText: string,
): Rect[] | null {
	const block = normalizeSentenceKey(blockText);
	const needle = normalizeSentenceKey(quote);
	if (!block || !needle) return null;
	const at = block.indexOf(needle);
	if (at < 0) return null;
	const joined = joinedPieces(pieces);
	const length = joined.text.length;
	if (length === 0) return null;
	const start = Math.min(length - 1, Math.floor((at / block.length) * length));
	const end = Math.max(
		start + 1,
		Math.ceil(((at + needle.length) / block.length) * length),
	);
	const rects = rectsForPieceRange(
		pieces,
		joined.trimmed,
		joined.refs,
		start,
		Math.min(length, end),
	);
	return rects.length > 0 ? rects : null;
}

/**
 * Glyph boxes for one sentence inside a layout block.
 *
 * Runs are limited to the block and joined in reading order, the same way the
 * sentence quote was cut. A miss does not paint every glyph in the block.
 */
export function locateQuoteInBlock(options: {
	quote: string;
	runs: readonly TextPiece[];
	pageWidth: number;
	pageHeight: number;
	bbox: { x: number; y: number; w: number; h: number };
	blockText?: string;
}): Rect[] {
	const { quote, runs, pageWidth, pageHeight, bbox, blockText } = options;
	if (!(pageWidth > 0) || !(pageHeight > 0)) return [];
	const inside = runs.filter(
		(run) =>
			Boolean(run.text.trim()) &&
			centerInBbox(run.rect, bbox, pageWidth, pageHeight),
	);
	if (!inside.length) return [];
	return (
		matchJoined(inside, quote) ??
		matchFolded(inside, quote) ??
		(blockText ? sliceByBlockOffset(inside, quote, blockText) : null) ??
		[]
	);
}

export function bboxToPageRect(
	bbox: { x: number; y: number; w: number; h: number },
	pageWidth: number,
	pageHeight: number,
): Rect {
	return {
		origin: { x: bbox.x * pageWidth, y: bbox.y * pageHeight },
		size: { width: bbox.w * pageWidth, height: bbox.h * pageHeight },
	};
}

/**
 * Glyph boxes for `quote` inside `bbox`. A sentence that is not found stays
 * empty instead of expanding to every glyph in the block.
 */
export function locateQuoteGlyphs(options: {
	quote: string;
	glyphs: readonly { content: string; rect: Rect }[];
	pageWidth: number;
	pageHeight: number;
	bbox: { x: number; y: number; w: number; h: number };
	blockText?: string;
}): Rect[] {
	return locateQuoteInBlock({
		quote: options.quote,
		runs: options.glyphs.map((glyph) => ({
			text: glyph.content,
			rect: glyph.rect,
		})),
		pageWidth: options.pageWidth,
		pageHeight: options.pageHeight,
		bbox: options.bbox,
		blockText: options.blockText,
	});
}

export type PageFractionRect = {
	x: number;
	y: number;
	w: number;
	h: number;
};

function glyphRectToFraction(
	rect: Rect,
	pageWidth: number,
	pageHeight: number,
): PageFractionRect | null {
	const w = rect.size.width / pageWidth;
	const h = rect.size.height / pageHeight;
	if (!(w > 0) || !(h > 0)) return null;
	return { x: rect.origin.x / pageWidth, y: rect.origin.y / pageHeight, w, h };
}

/**
 * English glyph boxes for each sentence inside one layout block, in sentence
 * order. A sentence that continues in another block is located from the part
 * that sits in this one. A miss is an empty list, not the whole block.
 */
export function sentenceGlyphRects(options: {
	sentences: readonly { quote: string }[];
	raw?: string;
	source: string;
	runs: readonly { text: string; rect: Rect }[];
	pageWidth: number;
	pageHeight: number;
	bbox: { x: number; y: number; w: number; h: number };
}): PageFractionRect[][] {
	const { sentences, runs, pageWidth, pageHeight, bbox } = options;
	const blockText = normalizeSentenceKey(options.raw || options.source);
	return sentences.map((sentence) => {
		const locateText =
			memberLocateText(blockText, sentence.quote) ||
			normalizeSentenceKey(sentence.quote);
		if (!locateText) return [];
		return locateQuoteInBlock({
			quote: locateText,
			runs,
			pageWidth,
			pageHeight,
			bbox,
			blockText,
		}).flatMap((rect) => {
			const fraction = glyphRectToFraction(rect, pageWidth, pageHeight);
			return fraction ? [fraction] : [];
		});
	});
}

export function unionPageRect(rects: readonly Rect[]): Rect {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const rect of rects) {
		minX = Math.min(minX, rect.origin.x);
		minY = Math.min(minY, rect.origin.y);
		maxX = Math.max(maxX, rect.origin.x + rect.size.width);
		maxY = Math.max(maxY, rect.origin.y + rect.size.height);
	}
	return {
		origin: { x: minX, y: minY },
		size: { width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) },
	};
}
