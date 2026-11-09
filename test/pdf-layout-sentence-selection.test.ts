import { describe, expect, it } from "vitest";

import {
	locateQuoteGlyphs,
	locateSelectionGlyphs,
	translationSelectionFromHits,
} from "@/lib/pdf/layout/layout-sentence-selection";
import type { LayoutTranslateSentence } from "@/lib/pdf/layout/types";
import { paragraphFromCharacters } from "@/lib/pdf/reflow/extract";
import type { Character } from "@/lib/pdf/reflow/types";

function glyph(content: string, x: number, y: number, width = 80) {
	return {
		content,
		rect: { origin: { x, y }, size: { width, height: 12 } },
	};
}

const sentence = (
	quote: string,
	translated: string,
): LayoutTranslateSentence => ({ quote, source: quote, translated });

function reflowParagraph(glyphs: readonly string[], source: string) {
	const characters: Character[] = glyphs.map((text, i) => {
		const box = { x: 40 + i * 5, y: 100, w: 5, h: 12 };
		return {
			index: i + 200,
			text,
			box,
			visualBox: box,
			style: {
				font: "Helvetica",
				size: 12,
				bold: false,
				italic: false,
				color: { r: 0, g: 0, b: 0 },
			},
		};
	});
	return {
		...paragraphFromCharacters(
			"a",
			0,
			{ x: 40, y: 100, w: 5 * glyphs.length, h: 12 },
			characters,
			[],
			false,
		),
		source,
	};
}

