import type { Rect, Size } from "@embedpdf/models";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";
import {
	type TranslationSelection,
	type TranslationSpanHit,
	translationSelectionFromHits,
} from "@/lib/pdf/layout/layout-sentence-selection";
import type { ReadingBlock } from "@/lib/pdf/reading/blocks";
import { readingInlineParts } from "@/lib/pdf/reading/inline";
import { paragraphSelectionCharacters } from "@/lib/pdf/reflow/selection-characters";
import type { Character } from "@/lib/pdf/reflow/types";

export type ReaderSelection = TranslationSelection & {
	fromTranslation: boolean;
	blockId: string;
};
export type ReaderHighlightRange = {
	start: number;
	end: number;
	highlight: PdfHighlight;
};

/** UTF-16 offsets refer to expanded visible text, including raster formula text. */
function textOffsets(text: string, ignoreHyphens: boolean) {
	let key = "";
	const offsets: { start: number; end: number }[] = [];
	let start = 0;
	for (const char of text) {
		const value = char
			.normalize("NFKD")
			.replace(ignoreHyphens ? /[\s\u00ad-]/gu : /[\s\u00ad]/gu, "");
		key += value;
		for (let i = 0; i < value.length; i++)
			offsets.push({ start, end: start + char.length });
		start += char.length;
	}
	return { key, offsets };
}

function mappedCharacters(block: ReadingBlock) {
	const paragraph = block.item?.reflow;
	const characters = paragraph ? paragraphSelectionCharacters(paragraph) : null;
	if (!characters?.length) return null;
	const text = readingInlineParts(block.source, block.item?.reflow).text;
	for (const ignoreHyphens of [false, true]) {
		const display = textOffsets(text, ignoreHyphens);
		const source = characters.map(
			(c) => textOffsets(c.text, ignoreHyphens).key,
		);
		if (source.join("") !== display.key) continue;
		let offset = 0;
		return characters.flatMap((character, index) => {
			const length = source[index].length;
			const start = display.offsets[offset]?.start;
			const end = display.offsets[offset + length - 1]?.end;
			offset += length;
			return length && start != null && end != null
				? [{ character, start, end }]
				: [];
		});
	}
	return null;
}
function glyphRect(c: Character): Rect {
	return {
		origin: { x: c.visualBox.x, y: c.visualBox.y },
		size: { width: c.visualBox.w, height: c.visualBox.h },
	};
}

/** Intersect a DOM range with a text leaf; raster leaves occupy their full logical span. */
function leafSlice(
	range: Range,
	leaf: HTMLElement,
): { start: number; end: number } | null {
	const start = Number(leaf.dataset.readerStart),
		end = Number(leaf.dataset.readerEnd);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
		return null;
	const bounds = document.createRange();
	bounds.selectNodeContents(leaf);
	if (leaf.hasAttribute("data-reader-raster")) bounds.selectNode(leaf);
	if (
		range.compareBoundaryPoints(Range.END_TO_START, bounds) >= 0 ||
		range.compareBoundaryPoints(Range.START_TO_END, bounds) <= 0
	)
		return null;
	if (leaf.hasAttribute("data-reader-raster")) return { start, end };
	const slice = range.cloneRange();
	if (slice.compareBoundaryPoints(Range.START_TO_START, bounds) < 0)
		slice.setStart(bounds.startContainer, bounds.startOffset);
	if (slice.compareBoundaryPoints(Range.END_TO_END, bounds) > 0)
		slice.setEnd(bounds.endContainer, bounds.endOffset);
	if (slice.collapsed) return null;
	const prefix = bounds.cloneRange();
	prefix.setEnd(slice.startContainer, slice.startOffset);
	const from = start + prefix.toString().length;
	return { start: from, end: Math.min(end, from + slice.toString().length) };
}

