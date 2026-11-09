import { describe, expect, it } from "vitest";

import {
	mergeClientRectsIntoLines,
	selectionAnchorFromVisible,
	visibleMenuPoint,
	visiblePagesFromClientRects,
	visibleTopCenter,
} from "@/lib/pdf/layout/visible-selection-rects";

const pages = [
	{ pageIndex: 0, left: 0, top: 0, width: 200, height: 400 },
	{ pageIndex: 1, left: 0, top: 420, width: 200, height: 400 },
];

describe("mergeClientRectsIntoLines", () => {
	it("joins character and sentence fragments on one line into a single band", () => {
		expect(
			mergeClientRectsIntoLines([
				{ left: 10, top: 20, width: 14, height: 16 },
				{ left: 28, top: 20, width: 14, height: 16 },
				{ left: 46, top: 21, width: 14, height: 16 },
			]),
		).toEqual([{ left: 10, top: 20, width: 50, height: 17 }]);
	});

	it("splits the strip where two stacked lines overlap", () => {
		expect(
			mergeClientRectsIntoLines([
				{ left: 10, top: 20, width: 80, height: 16 },
				{ left: 10, top: 30, width: 60, height: 16 },
			]),
		).toEqual([
			{ left: 10, top: 20, width: 80, height: 13 },
			{ left: 10, top: 33, width: 60, height: 13 },
		]);
	});

	it("keeps the next line and a distant column as separate bands", () => {
		expect(
			mergeClientRectsIntoLines([
				{ left: 10, top: 20, width: 40, height: 16 },
				{ left: 220, top: 20, width: 40, height: 16 },
				{ left: 10, top: 44, width: 40, height: 16 },
			]),
		).toEqual([
			{ left: 10, top: 20, width: 40, height: 16 },
			{ left: 220, top: 20, width: 40, height: 16 },
			{ left: 10, top: 44, width: 40, height: 16 },
		]);
	});
});

describe("visiblePagesFromClientRects", () => {
	it("maps a client rect to the page that contains its center", () => {
		expect(
			visiblePagesFromClientRects(
				[{ left: 20, top: 40, width: 80, height: 16 }],
				pages,
			),
		).toEqual([{ pageIndex: 0, rects: [{ x: 0.1, y: 0.1, w: 0.4, h: 0.04 }] }]);
	});

	it("clips a rect that hangs off the page and drops empty or outside rects", () => {
		expect(
			visiblePagesFromClientRects(
				[
					{ left: -10, top: 8, width: 30, height: 12 },
					{ left: 0, top: 0, width: 0, height: 10 },
					{ left: 500, top: 10, width: 20, height: 10 },
				],
				pages,
			),
		).toEqual([{ pageIndex: 0, rects: [{ x: 0, y: 0.02, w: 0.1, h: 0.03 }] }]);
	});

	it("keeps each page's rects and sorts pages", () => {
		expect(
			visiblePagesFromClientRects(
				[
					{ left: 10, top: 450, width: 40, height: 12 },
					{ left: 10, top: 20, width: 40, height: 12 },
				],
				pages,
			),
		).toEqual([
			{ pageIndex: 0, rects: [{ x: 0.05, y: 0.05, w: 0.2, h: 0.03 }] },
			{ pageIndex: 1, rects: [{ x: 0.05, y: 0.075, w: 0.2, h: 0.03 }] },
		]);
	});
});

describe("selectionAnchorFromVisible", () => {
	it("anchors the note chip to the top of the last visible page", () => {
		expect(
			selectionAnchorFromVisible([
				{ pageIndex: 0, rects: [{ x: 0.1, y: 0.4, w: 0.2, h: 0.02 }] },
				{
					pageIndex: 2,
					rects: [
						{ x: 0.2, y: 0.6, w: 0.3, h: 0.02 },
						{ x: 0.2, y: 0.5, w: 0.3, h: 0.02 },
					],
				},
			]),
		).toEqual({ page: 3, anchorY: 0.5 });
		expect(selectionAnchorFromVisible([])).toBeNull();
	});
});

describe("visibleMenuPoint", () => {
	it("places the toolbar on the preferred page's top center", () => {
		const frames = visiblePagesFromClientRects(
			[
				{ left: 40, top: 80, width: 80, height: 16 },
				{ left: 10, top: 460, width: 40, height: 12 },
			],
			pages,
		);
		expect(visibleTopCenter(frames[0]?.rects ?? [])).toEqual({
			x: 0.4,
			y: 0.2,
		});
		const point = visibleMenuPoint(frames, 0, (pageIndex) => {
			const page = pages.find((item) => item.pageIndex === pageIndex);
			return page ?? null;
		});
		expect(point).toMatchObject({ x: 80, y: 80, top: 80 });
		expect(point?.bottom).toBeCloseTo(96);
		expect(
			visibleMenuPoint(
				frames,
				0,
				(pageIndex) => {
					const page = pages.find((item) => item.pageIndex === pageIndex);
					return page ?? null;
				},
				0.75,
			)?.cursorX,
		).toBeCloseTo(150);
	});
});
