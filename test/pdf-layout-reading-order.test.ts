import type { PdfTextRun } from "@embedpdf/models";
import { describe, expect, it } from "vitest";
import { documentReadingOrder } from "@/lib/pdf/layout/document-reading-order";
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

describe("documentReadingOrder", () => {
	it("keeps narrow-gutter columns together below a centered preamble", () => {
		const blocks = [
			{ id: "authors", x: 0.25, y: 0.1, w: 0.5, h: 0.04 },
			{ id: "right-top", x: 0.508, y: 0.25, w: 0.44, h: 0.12 },
			{ id: "left-top", x: 0.06, y: 0.26, w: 0.44, h: 0.12 },
			{ id: "right-bottom", x: 0.508, y: 0.4, w: 0.44, h: 0.12 },
			{ id: "left-bottom", x: 0.06, y: 0.41, w: 0.44, h: 0.12 },
		].map(({ id, ...bbox }, readingOrder) => ({
			id,
			bbox,
			readingOrder,
			pageIndex: 0,
			kind: "text",
			text: id,
		}));
		expect(documentReadingOrder(blocks).map((b) => b.id)).toEqual([
			"authors",
			"left-top",
			"left-bottom",
			"right-top",
			"right-bottom",
		]);
	});
});

it("keeps ordinary leading between compact CJK ink bands within one paragraph", () => {
	const region: PdfLayoutRegion = {
		id: "body",
		pageIndex: 0,
		kind: "text",
		score: 1,
		readingOrder: 0,
		bbox: { x: 0.05, y: 0.15, w: 0.7, h: 0.25 },
	};
	const parts = splitBodyRegionAtParagraphGaps(
		region,
		[
			run("材料研究的公开", 40, 130, 100, 10),
			run("报告却很少", 40, 146, 70, 10),
			run("后续内容保持普通行距", 40, 162, 160, 10),
			run("新的段落", 40, 188, 70, 10),
		],
		page,
	);
	expect(parts).toHaveLength(2);
	expect(parts[0].text).toBe("材料研究的公开 报告却很少 后续内容保持普通行距");
});

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
	it("keeps adjacent short math runs on the prose baseline without creating a paragraph gap", () => {
		const region: PdfLayoutRegion = {
			id: "math-prose",
			pageIndex: 0,
			kind: "text",
			label: "text",
			score: 1,
			readingOrder: 0,
			rect: { x: 30, y: 120, w: 420, h: 160 },
			bbox,
		};
		const result = splitBodyRegionAtParagraphGaps(
			region,
			[
				run("Forward current", 40, 148, 100, 10),
				run("–", 140, 150, 5, 4),
				run("voltage (", 145, 148, 34, 10),
				run("I", 179, 148, 4, 10),
				run("–", 183, 150, 5, 4),
				run("V", 188, 148, 7, 10),
				run(")", 195, 148, 3, 10),
				run("characteristics were measured", 40, 160, 200, 10),
			],
			page,
		);
		expect(result).toHaveLength(1);
	});
	it("does not mistake short dashes and raised digits for separate text lines", () => {
		const region: PdfLayoutRegion = {
			id: "p",
			pageIndex: 0,
			kind: "text",
			label: "text",
			score: 1,
			readingOrder: 0,
			rect: { x: 30, y: 120, w: 420, h: 160 },
			bbox,
		};
		const result = splitBodyRegionAtParagraphGaps(
			region,
			[
				run("A continuous sentence", 40, 130, 160, 10),
				run("with a dash", 40, 143, 90, 10),
				run("—", 130, 144, 9, 5),
				run("and more words", 139, 143, 160, 10),
				run("on the next line", 40, 156, 150, 10),
				run("ending here.", 40, 169, 100, 10),
			],
			page,
		);
		expect(result).toHaveLength(1);
	});
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
	it("rejoins previously split cached regions before recalculating paragraph gaps", () => {
		const make = (n: number, y: number, h: number): PdfLayoutRegion => ({
			id: `body::paragraph-${n}`,
			pageIndex: 0,
			kind: "text",
			label: "text",
			score: 0.9,
			readingOrder: n,
			rect: { x: 30, y, w: 250, h },
			bbox: { x: 0.05, y: y / 800, w: 250 / 600, h: h / 800 },
		});
		const out = enrichCaptionRegionsWithText(
			[make(1, 130, 23), make(2, 156, 23)],
			0,
			[
				run("Sentence starts", 30, 130, 200, 10),
				run("and continues", 30, 143, 200, 10),
				run("without a new paragraph", 30, 156, 200, 10),
				run("ending here.", 30, 169, 200, 10),
			],
			page,
		);
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe("body");
	});
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