export function readerSelectionFromRange(
	range: Range,
	root: ParentNode,
	blocks: readonly ReadingBlock[],
	targetLang: string,
): ReaderSelection | null {
	if (range.collapsed) return null;
	const byId = new Map(blocks.map((b) => [b.id, b]));
	const picks: {
		block: ReadingBlock;
		start: number;
		end: number;
		translated: boolean;
		text: string;
	}[] = [];
	for (const surface of root.querySelectorAll<HTMLElement>(
		"[data-reader-text-root]",
	)) {
		if (!range.intersectsNode(surface)) continue;
		const block = byId.get(
			surface.closest<HTMLElement>("[data-reader-block]")?.dataset
				.readerBlock ?? "",
		);
		if (!block || block.image) continue;
		const slices = Array.from(
			surface.querySelectorAll<HTMLElement>("[data-reader-start]"),
		).flatMap((leaf) => {
			const slice = leafSlice(range, leaf);
			return slice ? [slice] : [];
		});
		if (!slices.length) continue;
		const translated = surface.hasAttribute("data-reader-translation");
		const text = readingInlineParts(
			translated
				? (block.item?.translated ?? block.translated ?? "")
				: block.source,
			block.item?.reflow,
		).text;
		const start = Math.min(...slices.map((s) => s.start)),
			end = Math.max(...slices.map((s) => s.end));
		if (text.slice(start, end).trim())
			picks.push({ block, start, end, translated, text });
	}
	if (!picks.length) return null;
	const fromTranslation = picks[0].translated;
	if (picks.some((p) => p.translated !== fromTranslation)) {
		const resolved: ReaderSelection[] = [];
		for (const surface of root.querySelectorAll<HTMLElement>(
			"[data-reader-text-root]",
		)) {
			if (!range.intersectsNode(surface)) continue;
			const bounds = document.createRange();
			bounds.selectNodeContents(surface);
			const part = range.cloneRange();
			if (part.compareBoundaryPoints(Range.START_TO_START, bounds) < 0)
				part.setStart(bounds.startContainer, bounds.startOffset);
			if (part.compareBoundaryPoints(Range.END_TO_END, bounds) > 0)
				part.setEnd(bounds.endContainer, bounds.endOffset);
			if (part.collapsed) continue;
			const selection = readerSelectionFromRange(
				part,
				root,
				blocks,
				targetLang,
			);
			if (selection) resolved.push(selection);
		}
		const pages: ReaderSelection["pages"] = [],
			quotes: string[] = [];
		let canLocate = resolved.every((s) => s.canLocate);
		for (const block of blocks) {
			const members = resolved
				.flatMap((s) => s.pages)
				.filter(
					(p) => p.pageIndex === block.pageIndex && p.bbox === block.bbox,
				);
			if (!members.length) continue;
			const text = readingInlineParts(block.source, block.item?.reflow).text;
			const intervals: { start: number; end: number }[] = [];
			for (const member of members) {
				let matched = false;
				for (const ignoreHyphens of [false, true]) {
					const source = textOffsets(text, ignoreHyphens),
						needle = textOffsets(member.locateText, ignoreHyphens).key;
					const prefix = textOffsets(
						member.precedingParts.join(" "),
						ignoreHyphens,
					).key.length;
					const at = needle ? source.key.indexOf(needle, prefix) : -1;
					if (at < 0) continue;
					intervals.push({
						start: source.offsets[at].start,
						end: source.offsets[at + needle.length - 1].end,
					});
					matched = true;
					break;
				}
				if (!matched) canLocate = false;
			}
			const merged: typeof intervals = [];
			for (const span of intervals.sort((a, b) => a.start - b.start)) {
				const last = merged.at(-1);
				if (last && !text.slice(last.end, span.start).trim())
					last.end = Math.max(last.end, span.end);
				else merged.push({ ...span });
			}
			for (const { start, end } of merged) {
				quotes.push(text.slice(start, end));
				pages.push({
					pageIndex: block.pageIndex,
					bbox: block.bbox,
					blockText: text,
					locateText: text.slice(start, end),
					precedingParts: start ? [text.slice(0, start)] : [],
					wholeBlock: start === 0 && end === text.length,
					glyphRects: mappedCharacters(block)
						?.filter((c) => c.start < end && c.end > start)
						.map((c) => glyphRect(c.character)),
				});
			}
		}
		return {
			copyText: picks.map((p) => p.text.slice(p.start, p.end).trim()).join(" "),
			quote: quotes.join(" "),
			paired: resolved
				.filter((s) => s.fromTranslation)
				.map((s) => s.paired)
				.join(" "),
			pages,
			canLocate,
			fromTranslation: true,
			blockId: picks[picks.length - 1].block.id,
		};
	}
	const blockId = picks[picks.length - 1].block.id;
	const copyText = picks
		.map((p) => p.text.slice(p.start, p.end).trim())
		.join(" ");
	if (!fromTranslation)
		return {
			copyText,
			quote: copyText,
			paired: "",
			canLocate: true,
			fromTranslation,
			blockId,
			pages: picks.map(({ block, start, end, text }) => ({
				pageIndex: block.pageIndex,
				bbox: block.bbox,
				blockText: text,
				locateText: text.slice(start, end),
				precedingParts: start ? [text.slice(0, start)] : [],
				wholeBlock: start === 0 && end === text.length,
				glyphRects: mappedCharacters(block)
					?.filter((c) => c.start < end && c.end > start)
					.map((c) => glyphRect(c.character)),
			})),
		};
	const hits: TranslationSpanHit[] = [];
	let complete = true;
	for (const { block, start, end, text } of picks) {
		const wholeBlockSelected =
			!text.slice(0, start).trim() && !text.slice(end).trim();
		const sentences = block.item?.sentences;
		if (!sentences?.length) {
			hits.push({ itemId: block.id, sentenceIndex: null, wholeBlockSelected });
			if (!wholeBlockSelected) complete = false;
			continue;
		}
		let cursor = 0,
			selected = false;
		for (let index = 0; index < sentences.length; index++) {
			const display = readingInlineParts(
				sentences[index].display ?? sentences[index].translated,
				block.item?.reflow,
			).text.trim();
			const at = display ? text.indexOf(display, cursor) : -1;
			if (at < 0) {
				complete = false;
				continue;
			}
			cursor = at + display.length;
			if (at < end && cursor > start) {
				hits.push({
					itemId: block.id,
					sentenceIndex: index,
					wholeBlockSelected,
				});
				selected = true;
			}
		}
		if (!selected) complete = false;
	}
	const resolved = translationSelectionFromHits(
		hits,
		blocks.map((b) => ({
			...b.item,
			...b,
			source: b.item?.source ?? b.source,
		})),
		targetLang,
		copyText,
	);
	return resolved
		? {
				...resolved,
				canLocate: complete && resolved.canLocate,
				fromTranslation,
				blockId,
			}
		: null;
}