describe("translationSelectionFromHits", () => {
	const block = {
		id: "a",
		pageIndex: 0,
		bbox: { x: 0.1, y: 0.2, w: 0.4, h: 0.1 },
		source: "First sentence. Second sentence. Third sentence.",
		sentences: [
			sentence("First sentence.", "第一句。"),
			sentence("Second sentence.", "第二句。"),
			sentence("Third sentence.", "第三句。"),
		],
	};

	it("expands a partial sentence to that whole English sentence", () => {
		const selection = translationSelectionFromHits(
			[{ itemId: "a", sentenceIndex: 0 }],
			[block],
			"zh-CN",
			"第一",
		);
		expect(selection?.quote).toBe("First sentence.");
		expect(selection?.copyText).toBe("第一");
		expect(selection?.paired).toBe("第一句。");
		expect(selection?.pages).toHaveLength(1);
	});

	it("keeps consecutive sentences and drops the one outside the selection", () => {
		const selection = translationSelectionFromHits(
			[
				{ itemId: "a", sentenceIndex: 0 },
				{ itemId: "a", sentenceIndex: 1 },
			],
			[block],
			"zh-CN",
			"第一句。第二句。",
		);
		expect(selection?.quote).toBe("First sentence. Second sentence.");
		expect(selection?.paired).toBe("第一句。第二句。");
		expect(selection?.quote).not.toContain("Third");
	});

	it("keeps only selected reflow glyph boxes despite ligatures and omitted spaces", () => {
		const first = ["ﬁ", ..."rst."];
		const second = [..."Second."];
		const third = [..."Third."];
		const source = "first. Second. Third.";
		const reflow = reflowParagraph([...first, ...second, ...third], source);
		const selection = translationSelectionFromHits(
			[
				{ itemId: "a", sentenceIndex: 0 },
				{ itemId: "a", sentenceIndex: 1 },
			],
			[
				{
					...block,
					source,
					reflow,
					sentences: [
						sentence("first.", "第一句。"),
						sentence("Second.", "第二句。"),
						sentence("Third.", "第三句。"),
					],
				},
			],
			"zh-CN",
			"一句。第二",
		);
		expect(
			selection?.pages.map((page) =>
				page.glyphRects?.map((rect) => rect.origin.x),
			),
		).toEqual([
			[40, 45, 50, 55, 60],
			[65, 70, 75, 80, 85, 90, 95],
		]);
		expect(selection?.pages.every((page) => !page.wholeBlock)).toBe(true);
	});

	it("does not fall back to the entire reflow block for an unmatched sentence", () => {
		const reflow = reflowParagraph([...block.source], block.source);
		const selection = translationSelectionFromHits(
			[{ itemId: "a", sentenceIndex: 0 }],
			[{ ...block, reflow, sentences: [sentence("Unmatched.", "缺失。")] }],
			"zh-CN",
			"缺失",
		);
		expect(selection?.pages[0]).toMatchObject({
			locateText: "Unmatched.",
			wholeBlock: false,
		});
		expect(selection?.pages[0]?.glyphRects).toBeUndefined();
		expect(selection?.canLocate).toBe(false);
	});

	it("marks a paragraph-only reflow block only when the entire block was selected", () => {
		const reflow = reflowParagraph([...block.source], block.source);
		const items = [
			{ ...block, reflow, sentences: [sentence(block.source, "整段译文。")] },
		];
		const select = (wholeBlockSelected: boolean) =>
			translationSelectionFromHits(
				[{ itemId: "a", sentenceIndex: 0, wholeBlockSelected }],
				items,
				"zh-CN",
				wholeBlockSelected ? "整段译文。" : "整段",
			);
		expect(select(false)?.canLocate).toBe(false);
		expect(select(true)?.canLocate).toBe(true);
	});

	it("uses exact proportional glyph boxes and the occurrence selected", () => {
		const source = "iiii. WWWW. iiii.";
		const item = {
			...block,
			source,
			bbox: { x: 0, y: 0, w: 1, h: 1 },
			sentences: [
				sentence("iiii.", "一。"),
				sentence("WWWW.", "二。"),
				sentence("iiii.", "三。"),
			],
		};
		let x = 20;
		const glyphs = [...source].map((text) => {
			const width = text === "W" ? 15 : 4;
			const rect = glyph(text, x, 100, width).rect;
			x += width;
			return { text, rect };
		});
		for (const [sentenceIndex, indexes] of [
			[0, [0, 5]],
			[2, [12, 17]],
		] as const) {
			const pick = translationSelectionFromHits(
				[{ itemId: "a", sentenceIndex }],
				[item],
				"zh-CN",
				"译",
			)?.pages[0];
			if (!pick) throw new Error("missing source pick");
			expect(locateSelectionGlyphs(pick, glyphs, 200, 200)).toEqual(
				glyphs.slice(...indexes).map(({ rect }) => rect),
			);
		}
	});

	it("recovers both source pages when one or both boxes of a split sentence are selected", () => {
		const quote = "It works on inputs.";
		const splitSentence = {
			...sentence(quote, "它可以处理输入。"),
			display: "它",
		};
		const left = {
			id: "left",
			pageIndex: 0,
			bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
			source: "The first result is known. It",
			raw: "The first result is known. It",
			sentences: [
				sentence("The first result is known.", "已知第一个结果。"),
				splitSentence,
			],
		};
		const right = {
			...left,
			id: "right",
			pageIndex: 1,
			source: "works on inputs. Another result follows.",
			raw: "works on inputs. Another result follows.",
			sentences: [
				{ ...splitSentence, display: "可以处理输入。" },
				sentence("Another result follows.", "另一个结果如下。"),
			],
		};
		for (const ids of [["left"], ["right"], ["left", "right"]]) {
			const selection = translationSelectionFromHits(
				ids.map((itemId) => ({
					itemId,
					sentenceIndex: itemId === "left" ? 1 : 0,
				})),
				[left, right],
				"zh-CN",
				"可以处理输入",
			);
			expect(selection?.canLocate).toBe(true);
			expect(selection?.quote).toBe(quote);
			expect(
				selection?.pages.map(({ pageIndex, locateText }) => [
					pageIndex,
					locateText,
				]),
			).toEqual([
				[0, "It"],
				[1, "works on inputs."],
			]);
		}
		expect(
			translationSelectionFromHits(
				[{ itemId: "left", sentenceIndex: 1 }],
				[left],
				"zh-CN",
				"查询",
			)?.canLocate,
		).toBe(false);
	});

	it("anchors a block without sentence pairs to its whole English source", () => {
		const selection = translationSelectionFromHits(
			[{ itemId: "bare", sentenceIndex: null }],
			[
				{
					id: "bare",
					pageIndex: 2,
					bbox: { x: 0.1, y: 0.2, w: 0.4, h: 0.1 },
					source: "Whole block source.",
					translated: "整段。",
				},
			],
			"zh-CN",
			"整段",
		);
		expect(selection?.quote).toBe("Whole block source.");
		expect(selection?.paired).toBe("整段。");
		expect(selection?.pages[0]?.locateText).toBe("Whole block source.");
	});
});

