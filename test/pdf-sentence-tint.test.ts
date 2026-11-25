import { describe, expect, it } from "vitest";

import {
	resolveTranslatedHighlightIds,
	sentenceHighlightTints,
	sentenceIndexesForHighlightTint,
	sentenceIndexesOverlappingHighlight,
} from "@/lib/pdf/highlight/sentence-tint";
import type { PdfHighlightRect } from "@/lib/pdf/highlight/types";
import { sentenceGlyphRects } from "@/lib/pdf/layout/layout-sentence-selection";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";

const box = (y: number, h = 0.02): PdfHighlightRect => ({
	x: 0.1,
	y,
	w: 0.4,
	h,
});

describe("sentenceIndexesOverlappingHighlight", () => {
	const sentences = [box(0.2), box(0.4), box(0.6)];

	it("tints only the sentence whose box meets the highlight", () => {
		expect(
			sentenceIndexesOverlappingHighlight(
				[[sentences[0]], [sentences[1]], [sentences[2]]],
				[{ x: 0.12, y: 0.4, w: 0.08, h: 0.02 }],
			),
		).toEqual([1]);
	});

	it("keeps a short sentence fully covered beside a longer one", () => {
		const short = { x: 0.1, y: 0.4, w: 0.05, h: 0.02 };
		expect(
			sentenceIndexesOverlappingHighlight(
				[[sentences[0]], [short], [sentences[2]]],
				[sentences[0], short],
			),
		).toEqual([0, 1]);
	});

	it("drops a sliver that only clips the next sentence", () => {
		expect(
			sentenceIndexesOverlappingHighlight(
				[
					[{ x: 0.1, y: 0.2, w: 0.4, h: 0.04 }],
					[{ x: 0.1, y: 0.24, w: 0.4, h: 0.04 }],
				],
				[{ x: 0.1, y: 0.2, w: 0.4, h: 0.041 }],
			),
		).toEqual([0]);
	});
});

describe("sentenceIndexesForHighlightTint", () => {
	const sentences = [
		{ quote: "Alpha mentions representation once." },
		{ quote: "Beta mentions representation again." },
	];

	it("uses the overlapping sentence even when the word is in both quotes", () => {
		expect(
			sentenceIndexesForHighlightTint({
				sentences,
				quote: "representation",
				sentenceRects: [box(0.2), box(0.5)].map((rect) => [rect]),
				highlightRects: [{ x: 0.2, y: 0.5, w: 0.1, h: 0.02 }],
			}),
		).toEqual([1]);
	});

	it("matches a whole sentence by text until glyph boxes arrive", () => {
		expect(
			sentenceIndexesForHighlightTint({
				sentences,
				quote: "Beta mentions representation again.",
				sentenceRects: undefined,
				highlightRects: [{ x: 0.2, y: 0.5, w: 0.1, h: 0.02 }],
			}),
		).toEqual([1]);
	});

	it("does not spread a fragment across sentences before glyph boxes arrive", () => {
		expect(
			sentenceIndexesForHighlightTint({
				sentences,
				quote: "representation",
				sentenceRects: undefined,
				highlightRects: [{ x: 0.2, y: 0.5, w: 0.1, h: 0.02 }],
			}),
		).toEqual([]);
	});
});

describe("sentenceGlyphRects", () => {
	it("locates each sentence on its own line", () => {
		const glyph = (text: string, y: number) => ({
			text,
			rect: { origin: { x: 40, y }, size: { width: 120, height: 12 } },
		});
		const rects = sentenceGlyphRects({
			sentences: [{ quote: "First sentence." }, { quote: "Second sentence." }],
			source: "First sentence. Second sentence.",
			raw: "First sentence. Second sentence.",
			runs: [glyph("First sentence.", 80), glyph("Second sentence.", 100)],
			pageWidth: 400,
			pageHeight: 500,
			bbox: { x: 0.05, y: 0.1, w: 0.5, h: 0.15 },
		});
		expect(rects[0]?.every((rect) => rect.y === 80 / 500)).toBe(true);
		expect(rects[1]?.every((rect) => rect.y === 100 / 500)).toBe(true);
		expect(rects[0]?.some((rect) => rect.y === 100 / 500)).toBe(false);
	});
});

