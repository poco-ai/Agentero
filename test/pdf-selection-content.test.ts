// @vitest-environment jsdom

import type {
	PdfEngine,
	PdfPageGeometry,
	PdfTextRectObject,
} from "@embedpdf/models";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
	type PdfPageText,
	type UsePdfPageTextOptions,
	usePdfPageText,
} from "@/components/viewer/pdf/hooks/use-pdf-page-text";
import { translationTextFromRange } from "@/lib/pdf/layout/layout-sentence-selection";
import {
	buildTightSelectionRects,
	isSelectionInsertionRegion,
	selectionInsertionExclusions,
	selectionTextSlices,
} from "@/lib/pdf/selection-appearance";
import {
	selectionMarginCandidates,
	selectionPageMargins,
} from "@/lib/pdf/selection-page-margins";

describe("selection content", () => {
	it.each([
		{ kind: "table" as const },
		{ kind: "figure_title" as const },
		{ kind: "formula" as const },
		{ kind: "formula_number" as const },
		{ kind: "text" as const, label: "vision_footnote" },
		{ kind: "text" as const, label: "footnote" },
		{ kind: "text" as const, label: "footer" },
		{ kind: "text" as const, label: "seal" },
		{ kind: "text" as const, label: "reference" },
		{ kind: "text" as const, label: "reference_content" },
		{ kind: "header" as const, text: "References" },
		{ kind: "header" as const, text: "Table 1: Results" },
	])("skips an intervening $kind block but preserves deliberate selections of it", (insertion) => {
		const page: PdfPageGeometry = {
			runs: [100, 400, 600].map((y, row) => ({
				charStart: row * 3,
				rect: { x: 10, y, width: 30, height: 10 },
				glyphs: Array.from({ length: 3 }, (_, i) => ({
					x: 10 + i * 10,
					y,
					width: 10,
					height: 10,
					flags: 0,
				})),
			})),
		};
		const regions = [0, 1].map((pageIndex) => ({
			pageIndex,
			...insertion,
			rect: { x: 10, y: 400, w: 30, h: 10 },
		}));
		const cross = { start: { page: 0, index: 1 }, end: { page: 1, index: 7 } };
		const excluded = selectionInsertionExclusions(
			{ 0: page, 1: page },
			cross,
			regions,
		);
		expect(selectionTextSlices(page, 1, 8, excluded.get(0) ?? [])).toEqual([
			{ start: 1, count: 2 },
			{ start: 6, count: 3 },
		]);
		expect(buildTightSelectionRects(page, cross, 1, excluded.get(1))).toEqual([
			{ origin: { x: 10, y: 100 }, size: { width: 30, height: 10 } },
			{ origin: { x: 10, y: 600 }, size: { width: 20, height: 10 } },
		]);
		expect(
			selectionInsertionExclusions(
				{ 0: page, 1: page },
				{ ...cross, start: { page: 0, index: 4 } },
				regions,
			).size,
		).toBe(0);
		const captionEnd = { start: cross.start, end: { page: 1, index: 4 } };
		expect(
			selectionInsertionExclusions({ 0: page, 1: page }, captionEnd, regions, 0)
				.size,
		).toBe(2);
		// Upward drags use the actual origin, not the sorted range's start.
		expect(
			selectionInsertionExclusions({ 0: page, 1: page }, captionEnd, regions, 1)
				.size,
		).toBe(0);
		expect(
			selectionInsertionExclusions(
				{ 0: page, 1: page },
				{ start: { page: 0, index: 4 }, end: cross.end },
				regions,
				1,
			).size,
		).toBe(2);
		expect(
			selectionInsertionExclusions(
				{ 0: page },
				{ start: { page: 0, index: 1 }, end: { page: 0, index: 7 } },
				regions,
			).size,
		).toBe(0);
	});
	it("keeps prose references, section headings and inline formulas in the body flow", () => {
		for (const region of [
			{ kind: "text" as const, text: "Figure 1 shows the results." },
			{ kind: "header" as const, text: "4. Experiments" },
			{ kind: "header" as const, text: "Algorithm design" },
			{ kind: "formula" as const, label: "inline_formula" },
		]) {
			expect(
				isSelectionInsertionRegion({
					...region,
					pageIndex: 0,
					rect: { x: 10, y: 400, w: 30, h: 10 },
				}),
			).toBe(false);
		}
	});
	it("excludes a table superscript just outside the detector boundary", () => {
		const geometry: PdfPageGeometry = {
			runs: [
				{
					charStart: 0,
					rect: { x: 10, y: 100, width: 10, height: 10 },
					glyphs: [{ x: 10, y: 100, width: 10, height: 10, flags: 0 }],
				},
				{
					charStart: 1,
					rect: { x: 40, y: 400, width: 2, height: 4 },
					glyphs: [{ x: 40, y: 400, width: 2, height: 4, flags: 0 }],
				},
			],
		};
		const selection = {
			start: { page: 0, index: 0 },
			end: { page: 1, index: 0 },
		};
		const excluded = selectionInsertionExclusions({ 0: geometry }, selection, [
			{ pageIndex: 0, kind: "table", rect: { x: 10, y: 390, w: 30, h: 20 } },
		]);
		expect(selectionTextSlices(geometry, 0, 2, excluded.get(0) ?? [])).toEqual([
			{ start: 0, count: 1 },
		]);
		expect(
			buildTightSelectionRects(geometry, selection, 0, excluded.get(0)),
		).toHaveLength(1);
	});
	it("preserves formulas surrounded by prose on one line but excludes display formulas and their numbers", () => {
		const geometry: PdfPageGeometry = {
			runs: [
				{
					charStart: 0,
					rect: { x: 0, y: 100, width: 120, height: 10 },
					glyphs: Array.from({ length: 12 }, (_, i) => ({
						x: i * 10,
						y: 100,
						width: 10,
						height: 10,
						flags: 0,
					})),
				},
			],
		};
		const formula = {
			kind: "formula" as const,
			pageIndex: 0,
			rect: { x: 40, y: 100, w: 30, h: 10 },
		};
		const selection = {
			start: { page: 0, index: 0 },
			end: { page: 1, index: 0 },
		};
		expect(
			selectionInsertionExclusions({ 0: geometry }, selection, [formula]).size,
		).toBe(0);
		const number = {
			kind: "formula_number" as const,
			pageIndex: 0,
			rect: { x: 100, y: 100, w: 20, h: 10 },
		};
		const display: PdfPageGeometry = {
			runs: [
				{
					...geometry.runs[0],
					glyphs: geometry.runs[0].glyphs.map((glyph, i) =>
						(i >= 4 && i <= 6) || i >= 10 ? glyph : { ...glyph, y: 200 },
					),
				},
			],
		};
		expect(
			selectionInsertionExclusions({ 0: display }, selection, [
				formula,
				number,
			]).get(0),
		).toHaveLength(2);
	});
	const size = { width: 600, height: 800 };
	function line(content: string, y = 45): PdfTextRectObject {
		return {
			content,
			rect: { origin: { x: 40, y }, size: { width: 400, height: 12 } },
		} as PdfTextRectObject;
	}

	it("skips a paper-title running header while retaining the first-page title and body headings", () => {
		const title =
			"AgentCompass: A Unified Evaluation Infrastructure for Agent Capabilities";
		const pages = new Map(
			[0, 1].map((page) => [
				page,
				selectionMarginCandidates(
					[line(title), line("3. Evaluation Method", 120)],
					size,
				),
			]),
		);
		const headers = selectionPageMargins(pages, title);
		expect(headers.has(0)).toBe(false);
		expect(headers.get(1)).toEqual([line(title).rect]);
	});

	it("recognizes repeated margin text without catalog metadata and keeps unique top headings", () => {
		const pages = new Map([
			[1, selectionMarginCandidates([line("A repeating running title")], size)],
			[
				2,
				selectionMarginCandidates(
					[line("A repeating running title"), line("4. Experiments", 78)],
					size,
				),
			],
		]);
		const headers = selectionPageMargins(pages);
		expect(headers.get(1)).toEqual([line("A repeating running title").rect]);
		expect(headers.get(2)).toHaveLength(1);
	});

	it("excludes numeric page footers while retaining body numbers and numeric text in prose", () => {
		const footer = line("4", 760);
		footer.rect.origin.x = 550;
		footer.rect.size.width = 8;
		const candidates = selectionMarginCandidates(
			[footer, line("42", 420), line("Accuracy 95", 720)],
			size,
		);
		expect(selectionPageMargins(new Map([[0, candidates]])).get(0)).toEqual([
			footer.rect,
		]);
	});
	it.each([
		"S3",
		"iv",
		"Page 3 of 10",
		"3/10",
		"第3页 共10页",
		"— 3 —",
	])("excludes the margin page number %s while preserving the same text in the body", (content) => {
		const footer = line(content, 760);
		footer.rect.origin.x = 500;
		footer.rect.size.width = 90;
		const body = line(content, 420);
		const candidates = selectionMarginCandidates([footer, body], size);
		expect(selectionPageMargins(new Map([[0, candidates]])).get(0)).toEqual([
			footer.rect,
		]);
	});
	it("filters repeated nonnumeric footers without removing unique body-like lines in the bottom margin", () => {
		const repeated = line("Journal of Research © 2026", 760);
		const unique = line("This sentence continues the body", 720);
		const pages = new Map([
			[0, selectionMarginCandidates([repeated, unique], size)],
			[1, selectionMarginCandidates([repeated], size)],
		]);
		expect(selectionPageMargins(pages).get(0)).toEqual([repeated.rect]);
		expect(selectionPageMargins(pages).get(1)).toEqual([repeated.rect]);
	});
	it("keeps a left-aligned section number at the top and filters a short right-aligned page number", () => {
		const section = line("IV", 70);
		section.rect.size.width = 20;
		const page = line("S3", 40);
		page.rect.origin.x = 550;
		page.rect.size.width = 20;
		expect(
			selectionPageMargins(
				new Map([[1, selectionMarginCandidates([section, page], size)]]),
			).get(1),
		).toEqual([page.rect]);
	});

	it("uses matching glyph ranges for cross-page highlight and translation, preserving direct header selection", () => {
		const geometry: PdfPageGeometry = {
			runs: [10, 40].map((y, row) => ({
				charStart: row * 3,
				rect: { x: 10, y, width: 30, height: 10 },
				glyphs: Array.from({ length: 3 }, (_, index) => ({
					x: 10 + index * 10,
					y,
					width: 10,
					height: 10,
					flags: 0,
				})),
			})),
		};
		const excluded = [
			{ origin: { x: 10, y: 10 }, size: { width: 30, height: 10 } },
		];
		const cross = { start: { page: 0, index: 1 }, end: { page: 1, index: 5 } };
		expect(selectionTextSlices(geometry, 0, 6, excluded)).toEqual([
			{ start: 3, count: 3 },
		]);
		expect(buildTightSelectionRects(geometry, cross, 1, excluded)).toEqual([
			{ origin: { x: 10, y: 40 }, size: { width: 30, height: 10 } },
		]);
		expect(
			buildTightSelectionRects(
				geometry,
				{ start: { page: 1, index: 0 }, end: { page: 1, index: 2 } },
				1,
				excluded,
			),
		).toEqual(excluded);
	});
});