describe("locateQuoteGlyphs", () => {
	const page = { pageWidth: 600, pageHeight: 800 };

	it("returns the glyph run that contains the quote", () => {
		const rects = locateQuoteGlyphs({
			quote: "the agent queries the",
			glyphs: [
				glyph("the agent queries the ", 40, 100, 120),
				glyph("environment.", 40, 120, 90),
			],
			...page,
			bbox: { x: 0.05, y: 0.1, w: 0.4, h: 0.05 },
		});
		expect(rects).toHaveLength(1);
		expect(rects[0]?.origin.y).toBe(100);
	});

	it("prefers the hit that overlaps the layout block", () => {
		const rects = locateQuoteGlyphs({
			quote: "Hello.",
			glyphs: [glyph("Hello. ", 40, 40), glyph("Hello.", 40, 400)],
			...page,
			bbox: { x: 0.05, y: 0.48, w: 0.3, h: 0.05 },
		});
		expect(rects[0]?.origin.y).toBe(400);
	});

	it("highlights only the sentence, not the other lines in the block", () => {
		const rects = locateQuoteGlyphs({
			quote: "Second sentence.",
			glyphs: [
				glyph("First sentence.", 40, 80, 140),
				glyph("Second sentence.", 40, 100, 150),
				glyph("Third sentence.", 40, 120, 130),
			],
			...page,
			bbox: { x: 0.05, y: 0.08, w: 0.4, h: 0.1 },
		});
		expect(rects).toHaveLength(1);
		expect(rects[0]?.origin.y).toBe(100);
		expect(rects[0]?.size.width).toBe(150);
	});

	it("does not paint the whole block when the quote is missing", () => {
		const rects = locateQuoteGlyphs({
			quote: "not on this page",
			glyphs: [
				glyph("First sentence.", 40, 80, 140),
				glyph("Second sentence.", 40, 100, 150),
			],
			...page,
			bbox: { x: 0.05, y: 0.08, w: 0.4, h: 0.08 },
			blockText: "First sentence. Second sentence.",
		});
		expect(rects).toEqual([]);
	});

	it("slices the block by the sentence instead of filling it", () => {
		const rects = locateQuoteGlyphs({
			quote: "Second sentence.",
			glyphs: [
				glyph("AAAA", 40, 80, 80),
				glyph("BBBB", 40, 100, 80),
				glyph("CCCC", 40, 120, 80),
			],
			...page,
			bbox: { x: 0.05, y: 0.08, w: 0.4, h: 0.1 },
			blockText: "First sentence. Second sentence. Third sentence.",
		});
		expect(rects.length).toBeGreaterThan(0);
		expect(rects.every((rect) => rect.origin.y === 100)).toBe(true);
	});

	it("keeps a taller word after the words that share its baseline", () => {
		const rects = locateQuoteGlyphs({
			quote: "Our third contribution is Harbor-Index",
			glyphs: [
				glyph("Harbor-Index", 207.7, 160.5, 90),
				glyph("Our third contribution is", 108, 163.03, 90),
			].map((item, index) =>
				index === 0
					? {
							...item,
							rect: {
								origin: item.rect.origin,
								size: { width: item.rect.size.width, height: 13.6 },
							},
						}
					: {
							...item,
							rect: {
								origin: item.rect.origin,
								size: { width: item.rect.size.width, height: 11 },
							},
						},
			),
			...page,
			bbox: { x: 0.05, y: 0.15, w: 0.7, h: 0.15 },
		});
		expect(rects.map((rect) => rect.origin.x)).toEqual([108, 207.7]);
	});

	it("places a hyphenated sentence on the runs that contain it", () => {
		const rects = locateQuoteGlyphs({
			quote: "representation stays.",
			glyphs: [
				glyph("Earlier words.", 40, 80, 100),
				glyph("repre-", 40, 100, 40),
				glyph("sentation stays.", 84, 100, 110),
			],
			...page,
			bbox: { x: 0.05, y: 0.08, w: 0.5, h: 0.08 },
		});
		expect(rects.map((rect) => rect.origin.y)).toEqual([100, 100]);
		expect(rects.some((rect) => rect.origin.y === 80)).toBe(false);
	});
});