describe("sentenceHighlightTints", () => {
	const item: LayoutTranslateItem = {
		id: "item-1",
		pageIndex: 0,
		kind: "text",
		bbox: { x: 0.1, y: 0.2, w: 0.8, h: 0.3 },
		source: "First sentence. Second sentence.",
		status: "done",
		translated: "第一句。第二句。",
		sentences: [
			{ quote: "First sentence.", translated: "第一句。" },
			{ quote: "Second sentence.", translated: "第二句。" },
		],
	};
	const highlight = (id: string, quote: string) => ({
		id,
		quote,
		color: "yellow" as const,
		shape: "highlight" as const,
		rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.05 }],
	});

	it("maps the tinted sentence back to its highlight across a paragraph boundary", () => {
		const next = {
			...item,
			id: "item-2",
			sentences: [{ quote: "Next paragraph.", translated: "下一段。" }],
		};
		const tints = sentenceHighlightTints({
			layoutItems: [item, next],
			highlightQuotes: [highlight("hl-1", "Second sentence.")],
			sentenceRectsByItemId: new Map([
				[item.id, [[box(0.16)], [box(0.2, 0.048)]]],
				[next.id, [[box(0.248)]]],
			]),
		});
		expect(tints.get(item.id)?.get(1)).toEqual({
			color: "yellow",
			shape: "highlight",
			highlightId: "hl-1",
		});
		expect(tints.get(item.id)?.has(0)).toBe(false);
		expect(tints.has(next.id)).toBe(false);
	});

	it("keeps the first highlight when two match the same sentence", () => {
		const tints = sentenceHighlightTints({
			layoutItems: [item],
			highlightQuotes: [
				highlight("hl-first", "First sentence."),
				highlight("hl-second", "First sentence."),
			],
		});
		expect(tints.get("item-1")?.get(0)?.highlightId).toBe("hl-first");
	});

	it("skips sentences that are not painted yet", () => {
		const tints = sentenceHighlightTints({
			layoutItems: [{ ...item, status: "pending", translated: undefined }],
			highlightQuotes: [highlight("hl-1", "First sentence.")],
		});
		expect(tints.size).toBe(0);
	});
});

describe("resolveTranslatedHighlightIds", () => {
	const itemDone: LayoutTranslateItem = {
		id: "item-1",
		pageIndex: 0,
		kind: "text",
		bbox: { x: 0.1, y: 0.2, w: 0.8, h: 0.3 },
		source: "First sentence. Second sentence.",
		status: "done",
		translated: "第一句。第二句。",
		sentences: [
			{ quote: "First sentence.", translated: "第一句。" },
			{ quote: "Second sentence.", translated: "第二句。" },
		],
	};

	it("includes highlights recorded directly on the translation overlay", () => {
		const result = resolveTranslatedHighlightIds({
			translatedPaints: [{ id: "paint-1" }],
		});
		expect(result.has("paint-1")).toBe(true);
	});

	it("suppresses English highlights that overlap a painted translated sentence", () => {
		const result = resolveTranslatedHighlightIds({
			highlightQuotes: [
				{
					id: "hl-matched",
					quote: "First sentence.",
					color: "yellow",
					rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.05 }],
				},
				{
					id: "hl-untranslated",
					quote: "References: [1] Author et al.",
					color: "yellow",
					rects: [{ x: 0.1, y: 0.8, w: 0.4, h: 0.05 }],
				},
			],
			layoutItems: [itemDone],
		});

		expect(result.has("hl-matched")).toBe(true);
		expect(result.has("hl-untranslated")).toBe(false);
	});

	it("does not suppress highlights when the layout item is pending or unpainted", () => {
		const itemPending: LayoutTranslateItem = {
			...itemDone,
			status: "pending",
			translated: undefined,
		};
		const itemErrorClean: LayoutTranslateItem = {
			...itemDone,
			status: "error",
			translated: undefined,
			error: "Network error",
		};

		const resultPending = resolveTranslatedHighlightIds({
			highlightQuotes: [
				{
					id: "hl-1",
					quote: "First sentence.",
					color: "yellow",
					rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.05 }],
				},
			],
			layoutItems: [itemPending],
		});
		expect(resultPending.has("hl-1")).toBe(false);

		const resultError = resolveTranslatedHighlightIds({
			highlightQuotes: [
				{
					id: "hl-1",
					quote: "First sentence.",
					color: "yellow",
					rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.05 }],
				},
			],
			layoutItems: [itemErrorClean],
		});
		expect(resultError.has("hl-1")).toBe(false);
	});
});