/** Source geometry is authoritative; identical text elsewhere is not highlighted. */
export function readerHighlightRanges(
	block: ReadingBlock,
	highlights: readonly PdfHighlight[],
	size: Size,
	translated = false,
): ReaderHighlightRange[] {
	const candidates = highlights.filter(
		(h) =>
			h.page === block.pageIndex + 1 &&
			h.rects.some(
				(r) =>
					r.x < block.bbox.x + block.bbox.w &&
					r.x + r.w > block.bbox.x &&
					r.y < block.bbox.y + block.bbox.h &&
					r.y + r.h > block.bbox.y,
			),
	);
	if (!candidates.length) return [];
	if (translated) {
		if (!block.item?.sentences?.length) return [];
		const text = readingInlineParts(
			block.item.translated ?? block.translated ?? "",
			block.item.reflow,
		).text;
		const ranges: ReaderHighlightRange[] = [];
		let cursor = 0;
		block.item.sentences.forEach((sentence, index) => {
			const display = readingInlineParts(
				sentence.display ?? sentence.translated,
				block.item?.reflow,
			).text.trim();
			const start = display ? text.indexOf(display, cursor) : -1;
			if (start < 0) return;
			const end = start + display.length;
			cursor = end;
			const selection = translationSelectionFromHits(
				[{ itemId: block.id, sentenceIndex: index }],
				[{ ...block.item, ...block }],
				"",
				display,
			);
			const glyphs = selection?.pages.flatMap((p) => p.glyphRects ?? []) ?? [];
			for (const highlight of candidates) {
				if (
					glyphs.some((g) =>
						highlight.rects.some((r) => {
							const x = (g.origin.x + g.size.width / 2) / size.width,
								y = (g.origin.y + g.size.height / 2) / size.height;
							return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
						}),
					)
				)
					ranges.push({ start, end, highlight });
			}
		});
		return ranges;
	}
	const mapped = mappedCharacters(block);
	if (!mapped) return [];
	const text = readingInlineParts(block.source, block.item?.reflow).text;
	return candidates.flatMap((highlight) => {
		const ranges: ReaderHighlightRange[] = [];
		for (const { character, start, end } of mapped) {
			const b = character.visualBox;
			const x = (b.x + b.w / 2) / size.width,
				y = (b.y + b.h / 2) / size.height;
			if (
				!highlight.rects.some(
					(r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h,
				)
			)
				continue;
			const prev = ranges.at(-1);
			if (prev && !text.slice(prev.end, start).trim()) prev.end = end;
			else ranges.push({ start, end, highlight });
		}
		return ranges;
	});
}
