import type { PdfTextRun } from "@embedpdf/models";
import { describe, expect, it } from "vitest";

import { orderByReadingLine } from "@/lib/pdf/layout/reading-order";
import {
	enrichCaptionRegionsWithText,
	splitBodyRegionAtParagraphGaps,
	textFromRunsInBbox,
} from "@/lib/pdf/layout/title-text";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

function run(
	text: string,
	x: number,
	y: number,
	width: number,
	height: number,
): PdfTextRun {
	return {
		text,
		rect: { origin: { x, y }, size: { width, height } },
	} as PdfTextRun;
}

const page = { width: 600, height: 800 };
const bbox = { x: 0.05, y: 0.15, w: 0.7, h: 0.25 };

describe("orderByReadingLine", () => {
	it("keeps a taller word on the same baseline in left-to-right order", () => {
		const ordered = orderByReadingLine(
			[
				{ text: "Harbor-Index", x: 207.7, y: 160.5, width: 90, height: 13.6 },
				{
					text: "Our third contribution is",
					x: 108,
					y: 163.03,
					width: 90,
					height: 11,
				},
			],
			(item) => item,
		);
		expect(ordered.map((item) => item.text)).toEqual([
			"Our third contribution is",
			"Harbor-Index",
		]);
	});

	it("places the next baseline below the first line", () => {
		const ordered = orderByReadingLine(
			[
				{ text: "Next", x: 40, y: 190, width: 40, height: 12 },
				{ text: "Harbor-Index", x: 200, y: 160.5, width: 80, height: 13.6 },
				{ text: "Our", x: 40, y: 163, width: 30, height: 11 },
			],
			(item) => item,
		);
		expect(ordered.map((item) => item.text)).toEqual([
			"Our",
			"Harbor-Index",
			"Next",
		]);
	});
});

describe("textFromRunsInBbox", () => {
	it("joins a bold word after the words to its left", () => {
		const text = textFromRunsInBbox(
			[
				run("Harbor-Index", 207.7, 160.5, 90, 13.6),
				run("Our third contribution is", 108, 163.03, 90, 11),
			],
			bbox,
			page.width,
			page.height,
		);
		expect(text).toBe("Our third contribution is Harbor-Index");
	});
});

describe("splitBodyRegionAtParagraphGaps", () => {
	it("keeps baseline order inside a paragraph and splits at a line gap", () => {
		const region: PdfLayoutRegion = {
			id: "body",
			pageIndex: 2,
			kind: "text",
			label: "text",
			score: 0.9,
			readingOrder: 4,
			rect: { x: 30, y: 120, w: 420, h: 160 },
			bbox,
		};
		const parts = splitBodyRegionAtParagraphGaps(
			region,
			[
				run("Harbor-Index", 207.7, 160.5, 90, 13.6),
				run("Our third contribution is", 108, 163.03, 90, 11),
				run("Following sentence here.", 108, 200, 140, 12),
			],
			page,
		);
		expect(parts.map((part) => part.text)).toEqual([
			"Our third contribution is Harbor-Index",
			"Following sentence here.",
		]);
	});
});

describe("enrichCaptionRegionsWithText", () => {
	it("replaces body text that was stored in the old top-to-bottom order", () => {
		const region: PdfLayoutRegion = {
			id: "body",
			pageIndex: 2,
			kind: "text",
			label: "text",
			score: 0.9,
			readingOrder: 4,
			rect: { x: 30, y: 120, w: 420, h: 80 },
			bbox,
			text: "Harbor-Index Our third contribution is",
		};
		const [next] = enrichCaptionRegionsWithText(
			[region],
			2,
			[
				run("Harbor-Index", 207.7, 160.5, 90, 13.6),
				run("Our third contribution is", 108, 163.03, 90, 11),
			],
			page,
		);
		expect(next?.text).toBe("Our third contribution is Harbor-Index");
	});
});
