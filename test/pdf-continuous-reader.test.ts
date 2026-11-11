import { describe, expect, it } from "vitest";
import type {
	LayoutTranslateItem,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";
import { buildReadingBlocks } from "@/lib/pdf/reading/blocks";
import { normalizeReadingSettings } from "@/lib/pdf/reading/settings";
import type { Paragraph } from "@/lib/pdf/reflow/types";

function region(
	id: string,
	kind: PdfLayoutRegion["kind"],
	x: number,
	y: number,
	text?: string,
): PdfLayoutRegion {
	return {
		id,
		kind,
		label: kind,
		pageIndex: 0,
		score: 0.9,
		readingOrder: y,
		text,
		bbox: { x, y, w: 0.4, h: 0.1 },
		rect: { x: x * 600, y: y * 800, w: 240, h: 80 },
	};
}
function item(r: PdfLayoutRegion, translated?: string): LayoutTranslateItem {
	return {
		...r,
		source: r.text ?? "",
		status: translated ? "done" : "pending",
		translated,
	};
}
function paragraph(
	r: PdfLayoutRegion,
	protectedText: string,
	formulaBox: Paragraph["box"],
): Paragraph {
	return {
		id: r.id,
		pageIndex: r.pageIndex,
		box: r.rect,
		characters: [],
		styles: {},
		formulas: [
			{
				id: "0",
				text: "E=mc²",
				box: formulaBox,
				characterIndexes: [],
				baselineOffset: 0,
			},
		],
		source: protectedText.replace("⟪F0⟫", "E=mc²"),
		protectedText,
		style: {
			font: "serif",
			size: 12,
			bold: false,
			italic: false,
			color: { r: 0, g: 0, b: 0 },
		},
		firstLineIndent: 0,
		heading: false,
	};
}

describe("continuous reader settings", () => {
	it("bounds malformed persisted numbers and ignores unknown themes", () => {
		expect(
			normalizeReadingSettings({
				lineHeight: 99,
				wordSpacing: -500,
				characterSpacing: Number.NaN,
				pageWidth: 0,
				theme: "invalid",
				foreground: "red",
				background: "#123456",
			}),
		).toMatchObject({
			lineHeight: 2.5,
			wordSpacing: -20,
			characterSpacing: 0,
			pageWidth: 35,
			theme: "original",
			foreground: "#202124",
			background: "#123456",
		});
	});
});

describe("continuous reader blocks", () => {
	it("retains hydrated sentence pairs for reader selection without replacing source geometry", () => {
		const r = region("sentences", "text", 0.1, 0.2, "First. Second.");
		const prepared = {
			...item(r),
			reflow: { ...paragraph(r, r.text ?? "", r.rect), formulas: [] },
		};
		const translated = {
			...item(r, "第一句。第二句。"),
			sentences: [
				{ quote: "First.", source: "First.", translated: "第一句。" },
				{ quote: "Second.", source: "Second.", translated: "第二句。" },
			],
		};
		const [block] = buildReadingBlocks([r], [prepared], [translated]);
		expect(block.item?.sentences).toEqual(translated.sentences);
		expect(block.item?.reflow).toBe(prepared.reflow);
	});
	it("does not reinsert a broad OCR duplicate spanning several prepared references", () => {
		const first = region(
			"first",
			"text",
			0.1,
			0.2,
			"3. Choudhary A. Detection methods.",
		);
		const second = region(
			"second",
			"text",
			0.1,
			0.3,
			"4. Maione C. Machine learning.",
		);
		const duplicate = {
			...region(
				"duplicate",
				"text",
				0.1,
				0.2,
				"3. Choudhar y A. Detection meth ods. 4. Maione C. Mach ine learning.",
			),
			bbox: { x: 0.1, y: 0.2, w: 0.4, h: 0.2 },
		};
		const outside = {
			...duplicate,
			id: "outside",
			bbox: { ...duplicate.bbox, x: 0.6 },
		};
		const extra = {
			...duplicate,
			id: "extra",
			text: `${duplicate.text} Additional undetected reference.`,
		};
		const prepared = [first, second].map((r) => ({
			...item(r),
			reflow: { ...paragraph(r, r.text ?? "", r.rect), formulas: [] },
		}));
		const blocks = buildReadingBlocks(
			[first, second, duplicate, outside],
			prepared,
		);
		expect(blocks.map((b) => b.id)).not.toContain("duplicate");
		expect(blocks.map((b) => b.id)).toEqual(
			expect.arrayContaining(["first", "second", "outside"]),
		);
		expect(
			buildReadingBlocks([first, second, extra], prepared).map((b) => b.id),
		).toContain("extra");
	});
	it("keeps a lowercase prose continuation out of the heading hierarchy", () => {
		const continuation = region(
			"continuation",
			"header",
			0.1,
			0.2,
			"ablation studies can be found in the appendix.",
		);
		continuation.label = "paragraph_title";
		const heading = region("heading", "header", 0.1, 0.4, "5.1 Evaluation");
		const source = item(continuation);
		source.reflow = {
			...paragraph(continuation, source.source, continuation.rect),
			formulas: [],
		};
		const out = buildReadingBlocks([continuation, heading], [source]);
		expect(out.find((b) => b.id === continuation.id)?.kind).toBe("text");
		expect(out.find((b) => b.id === heading.id)?.kind).toBe("header");
	});
	it("does not duplicate table cells whose painted glyphs are already inside the crop", () => {
		const table = region("table", "table", 0.1, 0.08);
		const cell = region("table:cell:6", "text", 0.3, 0.077, "Dev Set");
		cell.bbox = { x: 0.3, y: 0.077, w: 0.05, h: 0.013 };
		cell.rect = { x: 180, y: 61.6, w: 30, h: 10.4 };
		const source = item(cell);
		const p = paragraph(cell, "Dev Set", cell.rect);
		source.reflow = {
			...p,
			formulas: [],
			characters: Array.from("Dev Set", (text, index) => ({
				index,
				text,
				box: { x: 180 + index * 4, y: 61.6, w: 4, h: 10.4 },
				visualBox: { x: 180 + index * 4, y: 65, w: 4, h: 6 },
				style: p.style,
			})),
		};
		const out = buildReadingBlocks([table], [source]);
		expect(out.map((b) => b.id)).toEqual(["table"]);
	});
	it("keeps text outside a table when its painted glyphs extend beyond the crop", () => {
		const table = region("table", "table", 0.1, 0.08);
		const caption = region("above", "text", 0.3, 0.06, "Table heading");
		caption.bbox = { x: 0.3, y: 0.06, w: 0.1, h: 0.02 };
		const source = item(caption);
		const p = paragraph(caption, source.source, {
			x: 180,
			y: 48,
			w: 60,
			h: 16,
		});
		source.reflow = {
			...p,
			formulas: [],
			characters: [
				{
					index: 0,
					text: "Table heading",
					box: { x: 180, y: 48, w: 60, h: 16 },
					visualBox: { x: 180, y: 50, w: 60, h: 8 },
					style: p.style,
				},
			],
		};
		expect(
			buildReadingBlocks([table], [source]).some((b) => b.id === caption.id),
		).toBe(true);
	});
	it("removes short repeated side-margin stamps before inferring the body columns", () => {
		const left = region("left", "text", 0.23, 0.2, "Left column begins.");
		left.bbox.w = 0.35;
		const leftEnd = region("left-end", "text", 0.23, 0.6, "Left column ends.");
		leftEnd.bbox.w = 0.35;
		const right = region("right", "text", 0.6, 0.2, "Right column begins.");
		right.bbox.w = 0.35;
		const stamps = [0, 1].map((pageIndex) => ({
			...region(`stamp-${pageIndex}`, "text", 0.967, 0.8, "by guest ."),
			pageIndex,
			bbox: { x: 0.967, y: 0.8, w: 0.017, h: 0.05 },
		}));
		const out = buildReadingBlocks([left, leftEnd, right, ...stamps], []);
		expect(out.map((b) => b.id)).toEqual(["left", "left-end", "right"]);
	});
	it("keeps numbered display equations between their surrounding prose", () => {
		const before = {
			...region("before", "text", 0.1, 0.1, "Assume that"),
			readingOrder: 20,
		};
		const formula = {
			...region("equation", "formula", 0.1, 0.3),
			bbox: { x: 0.1, y: 0.3, w: 0.6, h: 0.03 },
			readingOrder: 30,
		};
		const number = {
			...region("number", "formula_number", 0.75, 0.3, "(2)"),
			bbox: { x: 0.75, y: 0.3, w: 0.04, h: 0.03 },
			readingOrder: 31,
		};
		const after = {
			...region("after", "text", 0.1, 0.5, "Then the proof follows."),
			readingOrder: 40,
		};
		expect(
			buildReadingBlocks(
				[before, formula, number, after],
				[item(before), item(after)],
			).map((b) => b.id),
		).toEqual(["before", "number", "after"]);
	});
	it("uses overlapping panel evidence to retain the top edge of a composed figure", () => {
		const panel = {
			...region("panel", "image", 0.1, 0.12),
			bbox: { x: 0.1, y: 0.12, w: 0.8, h: 0.28 },
		};
		const edge = {
			...region("edge", "image", 0.12, 0.1),
			score: 0.16,
			bbox: { x: 0.12, y: 0.1, w: 0.7, h: 0.2 },
		};
		const caption = {
			...region(
				"caption",
				"figure_title",
				0.1,
				0.42,
				"Fig. 1. The complete figure.",
			),
			bbox: { x: 0.1, y: 0.42, w: 0.8, h: 0.04 },
		};
		const out = buildReadingBlocks([panel, edge, caption], []);
		expect(out.find((b) => b.id === "panel")?.bbox.y).toBeCloseTo(0.1);
	});
	it("combines adjacent code fragments and suppresses crops already containing the same code", () => {
		const mono = (id: string, y: number, text: string) => {
			const r = {
				...region(id, "text", 0.1, y, text),
				bbox: { x: 0.1, y, w: 0.35, h: 0.03 },
				rect: { x: 60, y: y * 800, w: 210, h: 24 },
			};
			const p = paragraph(r, text, r.rect);
			p.formulas = [];
			p.characters = [...text].map((text, index) => ({
				index,
				text,
				box: { x: 60 + index * 6, y: y * 800, w: 6, h: 10 },
				visualBox: { x: 60 + index * 6, y: y * 800, w: 6, h: 10 },
				style: { ...p.style, font: "Courier" },
			}));
			return { r, source: { ...item(r), reflow: p } };
		};
		const head = mono("head", 0.2, "module example;"),
			tail = mono("tail", 0.24, "endmodule");
		const code = buildReadingBlocks(
			[head.r, tail.r],
			[head.source, tail.source],
		);
		expect(code).toHaveLength(1);
		expect(code[0].bbox.h).toBeCloseTo(0.07);
		const detected = {
			...region("visual-code", "image", 0.09, 0.19),
			bbox: { x: 0.09, y: 0.19, w: 0.38, h: 0.09 },
		};
		const deduped = buildReadingBlocks(
			[head.r, tail.r, detected],
			[head.source, tail.source],
		);
		expect(deduped).toHaveLength(1);
		expect(deduped[0].id).toBe("visual-code");
	});
	it("keeps adjacent code examples separate when prose is between them", () => {
		const source = (id: string, y: number) => {
			const r = {
				...region(id, "text", 0.1, y, "code"),
				bbox: { x: 0.1, y, w: 0.3, h: 0.02 },
				rect: { x: 60, y: y * 800, w: 180, h: 16 },
			};
			const p = paragraph(r, "code", r.rect);
			p.characters = [
				{
					index: 0,
					text: "code",
					box: r.rect,
					visualBox: r.rect,
					style: { ...p.style, font: "Courier" },
				},
			];
			return { r, source: { ...item(r), reflow: p } };
		};
		const a = source("a", 0.2),
			b = source("b", 0.24);
		const caption = {
			...region("caption", "text", 0.1, 0.225, "Example 1"),
			bbox: { x: 0.1, y: 0.225, w: 0.3, h: 0.01 },
		};
		expect(
			buildReadingBlocks([a.r, caption, b.r], [a.source, b.source]),
		).toHaveLength(3);
	});
	it("preserves monospaced source geometry when the detector calls code ordinary text", () => {
		const r = region(
			"code",
			"text",
			0.1,
			0.2,
			"if (ready) // comment\n  q <= d;",
		);
		const p = paragraph(r, r.text ?? "", r.rect);
		p.formulas = [];
		p.characters = ["i", "f", "q", ";"].map((text, index) => ({
			index,
			text,
			box: { x: 58 + index * 6, y: 160, w: 6, h: 10 },
			visualBox: { x: 58 + index * 6, y: 160, w: 6, h: 10 },
			style: { ...p.style, font: "ABCDEE+CourierNewPS-BoldMT" },
		}));
		const [block] = buildReadingBlocks([r], [{ ...item(r), reflow: p }]);
		expect(block.kind).toBe("algorithm");
		expect(block.image?.bbox.x).toBeCloseTo(58 / 600);
		expect(block.text).toBe(r.text);
	});
	it("keeps labelled article metadata below the abstract and before both prose columns", () => {
		const abstract = {
			...region("abstract", "abstract", 0.1, 0.2, "Article abstract."),
			bbox: { x: 0.1, y: 0.2, w: 0.8, h: 0.12 },
		};
		const classification = {
			...region("classification", "text", 0.12, 0.34, "PACS: 81.05.ug"),
			bbox: { x: 0.12, y: 0.34, w: 0.3, h: 0.02 },
		};
		const doi = {
			...region("doi", "text", 0.6, 0.34, "DOI: 10.1234/example"),
			bbox: { x: 0.6, y: 0.34, w: 0.3, h: 0.02 },
		};
		const heading = {
			...region("heading", "header", 0.1, 0.4, "1 Introduction"),
			label: "paragraph_title",
		};
		const left = region("left", "text", 0.1, 0.45, "A paragraph ending with a");
		const right = region("right", "text", 0.55, 0.4, "continued sentence.");
		const regions = [abstract, classification, heading, left, doi, right];
		expect(
			buildReadingBlocks(
				regions,
				regions.map((r) => item(r)),
			).map((b) => b.id),
		).toEqual([
			"abstract",
			"classification",
			"doi",
			"heading",
			"left",
			"right",
		]);
	});
	it("keeps first-page authors even when they also occur in running headers", () => {
		const authors = {
			...region("authors", "text", 0.2, 0.15, "Alice Author, Bob Writer"),
			bbox: { x: 0.2, y: 0.15, w: 0.6, h: 0.03 },
		};
		const header = {
			...region("running", "header", 0.5, 0.05, authors.text),
			label: "header",
			pageIndex: 1,
			bbox: { x: 0.5, y: 0.05, w: 0.4, h: 0.025 },
		};
		const out = buildReadingBlocks(
			[authors, header, { ...header, id: "running2", pageIndex: 2 }],
			[],
		);
		expect(out.map((b) => b.id)).toEqual(["authors"]);
	});
	it("recognizes a lone running author header from the first-page author line", () => {
		const authors = {
			...region(
				"authors",
				"text",
				0.2,
				0.15,
				"Alice Author1,2, Benjamin Writer2, Charlotte Researcher1†",
			),
			bbox: { x: 0.2, y: 0.15, w: 0.6, h: 0.04 },
		};
		const header = {
			...region(
				"running",
				"header",
				0.52,
				0.05,
				"Alice Author1,2 Benjamin Writer2, Charlotte Researcher1†",
			),
			pageIndex: 3,
			bbox: { x: 0.52, y: 0.05, w: 0.4, h: 0.03 },
		};
		const body = {
			...header,
			id: "body",
			kind: "text" as const,
			label: "text",
			bbox: { ...header.bbox, y: 0.4 },
		};
		const different = {
			...header,
			id: "different",
			pageIndex: 4,
			text: "Alice Author, Benjamin Writer, Diana Researcher",
		};
		const section = {
			...header,
			id: "section",
			pageIndex: 5,
			label: "paragraph_title",
		};
		const out = buildReadingBlocks(
			[authors, header, body, different, section],
			[],
		);
		expect(out.map((b) => b.id)).toEqual([
			"authors",
			"body",
			"different",
			"section",
		]);
	});
	it("removes repeated vertical edge notices from reading prose", () => {
		const side = {
			...region(
				"side",
				"text",
				0.97,
				0.02,
				"Downloaded from publisher on 2026-11-08",
			),
			bbox: { x: 0.97, y: 0.02, w: 0.015, h: 0.95 },
		};
		expect(
			buildReadingBlocks([side, { ...side, id: "side2", pageIndex: 1 }], []),
		).toEqual([]);
	});
	it("keeps a partly protected inline ratio in its caption without a duplicate crop", () => {
		const body = region(
			"caption",
			"figure_title",
			0.05,
			0.1,
			"Table II. Ratios.",
		);
		const formula = {
			...region("ratio", "formula", 0.1, 0.12),
			bbox: { x: 0.1, y: 0.12, w: 0.035, h: 0.0125 },
			rect: { x: 60, y: 96, w: 21, h: 10 },
		};
		const reflow = paragraph(body, "Table II. NV⟪F0⟫ ratios.", {
			x: 57,
			y: 100,
			w: 23,
			h: 7,
		});
		expect(
			buildReadingBlocks(
				[body, formula],
				[{ ...item(body), source: reflow.protectedText, reflow }],
			).map((b) => b.id),
		).toEqual(["caption"]);
	});
	it("does not duplicate a table cell as a standalone formula", () => {
		const table = region("table", "table", 0.05, 0.1);
		const cell = {
			...region("cell", "formula", 0.1, 0.12),
			bbox: { x: 0.1, y: 0.12, w: 0.08, h: 0.02 },
		};
		expect(buildReadingBlocks([table, cell], []).map((b) => b.id)).toEqual([
			"table",
		]);
	});
	it("recognizes an inline expression even when its detector box excludes the parenthesis", () => {
		const body = region("body", "text", 0.05, 0.1, "The energy is E(x).");
		const formula = {
			...region("formula", "formula", 0.1, 0.12),
			bbox: { x: 0.1, y: 0.12, w: 0.05, h: 0.02 },
			rect: { x: 60, y: 96, w: 30, h: 16 },
		};
		const reflow = paragraph(body, "The energy is ⟪F0⟫.", {
			x: 60,
			y: 96,
			w: 45,
			h: 16,
		});
		expect(
			buildReadingBlocks(
				[body, formula],
				[{ ...item(body), source: reflow.protectedText, reflow }],
			).map((b) => b.id),
		).toEqual(["body"]);
	});
	it("keeps image-only panel labels above a figure without pulling in the page header", () => {
		const picture = {
			...region("picture", "image", 0.08, 0.11),
			bbox: { x: 0.08, y: 0.11, w: 0.84, h: 0.14 },
		};
		const labels = [
			{
				...region("figure-heading", "figure_title", 0.24, 0.076),
				bbox: { x: 0.24, y: 0.076, w: 0.5, h: 0.016 },
			},
			{
				...region("panel-a", "figure_title", 0.1, 0.097),
				bbox: { x: 0.1, y: 0.097, w: 0.025, h: 0.014 },
			},
		];
		const caption = {
			...region("caption", "figure_title", 0.06, 0.26, "FIG. 1. A process."),
			bbox: { x: 0.06, y: 0.26, w: 0.88, h: 0.03 },
		};
		const header = {
			...region("header", "header", 0.6, 0.04, "Journal"),
			bbox: { x: 0.6, y: 0.04, w: 0.3, h: 0.015 },
		};
		const blocks = buildReadingBlocks(
			[picture, ...labels, caption, header],
			[item(caption), item(header)],
		);
		expect(blocks.find((b) => b.image)?.bbox).toMatchObject({
			x: 0.08,
			y: 0.076,
			w: 0.84,
			h: expect.closeTo(0.174),
		});
		expect(blocks.filter((b) => b.id === caption.id)).toHaveLength(1);
	});
	it("does not resurrect OCR for a fully claimed boundary line", () => {
		const whole = {
			...region("whole", "text", 0.1, 0.1, "An institute. Address line."),
			bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.04 },
		};
		const remainder = {
			...region("remainder", "text", 0.3, 0.13, "Address line."),
			bbox: { x: 0.3, y: 0.13, w: 0.3, h: 0.015 },
		};
		const prepared = {
			...item(whole),
			bbox: { ...whole.bbox, h: 0.042 },
			reflow: {
				...paragraph(whole, whole.text ?? "", whole.rect),
				formulas: [],
				source: whole.text ?? "",
				protectedText: whole.text ?? "",
			},
		};
		expect(
			buildReadingBlocks([whole, remainder], [prepared]).map((b) => b.text),
		).toEqual([whole.text]);
	});
	it("removes repeated short margin headers and article pagination before detecting columns", () => {
		const regions = [0, 1].flatMap((pageIndex) => [
			{
				...region(`header-${pageIndex}`, "header", 0.06, 0.04, "DOE et al."),
				pageIndex,
				bbox: { x: 0.06, y: 0.04, w: 0.12, h: 0.015 },
			},
			{
				...region(
					`page-${pageIndex}`,
					"text",
					0.46,
					0.96,
					`045201-${pageIndex + 1}`,
				),
				pageIndex,
				bbox: { x: 0.46, y: 0.96, w: 0.08, h: 0.015 },
			},
			...[
				region(
					`left-a-${pageIndex}`,
					"text",
					0.06,
					0.3,
					"First left paragraph.",
				),
				region(
					`right-a-${pageIndex}`,
					"text",
					0.51,
					0.3,
					"First right paragraph.",
				),
				region(
					`left-b-${pageIndex}`,
					"text",
					0.06,
					0.5,
					"Second left paragraph.",
				),
				region(
					`right-b-${pageIndex}`,
					"text",
					0.51,
					0.5,
					"Second right paragraph.",
				),
			].map((r) => ({ ...r, pageIndex })),
		]);
		expect(
			buildReadingBlocks(
				regions,
				regions.map((r) => item(r)),
			).map((b) => b.id),
		).toEqual(
			[0, 1].flatMap((p) => [
				`left-a-${p}`,
				`left-b-${p}`,
				`right-a-${p}`,
				`right-b-${p}`,
			]),
		);
	});
	it("keeps a captioned two-by-two figure in one crop before the following columns", () => {
		const panels = [
			[0.2, 0.08],
			[0.52, 0.08],
			[0.2, 0.23],
			[0.52, 0.23],
		].map(([x, y], i) => ({
			...region(`panel-${i}`, i === 2 ? "chart" : "image", x, y),
			bbox: { x, y, w: 0.27, h: 0.13 },
			rect: { x: x * 600, y: y * 800, w: 162, h: 104 },
		}));
		const caption = {
			...region("caption", "figure_title", 0.15, 0.38, "Fig. 7. Four panels."),
			bbox: { x: 0.15, y: 0.38, w: 0.7, h: 0.02 },
		};
		const prose = [
			region("left", "text", 0.05, 0.43, "Left prose."),
			region("right", "text", 0.55, 0.43, "Right prose."),
		];
		const blocks = buildReadingBlocks(
			[...panels, caption, ...prose],
			[item(caption), ...prose.map((r) => item(r))],
		);
		expect(blocks.filter((b) => b.image)).toHaveLength(1);
		expect(blocks[0].bbox).toEqual({
			x: 0.2,
			y: 0.08,
			w: expect.closeTo(0.59),
			h: expect.closeTo(0.28),
		});
		expect(blocks.map((b) => b.id)).toEqual([
			"panel-0",
			"caption",
			"left",
			"right",
		]);
	});
	it("places a floating table after the continued paragraph rather than between its columns", () => {
		const left = region(
			"left",
			"text",
			0.05,
			0.3,
			"The material is an anisotropic",
		);
		const right = region(
			"right",
			"text",
			0.55,
			0.3,
			"crystal with low resistance.",
		);
		const next = region("next", "text", 0.55, 0.45, "A new paragraph.");
		const caption = region(
			"caption",
			"figure_title",
			0.05,
			0.7,
			"Table 3 Parameters.",
		);
		const table = region("table", "table", 0.05, 0.82);
		expect(
			buildReadingBlocks(
				[left, right, next, caption, table],
				[left, right, next, caption].map((r) => item(r)),
			).map((b) => b.id),
		).toEqual(["left", "right", "caption", "table", "next"]);
		left.text = "The first paragraph ends here.";
		expect(
			buildReadingBlocks(
				[left, right, next, caption, table],
				[left, right, next, caption].map((r) => item(r)),
			).map((b) => b.id),
		).toEqual(["left", "caption", "table", "right", "next"]);
	});
	it("keeps page order when a continuation follows a full-width figure on the next page", () => {
		const head = region(
			"head",
			"text",
			0.05,
			0.7,
			"The first page ends with a",
		);
		const picture = {
			...region("picture", "image", 0.05, 0.08),
			pageIndex: 1,
			bbox: { x: 0.05, y: 0.08, w: 0.9, h: 0.2 },
		};
		const tail = {
			...region("tail", "text", 0.05, 0.4, "continued sentence."),
			pageIndex: 1,
		};
		expect(
			buildReadingBlocks([head, picture, tail], [item(head), item(tail)]).map(
				(b) => b.id,
			),
		).toEqual(["head", "picture", "tail"]);
	});
	it("retains unpaired footnotes on a page without prose", () => {
		const note = {
			...region("note", "text", 0.05, 0.85, "A preserved footnote."),
			label: "footnote",
		};
		expect(buildReadingBlocks([note], [item(note)]).map((b) => b.id)).toEqual([
			"note",
		]);
	});
	it("retains numbered prose footnotes misclassified as a footer", () => {
		const note = {
			...region(
				"note",
				"text",
				0.09,
				0.879,
				"1See Author and Colleague (2008) for an explanation of these results.",
			),
			label: "footer",
			bbox: { x: 0.09, y: 0.879, w: 0.73, h: 0.017 },
		};
		expect(buildReadingBlocks([note], [item(note)]).map((b) => b.id)).toEqual([
			"note",
		]);
	});
	it("does not group distinct figures separated by another caption or prose", () => {
		const upper = region("upper", "image", 0.1, 0.1);
		const caption1 = {
			...region("caption1", "figure_title", 0.1, 0.22, "Fig. 3. First."),
			bbox: { x: 0.1, y: 0.22, w: 0.7, h: 0.02 },
		};
		const prose = region(
			"middle",
			"text",
			0.1,
			0.3,
			"An intervening paragraph.",
		);
		const lower = region("lower", "image", 0.1, 0.45);
		const caption2 = {
			...region("caption2", "figure_title", 0.1, 0.57, "Fig. 4. Second."),
			bbox: { x: 0.1, y: 0.57, w: 0.7, h: 0.02 },
		};
		const rs = [upper, caption1, prose, lower, caption2];
		expect(
			buildReadingBlocks(
				rs,
				rs.filter((r) => r.text).map((r) => item(r)),
			)
				.filter((b) => b.image)
				.map((b) => b.id),
		).toEqual(["upper", "lower"]);
	});
	it("removes repeated running headers and publisher footers while retaining title and author notes", () => {
		const header = {
			...region(
				"running-1",
				"header",
				0.3,
				0.03,
				"Research Journal 42 (2024) 20–26",
			),
			label: "header",
			bbox: { x: 0.3, y: 0.03, w: 0.4, h: 0.015 },
		};
		const other = { ...header, id: "running-2", pageIndex: 1 };
		const title = {
			...region("title", "header", 0.08, 0.12, "A novel device"),
			label: "doc_title",
		};
		const footer = {
			...region(
				"footer",
				"text",
				0.05,
				0.92,
				"© 2024 Publisher. All rights reserved.",
			),
			label: "footer",
			bbox: { x: 0.05, y: 0.92, w: 0.4, h: 0.02 },
		};
		const note = {
			...region(
				"note",
				"text",
				0.05,
				0.84,
				"Corresponding author. Contact details.",
			),
			label: "footnote",
		};
		const body = [
			region("body-left", "text", 0.05, 0.3, "First paragraph."),
			region("body-right", "text", 0.55, 0.3, "Second paragraph."),
		];
		const rs = [header, other, title, footer, note, ...body];
		const blocks = buildReadingBlocks(
			rs,
			rs.map((r) => item(r)),
		);
		expect(blocks.map((b) => b.id)).not.toContain("running-1");
		expect(blocks.map((b) => b.id)).not.toContain("running-2");
		expect(blocks.map((b) => b.id)).not.toContain("footer");
		expect(blocks.map((b) => b.id)).toEqual([
			"title",
			"body-left",
			"body-right",
			"note",
		]);
	});
	it("omits detected and recovered page markers while retaining body numbers and equation labels", () => {
		const pageHeader = {
			...region("page-header", "header", 0.15, 0.04, "Page 8 of 25"),
			bbox: { x: 0.15, y: 0.04, w: 0.15, h: 0.02 },
		};
		const articleNumber = {
			...region("article-number", "text", 0.1, 0.04, "8"),
			label: "number",
			bbox: { x: 0.1, y: 0.04, w: 0.02, h: 0.02 },
		};
		const recoveredFooter = {
			...region("recovered-footer", "text", 0.5, 0.95, "25"),
			bbox: { x: 0.5, y: 0.95, w: 0.04, h: 0.02 },
		};
		const bodyNumber = region("body-number", "text", 0.1, 0.4, "8");
		const heading = region("heading", "header", 0.1, 0.08, "8 Conclusions");
		const equation = region(
			"equation-number",
			"formula_number",
			0.8,
			0.05,
			"(8)",
		);
		const regions = [pageHeader, articleNumber, bodyNumber, heading, equation];
		const blocks = buildReadingBlocks(
			regions,
			[...regions.map((r) => item(r)), item(recoveredFooter)],
			[item(pageHeader, "第8页，共25页"), item(articleNumber, "8")],
		);
		expect(blocks.map((block) => block.id)).toEqual(
			expect.arrayContaining(["body-number", "heading", "equation-number"]),
		);
		expect(blocks).toHaveLength(3);
	});
	it("reads the left column before the right column and retains captions and figures", () => {
		const regions = [
			region("right", "text", 0.55, 0.15, "Right column"),
			region("left-bottom", "text", 0.05, 0.4, "Left ending"),
			region("image", "image", 0.05, 0.55),
			region("left", "text", 0.05, 0.15, "Left opening"),
			region("caption", "figure_title", 0.05, 0.7, "Figure 1"),
		];
		const blocks = buildReadingBlocks(
			regions,
			regions.filter((r) => r.text).map((r) => item(r)),
		);
		expect(blocks.map((b) => b.id)).toEqual([
			"left",
			"left-bottom",
			"image",
			"caption",
			"right",
		]);
	});
	it("keeps side-captioned figure panels together before the following two-column prose", () => {
		const caption = {
			...region(
				"caption",
				"figure_title",
				0.08,
				0.53,
				"Fig. 2 a Device. b Performance.",
			),
			bbox: { x: 0.08, y: 0.53, w: 0.19, h: 0.06 },
		};
		const left = {
			...region("panel-a", "image", 0.34, 0.53),
			bbox: { x: 0.34, y: 0.53, w: 0.27, h: 0.19 },
		};
		const right = {
			...region("panel-b", "chart", 0.62, 0.53),
			bbox: { x: 0.62, y: 0.53, w: 0.3, h: 0.19 },
		};
		const earlier = {
			...region("earlier-figure", "image", 0.34, 0.08),
			bbox: { x: 0.34, y: 0.08, w: 0.58, h: 0.43 },
		};
		const prose = [
			region("body-left", "text", 0.08, 0.75, "Left prose"),
			region("body-right", "text", 0.51, 0.75, "Right prose"),
		];
		const blocks = buildReadingBlocks(
			[caption, left, right, earlier, ...prose],
			[item(caption), ...prose.map((r) => item(r))],
			[item(caption, "图 2 a 器件。b 性能。")],
		);
		expect(blocks.map((block) => block.id)).toEqual([
			"earlier-figure",
			"panel-a",
			"caption",
			"body-left",
			"body-right",
		]);
		expect(blocks[1]?.bbox).toEqual({
			x: 0.34,
			y: 0.53,
			w: expect.closeTo(0.58),
			h: expect.closeTo(0.19),
		});
		expect(blocks[2]?.translated).toBe("图 2 a 器件。b 性能。");
	});
	it("inserts recovered text before and between detected paragraphs", () => {
		const first = {
			...region("first", "text", 0.05, 0.3, "First detected"),
			readingOrder: 0,
		};
		const last = {
			...region("last", "text", 0.05, 0.7, "Last detected"),
			readingOrder: 1,
		};
		const recovered = [
			region("before", "text", 0.05, 0.1, "Recovered opening"),
			region("between", "text", 0.05, 0.5, "Recovered middle"),
		].map(
			(r): LayoutTranslateItem => ({
				...item(r),
				readingOrder: 10000 + r.rect.y,
				reflow: {
					...paragraph(r, r.text ?? "", r.rect),
					formulas: [],
					origin: "fallback",
				},
			}),
		);
		const blocks = buildReadingBlocks(
			[first, last],
			[item(first), item(last), ...recovered],
		);
		expect(blocks.map((block) => block.text)).toEqual([
			"Recovered opening",
			"First detected",
			"Recovered middle",
			"Last detected",
		]);
	});
	it("orders recovered column text within bands separated by full-width headings and figures", () => {
		const heading = {
			...region("heading", "header", 0.05, 0.05, "Heading"),
			bbox: { x: 0.05, y: 0.05, w: 0.9, h: 0.05 },
		};
		const figure = {
			...region("figure", "image", 0.05, 0.5),
			bbox: { x: 0.05, y: 0.5, w: 0.9, h: 0.1 },
		};
		const detected = [
			region("left", "text", 0.05, 0.3, "Left detected"),
			region("right", "text", 0.55, 0.3, "Right detected"),
			region("after", "text", 0.05, 0.8, "After figure"),
		];
		const recovered = [
			region("left-before", "text", 0.05, 0.15, "Left opening"),
			region("right-before", "text", 0.55, 0.15, "Right opening"),
			region("after-before", "text", 0.05, 0.65, "Recovered after figure"),
		].map(
			(r): LayoutTranslateItem => ({
				...item(r),
				readingOrder: 10000 + r.rect.y,
				reflow: {
					...paragraph(r, r.text ?? "", r.rect),
					formulas: [],
					origin: "fallback",
				},
			}),
		);
		expect(
			buildReadingBlocks(
				[heading, ...detected, figure],
				[...detected.map((r) => item(r)), ...recovered],
			).map((block) => block.id),
		).toEqual([
			"heading",
			"left-before",
			"left",
			"right-before",
			"right",
			"figure",
			"after-before",
			"after",
		]);
	});
	it("keeps OCR source without translated items and suppresses text contained in a table crop", () => {
		const table = {
			...region("table", "table", 0.05, 0.2),
			bbox: { x: 0.05, y: 0.2, w: 0.4, h: 0.3 },
		};
		const cell = region("cell", "text", 0.06, 0.21, "A cell");
		const source = region("source", "header", 0.05, 0.6, "OCR heading");
		const blocks = buildReadingBlocks([table, cell, source], [item(cell)]);
		expect(blocks.map((b) => b.id)).toEqual(["table", "source"]);
		expect(blocks[1]?.source).toBe("OCR heading");
	});
	it("omits low-confidence detections and overlapping figure proposals without losing small headings", () => {
		const heading = {
			...region("heading", "header", 0.05, 0.1, "Introduction"),
			bbox: { x: 0.05, y: 0.1, w: 0.08, h: 0.01 },
		};
		const figure = region("figure", "image", 0.05, 0.3);
		const duplicate = {
			...figure,
			id: "duplicate",
			kind: "chart" as const,
			score: 0.8,
		};
		const noise = {
			...region("noise", "text", 0.05, 0.6, "Spurious paragraph"),
			score: 0.1,
		};
		const blocks = buildReadingBlocks([heading, figure, duplicate, noise], []);
		expect(blocks.map((block) => block.id)).toEqual([heading.id, figure.id]);
	});
	it("does not reinsert text detections whose glyphs belong to a prepared paragraph", () => {
		const body = region("body", "text", 0.05, 0.1, "Original body");
		const overlap = { ...body, id: "overlap", kind: "header" as const };
		const scanned = {
			...region("scanned", "text", 0.05, 0.1, "OCR-only page"),
			pageIndex: 1,
		};
		const reflow = {
			...paragraph(body, "Extracted body", body.rect),
			formulas: [],
		};
		const blocks = buildReadingBlocks(
			[body, overlap, scanned],
			[{ ...item(body), source: reflow.protectedText, reflow }],
		);
		expect(blocks.map((block) => block.text)).toEqual([
			"Extracted body",
			"OCR-only page",
		]);
	});
	it("uses matching live translations while refusing translations for changed source", () => {
		const source = region("body", "text", 0.05, 0.1, "Current paragraph");
		const blocks = buildReadingBlocks(
			[source],
			[item(source)],
			[{ ...item(source, "旧译文"), source: "Old paragraph" }],
		);
		expect(blocks[0]?.translated).toBeUndefined();
		expect(
			buildReadingBlocks(
				[source],
				[item(source)],
				[item(source, "当前译文")],
			)[0]?.translated,
		).toBe("当前译文");
	});
	it("keeps the prepared paragraph geometry for source navigation and formula crops", () => {
		const detected = region("body", "text", 0.05, 0.1, "Detected text");
		const prepared = {
			...item(detected),
			bbox: { x: 0.1, y: 0.12, w: 0.3, h: 0.08 },
			source: "Actual text",
		};
		const block = buildReadingBlocks([detected], [prepared])[0];
		expect(block?.bbox).toEqual(prepared.bbox);
		expect(block?.source).toBe("Actual text");
	});
	it("retains a matching cached translation when later candidates are pending or stale", () => {
		const source = region("body", "text", 0.05, 0.1, "Current paragraph");
		const cached = item(source, "当前译文");
		const stale = { ...item(source, "旧译文"), source: "Old paragraph" };
		expect(
			buildReadingBlocks(
				[source],
				[item(source)],
				[cached, item(source), stale],
			)[0]?.translated,
		).toBe("当前译文");
	});
	it("renders a formula already protected in prose only inline", () => {
		const body = region("body", "text", 0.05, 0.1, "Energy E=mc² is conserved");
		const formula = {
			...region("inline", "formula", 0.16, 0.11),
			bbox: { x: 0.16, y: 0.11, w: 0.08, h: 0.02 },
			rect: { x: 96, y: 88, w: 48, h: 16 },
		};
		const reflow = paragraph(body, "Energy ⟪F0⟫ is conserved", {
			x: 100,
			y: 90,
			w: 40,
			h: 12,
		});
		const blocks = buildReadingBlocks(
			[body, formula],
			[{ ...item(body), source: reflow.protectedText, reflow }],
		);
		expect(blocks.map((block) => block.id)).toEqual([body.id]);
		expect(blocks[0]?.text).toBe("Energy E=mc² is conserved");
	});
	it("keeps a standalone formula crop when nearby prose contains a different formula", () => {
		const body = region("body", "text", 0.05, 0.1, "Energy E=mc²");
		const formula = region("standalone", "formula", 0.05, 0.4);
		const reflow = paragraph(body, "Energy ⟪F0⟫", {
			x: 100,
			y: 85,
			w: 40,
			h: 14,
		});
		const blocks = buildReadingBlocks(
			[body, formula],
			[{ ...item(body), source: reflow.protectedText, reflow }],
		);
		expect(blocks.map((block) => block.id)).toEqual([body.id, formula.id]);
		expect(blocks[1]?.image).toEqual(formula);
	});
	it("does not suppress a formula on another page with matching coordinates", () => {
		const body = region("body", "text", 0.05, 0.1, "Energy E=mc²");
		const formula = {
			...region("other-page", "formula", 0.05, 0.1),
			pageIndex: 1,
		};
		const reflow = paragraph(body, "Energy ⟪F0⟫", formula.rect);
		const blocks = buildReadingBlocks(
			[body, formula],
			[{ ...item(body), source: reflow.protectedText, reflow }],
		);
		expect(blocks.map((block) => block.id)).toEqual([body.id, formula.id]);
	});
	it("includes an external equation number in the standalone crop without duplicating its body", () => {
		const formula = {
			...region("equation", "formula", 0.1, 0.4),
			bbox: { x: 0.1, y: 0.4, w: 0.3, h: 0.03 },
			rect: { x: 60, y: 320, w: 180, h: 24 },
		};
		const number = {
			...region("number", "formula_number", 0.46, 0.4, "(1)"),
			bbox: { x: 0.46, y: 0.4, w: 0.04, h: 0.03 },
			rect: { x: 276, y: 320, w: 24, h: 24 },
		};
		const blocks = buildReadingBlocks([formula, number], []);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			kind: "formula",
			bbox: { x: 0.1, y: 0.4, w: 0.4 },
			image: { titleBbox: number.bbox },
		});
		expect(blocks[0]?.bbox.h).toBeCloseTo(0.03);
	});
	it("retains an unnumbered standalone formula even when extraction wraps it in a paragraph", () => {
		const formula = region("equation", "formula", 0.05, 0.4);
		const body = { ...formula, id: "equation-text", kind: "text" as const };
		const reflow = paragraph(body, "⟪F0⟫", formula.rect);
		const blocks = buildReadingBlocks(
			[formula, body],
			[{ ...item(body), source: reflow.protectedText, reflow }],
		);
		expect(blocks.map((block) => block.id)).toEqual([formula.id]);
		expect(blocks[0]?.image).toEqual(formula);
	});
	it("keeps the crop when a prepared paragraph does not emit its formula token", () => {
		const body = region("body", "text", 0.05, 0.1, "Energy E=mc²");
		const formula = {
			...region("formula", "formula", 0.16, 0.11),
			bbox: { x: 0.16, y: 0.11, w: 0.08, h: 0.02 },
			rect: { x: 96, y: 88, w: 48, h: 16 },
		};
		const reflow = paragraph(body, "Energy E=mc²", formula.rect);
		const blocks = buildReadingBlocks(
			[body, formula],
			[{ ...item(body), reflow }],
		);
		expect(blocks.find((block) => block.id === formula.id)?.image).toEqual(
			formula,
		);
	});
	it("preserves an equation number even when no formula body can be matched", () => {
		const number = region("number", "formula_number", 0.46, 0.4, "(1)");
		const blocks = buildReadingBlocks([number], []);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.image).toEqual(number);
	});
	it("rejects cached translations which lose protected formulas", () => {
		const detected = region(
			"formula-paragraph",
			"text",
			0.05,
			0.1,
			"Energy E=mc²",
		);
		const style = {
			font: "serif",
			size: 12,
			bold: false,
			italic: false,
			color: { r: 0, g: 0, b: 0 },
		};
		const reflow: Paragraph = {
			id: detected.id,
			pageIndex: 0,
			box: detected.rect,
			characters: [],
			styles: {},
			formulas: [
				{
					id: "0",
					text: "E=mc²",
					box: { x: 100, y: 85, w: 40, h: 14 },
					characterIndexes: [],
					baselineOffset: 0,
				},
			],
			source: "Energy E=mc²",
			protectedText: "Energy ⟪F0⟫",
			style,
			firstLineIndent: 0,
			heading: false,
		};
		const prepared = {
			...item(detected),
			source: reflow.protectedText,
			reflow,
		};
		expect(
			buildReadingBlocks(
				[detected],
				[prepared],
				[{ ...prepared, status: "done", translated: "能量" }],
			)[0]?.translated,
		).toBeUndefined();
		const block = buildReadingBlocks(
			[detected],
			[prepared],
			[{ ...prepared, status: "done", translated: "能量 ⟪F0⟫" }],
		)[0];
		expect(block?.translated).toBe("能量 E=mc²");
		expect(block?.item?.translated).toBe("能量 ⟪F0⟫");
	});
});
