// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { ReadingBlock } from "@/lib/pdf/reading/blocks";
import {
	readerHighlightRanges,
	readerSelectionFromRange,
} from "@/lib/pdf/reading/selection";
import type { Paragraph } from "@/lib/pdf/reflow/types";

function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Missing reader selection fixture");
	return value;
}

function block(text: string, pageIndex = 0): ReadingBlock {
	const style = {
		font: "Times",
		size: 10,
		bold: false,
		italic: false,
		color: { r: 0, g: 0, b: 0 },
	};
	const paragraph: Paragraph = {
		id: `p${pageIndex}`,
		pageIndex,
		box: { x: 0, y: 10, w: 500, h: 10 },
		source: text,
		protectedText: text,
		characters: Array.from(text, (text, index) => ({
			text,
			index,
			box: { x: index * 5, y: 10, w: 5, h: 10 },
			visualBox: { x: index * 5, y: 10, w: 5, h: 10 },
			style,
		})),
		formulas: [],
		styles: {},
		style,
		heading: false,
		firstLineIndent: 0,
	};
	return {
		id: paragraph.id,
		pageIndex,
		kind: "text",
		bbox: { x: 0, y: 0, w: 1, h: 1 },
		readingOrder: pageIndex,
		source: text,
		text,
		item: {
			id: paragraph.id,
			pageIndex,
			kind: "text",
			bbox: { x: 0, y: 0, w: 1, h: 1 },
			readingOrder: pageIndex,
			source: text,
			status: "done",
			reflow: paragraph,
		},
	};
}
function surface(b: ReadingBlock, html: string, translated = false) {
	const root = document.createElement("div");
	root.innerHTML = `<section data-reader-block="${b.id}"><p data-reader-text-root ${translated ? "data-reader-translation" : ""}>${html}</p></section>`;
	return root;
}
describe("reader selections mapped to source PDF glyphs", () => {
	it("merges overlapping original and translated selections into one source annotation", () => {
		const b = block("First. Second.");
		b.translated = required(b.item).translated = "第一句。第二句。";
		required(b.item).sentences = [
			{ quote: "First.", source: "First.", translated: "第一句。" },
			{ quote: "Second.", source: "Second.", translated: "第二句。" },
		];
		const root = surface(
			b,
			'<span data-reader-start="0" data-reader-end="14">First. Second.</span>',
		);
		root.append(
			...Array.from(
				surface(
					b,
					'<span data-reader-start="0" data-reader-end="8">第一句。第二句。</span>',
					true,
				).childNodes,
			),
		);
		const spans = root.querySelectorAll("span"),
			range = document.createRange();
		range.setStart(required(spans[0].firstChild), 7);
		range.setEnd(required(spans[1].firstChild), 6);
		const picked = readerSelectionFromRange(range, root, [b], "zh");
		expect(picked?.canLocate).toBe(true);
		expect(picked?.copyText).toBe("Second. 第一句。第二");
		expect(picked?.quote).toBe("First. Second.");
		const xs =
			picked?.pages.flatMap(
				(p) => p.glyphRects?.map((r) => r.origin.x) ?? [],
			) ?? [];
		expect(new Set(xs).size).toBe(xs.length);
		expect(xs).toContain(0);
		expect(xs).toContain(65);
	});
	it("selects the second occurrence after a raster formula without shifting offsets", () => {
		const b = block("echo xy echo");
		b.source = "echo ⟪F0⟫ echo";
		required(required(b.item).reflow).formulas = [
			{
				id: "0",
				text: "xy",
				box: { x: 25, y: 10, w: 10, h: 10 },
				characterIndexes: [5, 6],
				baselineOffset: 0,
			},
		];
		const root = surface(
			b,
			'<span data-reader-start="0" data-reader-end="5">echo </span><span data-reader-start="5" data-reader-end="7" data-reader-raster></span><span data-reader-start="7" data-reader-end="12"> echo</span>',
		);
		const tail = required(
			root.querySelector('[data-reader-start="7"]')?.firstChild,
		);
		const range = document.createRange();
		range.setStart(tail, 1);
		range.setEnd(tail, 5);
		const picked = readerSelectionFromRange(range, root, [b], "zh");
		expect(picked?.quote).toBe("echo");
		expect(picked?.pages[0].glyphRects?.map((r) => r.origin.x)).toEqual([
			40, 45, 50, 55,
		]);
		expect(picked?.pages[0].wholeBlock).toBe(false);
	});
	it("keeps separate page geometry when selecting across paragraphs", () => {
		const a = block("first tail"),
			b = block("second head", 1);
		const root = surface(
			a,
			'<span data-reader-start="0" data-reader-end="10">first tail</span>',
		);
		root.append(
			...Array.from(
				surface(
					b,
					'<span data-reader-start="0" data-reader-end="11">second head</span>',
				).childNodes,
			),
		);
		const spans = root.querySelectorAll("span");
		const range = document.createRange();
		range.setStart(required(spans[0].firstChild), 6);
		range.setEnd(required(spans[1].firstChild), 6);
		const picked = readerSelectionFromRange(range, root, [a, b], "zh");
		expect(picked?.quote).toBe("tail second");
		expect(picked?.pages.map((p) => p.pageIndex)).toEqual([0, 1]);
	});
	it("maps prose after a protected formula whose cached astral glyph halves were replaced", () => {
		const b = block("echo �� echo");
		b.source = "echo ⟪F0⟫ echo";
		const paragraph = required(required(b.item).reflow);
		paragraph.formulas = [
			{
				id: "0",
				text: "𝑅",
				box: { x: 25, y: 10, w: 10, h: 10 },
				characterIndexes: [5, 6],
				baselineOffset: 0,
			},
		];
		const root = surface(
			b,
			'<span data-reader-start="0" data-reader-end="5">echo </span><span data-reader-start="5" data-reader-end="7">𝑅</span><span data-reader-start="7" data-reader-end="12"> echo</span>',
		);
		const tail = required(
			root.querySelector('[data-reader-start="7"]')?.firstChild,
		);
		const range = document.createRange();
		range.setStart(tail, 1);
		range.setEnd(tail, 5);
		const picked = readerSelectionFromRange(range, root, [b], "zh");
		expect(picked?.quote).toBe("echo");
		expect(picked?.pages[0].glyphRects?.map((r) => r.origin.x)).toEqual([
			40, 45, 50, 55,
		]);
	});
	it("uses a selected translation's sentence pair and copies the visible text", () => {
		const b = block("First. Second.");
		b.translated = "第一句。第二句。";
		required(b.item).translated = b.translated;
		required(b.item).sentences = [
			{ quote: "First.", source: "First.", translated: "第一句。" },
			{ quote: "Second.", source: "Second.", translated: "第二句。" },
		];
		const root = surface(
			b,
			'<span data-reader-start="0" data-reader-end="8">第一句。第二句。</span>',
			true,
		);
		const text = required(root.querySelector("span")?.firstChild);
		const range = document.createRange();
		range.setStart(text, 4);
		range.setEnd(text, 6);
		const picked = readerSelectionFromRange(range, root, [b], "zh");
		expect(picked?.copyText).toBe("第二");
		expect(picked?.quote).toBe("Second.");
		expect(picked?.fromTranslation).toBe(true);
		expect(picked?.pages[0].glyphRects?.[0].origin.x).toBe(35);
	});
	it("uses protected formula geometry for a translated sentence with damaged cached math characters", () => {
		const b = block("First. echo ��.");
		const item = required(b.item),
			paragraph = required(item.reflow);
		paragraph.source = "First. echo 𝑅.";
		paragraph.formulas = [
			{
				id: "0",
				text: "𝑅",
				box: { x: 60, y: 10, w: 10, h: 10 },
				characterIndexes: [12, 13],
				baselineOffset: 0,
			},
		];
		b.source = item.source = "First. echo ⟪F0⟫.";
		b.translated = item.translated = "第一句。回声𝑅。";
		item.sentences = [
			{ quote: "First.", source: "First.", translated: "第一句。" },
			{ quote: "echo 𝑅.", source: "echo 𝑅.", translated: "回声𝑅。" },
		];
		const root = surface(
			b,
			'<span data-reader-start="0" data-reader-end="9">第一句。回声𝑅。</span>',
			true,
		);
		const text = required(root.querySelector("span")?.firstChild);
		const range = document.createRange();
		range.setStart(text, 4);
		range.setEnd(text, 6);
		const picked = readerSelectionFromRange(range, root, [b], "zh");
		expect(picked?.quote).toBe("echo 𝑅.");
		expect(picked?.pages[0].glyphRects?.map((r) => r.origin.x)).toEqual([
			35, 40, 45, 50, 60, 70,
		]);
	});
	it("does not mark a whole paragraph when a partial translation has no sentence mapping", () => {
		const b = block("First. Second.");
		b.translated = "第一句。第二句。";
		required(b.item).translated = b.translated;
		const root = surface(
			b,
			'<span data-reader-start="0" data-reader-end="8">第一句。第二句。</span>',
			true,
		);
		const text = required(root.querySelector("span")?.firstChild);
		const range = document.createRange();
		range.setStart(text, 4);
		range.setEnd(text, 6);
		expect(readerSelectionFromRange(range, root, [b], "zh")?.canLocate).toBe(
			false,
		);
	});
	it("renders persisted highlights at their geometry, including repeated text", () => {
		const b = block("echo echo");
		const ranges = readerHighlightRanges(
			b,
			[
				{
					version: 1,
					kind: "highlight",
					id: "h",
					paperPath: "paper",
					createdAt: "",
					updatedAt: "",
					page: 1,
					quote: "echo",
					rects: [{ x: 0.025, y: 0.01, w: 0.02, h: 0.01 }],
				},
			],
			{ width: 1000, height: 1000 },
		);
		expect(ranges.map(({ start, end }) => ({ start, end }))).toEqual([
			{ start: 5, end: 9 },
		]);
	});
	it("paints a translated sentence only when its original glyphs overlap the saved annotation", () => {
		const b = block("First. Second.");
		b.translated = "第一句。第二句。";
		required(b.item).translated = b.translated;
		required(b.item).sentences = [
			{ quote: "First.", source: "First.", translated: "第一句。" },
			{ quote: "Second.", source: "Second.", translated: "第二句。" },
		];
		const ranges = readerHighlightRanges(
			b,
			[
				{
					version: 1,
					kind: "highlight",
					id: "h",
					paperPath: "paper",
					createdAt: "",
					updatedAt: "",
					page: 1,
					quote: "Second.",
					rects: [{ x: 0.035, y: 0.01, w: 0.035, h: 0.01 }],
				},
			],
			{ width: 1000, height: 1000 },
			true,
		);
		expect(ranges.map(({ start, end }) => ({ start, end }))).toEqual([
			{ start: 4, end: 8 },
		]);
	});
});