describe("page text loading", () => {
	it("shares pending prefetches with a cross-page selection and returns detected headers and page numbers", async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		const pending = new Map<number, (rects: PdfTextRectObject[]) => void>();
		const getPageTextRects = vi.fn((_doc, page: { index: number }) => ({
			toPromise: () =>
				new Promise<PdfTextRectObject[]>((resolve) =>
					pending.set(page.index, resolve),
				),
		}));
		const doc = {
			pages: [0, 1].map((index) => ({
				index,
				size: { width: 600, height: 800 },
			})),
		};
		const options = {
			engine: { getPageTextRects } as unknown as PdfEngine,
			docCap: { getDocument: () => doc },
			docId: "doc",
			totalPages: 2,
			currentPage: 1,
			paperTitle: "AgentCompass paper title",
			translates: [],
			threads: [],
			highlights: [],
			visualTraces: [],
		} as unknown as UsePdfPageTextOptions;
		let text!: PdfPageText;
		function Probe() {
			text = usePdfPageText(options);
			return null;
		}
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(() => root.render(createElement(Probe)));
			expect(getPageTextRects).toHaveBeenCalledTimes(2);
			const result = text.ensureSelectionTextExclusions([0, 1]);
			expect(getPageTextRects).toHaveBeenCalledTimes(2);
			await act(async () => {
				for (const [page, resolve] of pending)
					resolve([
						{
							content: options.paperTitle,
							rect: {
								origin: { x: 100, y: 40 },
								size: { width: 300, height: 12 },
							},
						},
						{
							content: String(page + 1),
							rect: {
								origin: { x: 550, y: 760 },
								size: { width: 10, height: 12 },
							},
						},
						...(page === 1
							? [
									{
										content: "Table 4: Recovered caption.",
										rect: {
											origin: { x: 40, y: 200 },
											size: { width: 300, height: 12 },
										},
									},
								]
							: []),
					] as PdfTextRectObject[]);
				const margins = await result;
				expect(margins.get(0)).toHaveLength(1);
				expect(margins.get(1)).toHaveLength(3);
				expect(margins.get(1)).toContainEqual({
					origin: { x: 40, y: 200 },
					size: { width: 300, height: 12 },
				});
			});
			await text.ensureSelectionTextExclusions([0, 1]);
			expect(getPageTextRects).toHaveBeenCalledTimes(2);
		} finally {
			await act(() => root.unmount());
			container.remove();
			vi.unstubAllGlobals();
		}
	});
});

describe("translation DOM text", () => {
	it("copies only translated page text across intervening comments and chrome", () => {
		const host = document.createElement("div");
		host.innerHTML = `<div><p data-layout-item="first">第一页译文</p><aside data-pdf-chrome><p>批注正文</p><textarea>编辑中的批注</textarea></aside></div><div><div data-pdf-chrome>页顶控件</div><p data-layout-item="second">第二页译文</p></div>`;
		document.body.append(host);
		try {
			const first = host.querySelector(
				'[data-layout-item="first"]',
			)?.firstChild;
			const second = host.querySelector(
				'[data-layout-item="second"]',
			)?.firstChild;
			if (!first || !second) throw new Error("Missing translated text");
			const range = document.createRange();
			range.setStart(first, 2);
			range.setEnd(second, 3);
			expect(range.toString()).toContain("批注正文");
			expect(translationTextFromRange(range, host)).toBe("页译文 第二页");
		} finally {
			host.remove();
		}
	});
});
