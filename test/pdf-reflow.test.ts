import type {
	PdfDocumentObject,
	PdfEngine,
	PdfTextRun,
} from "@embedpdf/models";
import {
	PDFArray,
	PDFDict,
	PDFDocument,
	type PDFFont,
	PDFName,
	PDFNumber,
	PDFRawStream,
	PDFString,
} from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";
import {
	interleaveReflowPdf,
	replaceReflowPages,
} from "@/lib/pdf/reflow/export";
import {
	extractReflowDocument,
	paragraphFromCharacters,
} from "@/lib/pdf/reflow/extract";
import { layoutParagraph, type ReflowFonts } from "@/lib/pdf/reflow/layout";
import { relocateReflowLinks } from "@/lib/pdf/reflow/links";
import {
	type Character,
	type CharacterStyle,
	type ReflowPage,
	validReflowTranslation,
} from "@/lib/pdf/reflow/types";
import fractionFixture from "./fixtures/pdf-inline-fraction-characters.json";

const style: CharacterStyle = {
	font: "Times",
	size: 10,
	bold: false,
	italic: false,
	color: { r: 0, g: 0, b: 0 },
};
function chars(
	text: string,
	change?: (c: Character) => Character,
): Character[] {
	return Array.from(text, (text, index) => {
		const c = {
			index,
			text,
			box: { x: 10 + index * 5, y: 10, w: 5, h: 10 },
			visualBox: { x: 10 + index * 5, y: 12, w: 5, h: 7 },
			style,
		};
		return change?.(c) ?? c;
	});
}
const metric = {
	widthOfTextAtSize: (text: string, size: number) =>
		Array.from(text).reduce(
			(n, c) => n + (/[\u4e00-\u9fff，。]/u.test(c) ? size : size * 0.5),
			0,
		),
	heightAtSize: (size: number) => size,
	encodeText: () => ({}),
} as unknown as PDFFont;
const fonts: ReflowFonts = {
	regular: metric,
	bold: metric,
	italic: metric,
	boldItalic: metric,
	cjk: metric,
	cjkBold: metric,
};
describe("character-level PDF reflow", () => {
	it("recovers a small footnote marker just outside the detected paragraph's left edge", async () => {
		const characters = [
			{
				...chars("b")[0],
				box: { x: 65, y: 148, w: 3, h: 7 },
				visualBox: { x: 65, y: 149, w: 3, h: 5 },
				style: { ...style, size: 6.4 },
			},
			...chars("Deceased note", (c) => ({
				...c,
				index: c.index + 1,
				box: { x: 69 + c.index * 5, y: 149, w: 5, h: 11 },
				visualBox: { x: 69 + c.index * 5, y: 152, w: 5, h: 7 },
			})),
		];
		const engine = {
			getPageGlyphs: () => ({
				toPromise: async () =>
					characters.map((c) => ({
						origin: { x: c.box.x, y: c.box.y },
						size: { width: c.box.w, height: c.box.h },
						tightOrigin: { x: c.visualBox.x, y: c.visualBox.y },
						tightSize: { width: c.visualBox.w, height: c.visualBox.h },
					})),
			}),
			getTextSlices: () => ({
				toPromise: async () => characters.map((c) => c.text),
			}),
			getPageTextRuns: () => ({
				toPromise: async () => ({
					runs: characters.map((c) => ({
						charIndex: c.index,
						charCount: 1,
						fontSize: c.style.size,
						font: { name: "Times", weight: 400 },
						color: { red: 0, green: 0, blue: 0 },
					})),
				}),
			}),
			renderPageRaw: () => ({
				toPromise: async () => ({
					width: 1,
					height: 1,
					data: new Uint8ClampedArray(4),
				}),
			}),
		} as unknown as PdfEngine;
		const result = await extractReflowDocument(
			engine,
			{
				pages: [{ index: 0, size: { width: 200, height: 200 } }],
			} as PdfDocumentObject,
			[
				{
					id: "note",
					pageIndex: 0,
					kind: "text",
					readingOrder: 0,
					bbox: { x: 66.8 / 200, y: 148 / 200, w: 80 / 200, h: 15 / 200 },
					source: "Deceased note",
					status: "pending",
				},
			],
			[],
		);
		expect(result.pages[0].paragraphs[0].source).toBe("bDeceased note");
		expect(
			result.pages[0].coverage?.find((c) => c.index === 0)?.disposition,
		).toBe("translated");
	});
	it("keeps a detached mathematical accent with its overlapping variable on the next baseline", () => {
		const lines = ["ordinary text above", "Use A and B below"].flatMap(
			(s, row) =>
				chars(s, (c) => ({
					...c,
					index: c.index + row * 100,
					box: { ...c.box, y: 10 + row * 12 },
					visualBox: { ...c.visualBox, y: 12 + row * 12 },
					style: {
						...c.style,
						font: row === 1 && /[AB]/.test(c.text) ? "CMMI10" : "Times",
					},
				})),
		);
		const accents = [4, 10].map((pos, i) => ({
			...chars("ˆ")[0],
			index: 300 + i,
			box: { x: 10 + pos * 5, y: 19, w: 5, h: 10 },
			visualBox: { x: 11 + pos * 5, y: 21, w: 3, h: 1 },
		}));
		const p = paragraphFromCharacters(
			"accent",
			0,
			{ x: 10, y: 10, w: 150, h: 30 },
			[...lines, ...accents],
			[],
			false,
		);
		expect(p.source.startsWith("ordinary text above Use")).toBe(true);
		for (const accent of accents) {
			const f = p.formulas.find((f) =>
				f.characterIndexes.includes(accent.index),
			);
			expect(f?.text).toMatch(/[AB]/);
			expect(f?.box.w).toBeLessThan(12);
		}
	});
	it("preserves a raised dot encoded as an underscore without converting ordinary underscores", () => {
		const characters = chars("Use f and x_y.");
		const dot = {
			...chars("_")[0],
			index: 100,
			box: { x: 32, y: 8, w: 2, h: 10 },
			visualBox: { x: 32, y: 9, w: 1, h: 2 },
		};
		const p = paragraphFromCharacters(
			"raised-dot",
			0,
			{ x: 10, y: 8, w: 100, h: 15 },
			[...characters, dot],
			[],
			false,
		);
		expect(p.formulas).toHaveLength(1);
		expect(p.formulas[0].characterIndexes).toEqual([4, 100]);
		expect(p.protectedText).toContain("x_y.");
	});
	it.each([
		["CMR10", 744, false, false],
		["ABCDEF+CMR7", 600, false, false],
		["CMMI10", 660, false, true],
		["CMTI10", 400, false, true],
		["CMBX12", 716, true, false],
		["SHTZZA+NimbusRomNo9L-Regu", 680, false, false],
		["LEGTWG+NimbusRomNo9L-ReguItal", 680, false, true],
		["UYPBEB+NimbusRomNo9L-Medi", 500, true, false],
		["NimbusRomNo9L-MediItal", 500, true, true],
		["Times-Roman", 700, false, false],
		["CustomFace", 700, true, false],
	] as const)("respects the %s face when inferred stem weight is %i", async (name, weight, bold, italic) => {
		const characters = chars("Ordinary body text");
		const engine = {
			getPageGlyphs: () => ({
				toPromise: async () =>
					characters.map((c) => ({
						origin: { x: c.box.x, y: c.box.y },
						size: { width: c.box.w, height: c.box.h },
					})),
			}),
			getPageTextRuns: () => ({
				toPromise: async () => ({
					runs: [
						{
							charIndex: 0,
							charCount: characters.length,
							fontSize: 10,
							font: { name, weight, italic: false },
							color: { red: 0, green: 0, blue: 0 },
						},
					],
				}),
			}),
			getTextSlices: () => ({
				toPromise: async () => characters.map((c) => c.text),
			}),
			renderPageRaw: () => ({
				toPromise: async () => ({
					width: 1,
					height: 1,
					data: new Uint8ClampedArray(4),
				}),
			}),
		} as unknown as PdfEngine;
		const extracted = await extractReflowDocument(
			engine,
			{
				pages: [{ index: 0, size: { width: 200, height: 200 } }],
			} as PdfDocumentObject,
			[
				{
					id: "body",
					pageIndex: 0,
					kind: "text",
					readingOrder: 0,
					bbox: { x: 0, y: 0, w: 1, h: 1 },
					source: "Ordinary body text",
					status: "pending",
				},
			],
			[],
		);
		expect(extracted.pages[0].paragraphs[0].style).toMatchObject({
			bold,
			italic,
		});
	});
	it("reads a two-column caption column by column inside one detector box", () => {
		const columns = [
			["First column", "continues here", "and ends."],
			["Second column", "continues too", "then ends."],
		];
		const cs = columns.flatMap((rows, col) =>
			rows.flatMap((s, row) =>
				chars(s, (c) => ({
					...c,
					index: c.index + col * 1000 + row * 100,
					box: { ...c.box, x: c.box.x + col * 90, y: c.box.y + row * 13 },
					visualBox: {
						...c.visualBox,
						x: c.visualBox.x + col * 90,
						y: c.visualBox.y + row * 13,
					},
				})),
			),
		);
		expect(
			paragraphFromCharacters(
				"caption",
				0,
				{ x: 10, y: 10, w: 160, h: 40 },
				cs,
				[],
				false,
			).source,
		).toBe(
			"First column continues here and ends. Second column continues too then ends.",
		);
	});
	it("keeps numerous author affiliation superscripts after their names", () => {
		const p = paragraphFromCharacters(
			"authors",
			0,
			{ x: 0, y: 0, w: 250, h: 30 },
			chars("李俊鹏1)2) 任泽阳1)2)† 张金风1)2)‡", (c) => {
				const script = /[12)†‡]/.test(c.text);
				return {
					...c,
					style: { ...style, size: script ? 9 : 14 },
					visualBox: { ...c.visualBox, y: 12, h: script ? 6 : 12 },
				};
			}),
			[],
			false,
		);
		expect(p.source).toBe("李俊鹏1)2) 任泽阳1)2)† 张金风1)2)‡");
	});
	it.each([
		"\u007f",
		"\u0001",
		"\u0002",
		"\uE001",
	])("preserves unmapped printable glyph %j as a raster island", (symbol) => {
		const p = paragraphFromCharacters(
			"symbol",
			0,
			{ x: 0, y: 0, w: 150, h: 30 },
			chars(`Resistance 42 ${symbol} mm`),
			[],
			false,
		);
		expect(p.formulas.some((f) => f.text.includes(symbol))).toBe(true);
	});
	it("joins CJK lines and justified glyphs without inserting word spaces", () => {
		const c = ["金刚石生长", "过程中形成"].flatMap((s, row) =>
			chars(s, (c) => ({
				...c,
				index: c.index + row * 20,
				box: { x: 10 + c.index * 13, y: 10 + row * 15, w: 10, h: 10 },
				visualBox: { x: 10 + c.index * 13, y: 12 + row * 15, w: 10, h: 7 },
			})),
		);
		expect(
			paragraphFromCharacters(
				"cjk",
				0,
				{ x: 0, y: 0, w: 90, h: 50 },
				c,
				[],
				false,
			).source,
		).toBe("金刚石生长过程中形成");
	});
	it("does not include tall synthetic space metrics in a formula crop", () => {
		const p = paragraphFromCharacters(
			"p",
			0,
			{ x: 0, y: 0, w: 150, h: 40 },
			chars("Use x = 0 now", (c) => ({
				...c,
				style: { ...style, italic: c.text === "x" },
				visualBox:
					c.text === " " && c.index === 7
						? { ...c.visualBox, h: 22 }
						: c.visualBox,
			})),
			[{ x: 30, y: 0, w: 25, h: 40 }],
			false,
		);
		expect(p.formulas).toHaveLength(1);
		expect(p.formulas[0].box.h).toBe(7);
	});
	it("keeps raised apostrophes with their physical line when joining hyphenated prose", () => {
		const lines = ["The nonlin\u00ad", "ear model's response."];
		const characters = lines.flatMap((line, row) =>
			chars(line, (c) => ({
				...c,
				index: c.index + row * 100,
				box: { ...c.box, y: 100 + row * 13, h: 14 },
				visualBox: {
					...c.visualBox,
					y: 104 + row * 13,
					h: c.text === "'" ? 2 : 7,
				},
			})),
		);
		const p = paragraphFromCharacters(
			"p",
			0,
			{ x: 10, y: 100, w: 160, h: 30 },
			characters,
			[],
			false,
		);
		expect(p.source).toBe("The nonlinear model's response.");
	});
	it("does not merge tiny embedded figure text into a page heading", () => {
		const heading = chars("Attention Visualizations");
		const embedded = chars("Input", (c) => ({
			...c,
			index: c.index + 100,
			style: { ...style, size: 1 },
		}));
		const p = paragraphFromCharacters(
			"heading",
			0,
			{ x: 10, y: 10, w: 200, h: 20 },
			[...heading, ...embedded],
			[],
			true,
		);
		expect(p.source).toBe("Attention Visualizations");
		expect(p.formulas).toEqual([]);
	});

	it("keeps bold mathematical operands inside function brackets", () => {
		const p = paragraphFromCharacters(
			"p",
			0,
			{ x: 10, y: 10, w: 200, h: 40 },
			chars("Use H(x) here", (c) => ({
				...c,
				style: {
					...style,
					font:
						c.index === 4
							? "CMSY10"
							: c.index === 6
								? "CMBX10"
								: c.index === 5 || c.index === 7
									? "CMR10"
									: "Times",
				},
			})),
			[],
			false,
		);
		expect(p.formulas.map((f) => f.text)).toEqual(["H(x)"]);
	});
	it("protects a spaced equation as one island", () => {
		const p = paragraphFromCharacters(
			"p",
			0,
			{ x: 10, y: 10, w: 200, h: 40 },
			chars("Use N = 6 layers", (c) => ({
				...c,
				style: {
					...style,
					font:
						c.index === 4
							? "CMMI10"
							: c.index >= 5 && c.index <= 8
								? "CMR10"
								: "Times",
				},
			})),
			[],
			false,
		);
		expect(p.formulas.map((f) => f.text)).toEqual(["N = 6"]);
	});
	it("keeps mixed STIX glyph metrics on their visual line", () => {
		const lines = [
			"heat flow J through the interface:",
			"R = ΔT∕J. The interfacial resistance",
			"depends on the interface.",
		];
		const characters = lines.flatMap((text, line) =>
			chars(text, (c) => {
				const y = 104 + line * 13;
				const operand =
					(line === 0 && c.text === "J") ||
					(line === 1 && c.index < 8 && /[RTJ]/.test(c.text));
				const symbol = /[=Δ∕]/.test(c.text);
				const visualBox = {
					...c.visualBox,
					y: y + (c.text === "=" ? 6 : operand && line === 0 ? 4 : 3),
					h:
						c.text === "="
							? 3
							: c.text === "∕"
								? 9
								: operand && line === 0
									? 6
									: 7,
				};
				return {
					...c,
					index: line * 100 + c.index,
					box: operand
						? visualBox
						: { ...c.box, y: symbol ? y + 3 : y, h: symbol ? 9 : 15 },
					visualBox,
					style: {
						...style,
						font: operand
							? "STIXGeneral-Italic"
							: symbol
								? "STIXMath-Regular"
								: "STIX-Regular",
						italic: operand,
					},
				};
			}),
		);
		const p = paragraphFromCharacters(
			"mixed-stix",
			0,
			{ x: 10, y: 104, w: 200, h: 45 },
			characters,
			[{ x: 10, y: 120, w: 40, h: 9 }],
			false,
		);
		expect(p.source).toBe(lines.join(" "));
		expect(p.formulas.map((formula) => formula.text)).toEqual(["R = ΔT∕J"]);
		expect(p.protectedText).toContain(
			"interface: ⟪F0⟫. The interfacial resistance depends on the interface.",
		);
	});
	it("keeps italic prose translatable while protecting a mathematical island", () => {
		const p = paragraphFromCharacters(
			"p",
			0,
			{ x: 10, y: 10, w: 200, h: 40 },
			chars("We use x2 here.", (c) => ({
				...c,
				style: {
					...style,
					italic: true,
					font: c.text === "x" ? "CMMI10" : "Times-Italic",
					size: c.text === "2" ? 7 : 10,
				},
			})),
			[],
			false,
		);
		expect(p.formulas.map((f) => f.text)).toEqual(["x2"]);
		expect(p.protectedText).toContain("We use ⟪F0⟫ here.");
		expect(validReflowTranslation(p, "使用 ⟪F0⟫。 ")).toBe(true);
		expect(validReflowTranslation(p, "使用 ⟪F0⟫ 和 ⟪F0⟫。")).toBe(false);
		expect(validReflowTranslation(p, "使用公式。")).toBe(false);
	});
	it("preserves mixed emphasis with balanced style tags", () => {
		const p = paragraphFromCharacters(
			"p",
			0,
			{ x: 10, y: 10, w: 200, h: 30 },
			chars("This is bold text.", (c) => ({
				...c,
				style: { ...style, bold: c.index >= 8 && c.index < 12 },
			})),
			[],
			false,
		);
		expect(Object.values(p.styles).some((s) => s.bold)).toBe(true);
		expect(validReflowTranslation(p, p.protectedText)).toBe(true);
		expect(
			validReflowTranslation(p, p.protectedText.replace("⟪/S0⟫", "")),
		).toBe(false);
	});
	it("keeps formula units atomic and never expands into a figure", () => {
		const p = paragraphFromCharacters(
			"p",
			0,
			{ x: 10, y: 10, w: 70, h: 40 },
			chars("Use x2 here", (c) => ({
				...c,
				style: {
					...style,
					font: c.text === "x" ? "CMMI10" : "Times",
					size: c.text === "2" ? 7 : 10,
				},
			})),
			[],
			false,
		);
		const page: ReflowPage = {
			index: 0,
			width: 200,
			height: 200,
			paragraphs: [p],
			obstacles: [{ x: 10, y: 52, w: 150, h: 100 }],
		};
		const layout = layoutParagraph(
			p,
			"这里使用 ⟪F0⟫ 进行计算，得到相应结果。",
			page,
			fonts,
		);
		expect(layout.fits).toBe(true);
		expect(layout.units.filter((u) => u.formula)).toHaveLength(1);
		expect(layout.box.y + layout.box.h).toBeLessThanOrEqual(52);
		expect(
			layout.units.every((u) => u.y <= layout.box.y + layout.box.h + 0.01),
		).toBe(true);
	});
	it("reserves the ascent of tall formula fragments before placing a line", () => {
		const p = paragraphFromCharacters(
			"p",
			0,
			{ x: 10, y: 10, w: 120, h: 60 },
			chars("Use x", (c) => ({
				...c,
				style: { ...style, font: c.text === "x" ? "CMMI10" : "Times" },
			})),
			[],
			false,
		);
		p.formulas[0].box.h = 22;
		p.formulas[0].baselineOffset = 0;
		const layout = layoutParagraph(
			p,
			"用 ⟪F0⟫ 计算。",
			{ index: 0, width: 200, height: 200, paragraphs: [p], obstacles: [] },
			fonts,
		);
		const formula = layout.units.find((u) => u.formula);
		expect(formula).toBeDefined();
		expect((formula?.y ?? 0) - (formula?.height ?? 0)).toBeGreaterThanOrEqual(
			p.box.y,
		);
	});
	it("keeps closing punctuation with the preceding character at a full line", () => {
		const p = paragraphFromCharacters(
			"p",
			0,
			{ x: 10, y: 10, w: 30, h: 60 },
			chars("Source"),
			[],
			false,
		);
		const layout = layoutParagraph(
			p,
			"中文测试 。",
			{ index: 0, width: 200, height: 200, paragraphs: [p], obstacles: [] },
			fonts,
		);
		const period = layout.units.findIndex((u) => u.text === "。");
		expect(layout.units[period].y).toBe(layout.units[period - 1].y);
		expect(layout.units[period - 1].text).toBe("试");
	});
	it("does not insert artificial spaces before Chinese closing punctuation", () => {
		const p = paragraphFromCharacters(
			"p",
			0,
			{ x: 10, y: 10, w: 100, h: 40 },
			chars("Source text."),
			[],
			false,
		);
		const page = {
			index: 0,
			width: 200,
			height: 200,
			paragraphs: [p],
			obstacles: [],
		};
		const layout = layoutParagraph(p, "中文，继续。", page, fonts);
		const comma = layout.units.findIndex((u) => u.text === "，");
		expect(layout.units[comma].x).toBeCloseTo(
			layout.units[comma - 1].x + layout.units[comma - 1].width,
		);
	});
});

describe("reflow page selection", () => {
	it("lets specific paragraphs own glyphs before an overlapping whole-column detection", async () => {
		const characters = ["1. First reference.", "2. Second reference."].flatMap(
			(text, row) =>
				chars(text, (c) => ({
					...c,
					index: row * 100 + c.index,
					box: { ...c.box, y: 10 + row * 30 },
					visualBox: { ...c.visualBox, y: 12 + row * 30 },
				})),
		);
		const engine = {
			getPageGlyphs: () => ({
				toPromise: async () =>
					characters.map((c) => ({
						origin: { x: c.box.x, y: c.box.y },
						size: { width: c.box.w, height: c.box.h },
					})),
			}),
			getPageTextRuns: () => ({ toPromise: async () => ({ runs: [] }) }),
			getTextSlices: () => ({
				toPromise: async () => characters.map((c) => c.text),
			}),
		} as unknown as PdfEngine;
		const selected: LayoutTranslateItem[] = [
			{ id: "column", bbox: { x: 0, y: 0, w: 1, h: 0.4 } },
			{ id: "first", bbox: { x: 0.075, y: 0.045, w: 0.85, h: 0.06 } },
			{ id: "second", bbox: { x: 0.05, y: 0.195, w: 0.85, h: 0.06 } },
		].map((v) => ({
			...v,
			pageIndex: 0,
			kind: "text",
			readingOrder: 0,
			source: "Reference",
			status: "pending",
		}));
		const result = await extractReflowDocument(
			engine,
			{
				pages: [{ index: 0, size: { width: 200, height: 200 } }],
			} as PdfDocumentObject,
			selected,
			[],
		);
		expect(result.pages[0].paragraphs.map((p) => [p.id, p.source])).toEqual([
			["first", "1. First reference."],
			["second", "2. Second reference."],
		]);
	});
	it("shares equal character styles across runs and pages while retaining size and color differences", async () => {
		const characters = chars("abcdef");
		const engine = {
			getPageGlyphs: () => ({
				toPromise: async () =>
					characters.map((c) => ({
						origin: { x: c.box.x, y: c.box.y },
						size: { width: c.box.w, height: c.box.h },
						textMatrix:
							c.index === 4 ? [0.5, 0, 0, 0.5, 0, 0] : [1, 0, 0, 1, 0, 0],
					})),
			}),
			getPageTextRuns: () => ({
				toPromise: async () => ({
					runs: [0, 2, 4, 5].map((charIndex) => ({
						charIndex,
						charCount: charIndex < 4 ? 2 : 1,
						fontSize: 10,
						font: { name: "Times", weight: charIndex === 5 ? 700 : 400 },
						color: { red: charIndex === 5 ? 200 : 0, green: 0, blue: 0 },
					})),
				}),
			}),
			getTextSlices: () => ({
				toPromise: async () => characters.map((c) => c.text),
			}),
			renderPageRaw: () => ({
				toPromise: async () => ({
					width: 1,
					height: 1,
					data: new Uint8ClampedArray(4),
				}),
			}),
		} as unknown as PdfEngine;
		const result = await extractReflowDocument(
			engine,
			{
				pages: [0, 1].map((index) => ({
					index,
					size: { width: 200, height: 200 },
				})),
			} as PdfDocumentObject,
			[0, 1].map((pageIndex) => ({
				id: `body-${pageIndex}`,
				pageIndex,
				kind: "text",
				readingOrder: 0,
				bbox: { x: 0, y: 0, w: 1, h: 1 },
				source: "abcdef",
				status: "pending",
			})),
			[],
		);
		const first = result.pages[0].paragraphs[0].characters;
		expect(first.map((c) => c.style.size)).toEqual([10, 10, 10, 10, 5, 10]);
		expect(first[5].style).toMatchObject({
			bold: true,
			color: { r: 200, g: 0, b: 0 },
		});
		const styles = result.pages.flatMap((p) =>
			p.paragraphs.flatMap((q) => q.characters.map((c) => c.style)),
		);
		expect(new Set(styles).size).toBe(3);
	});
	it.each([
		false,
		true,
	])("only rasterizes pages that need an ink check (transformed: %s)", async (transformed) => {
		const characters = chars("Ordinary paragraph");
		const render = vi.fn(async () => ({
			width: 200,
			height: 200,
			data: new Uint8ClampedArray(200 * 200 * 4).fill(255),
		}));
		const engine = {
			getPageGlyphs: () => ({
				toPromise: async () =>
					characters.map((c) => ({
						origin: { x: c.box.x, y: c.box.y },
						size: { width: c.box.w, height: c.box.h },
						textMatrix: transformed ? [2, 0, 0, 2, 0, 0] : [1, 0, 0, 1, 0, 0],
						textObjectId: 1,
					})),
			}),
			getPageTextRuns: () => ({ toPromise: async () => ({ runs: [] }) }),
			getTextSlices: () => ({
				toPromise: async () => characters.map((c) => c.text),
			}),
			renderPageRaw: () => ({ toPromise: render }),
		} as unknown as PdfEngine;
		const result = await extractReflowDocument(
			engine,
			{
				pages: [{ index: 0, size: { width: 200, height: 200 } }],
			} as PdfDocumentObject,
			[],
			[],
			undefined,
			{ includeUnselectedPages: true },
		);
		expect(render).toHaveBeenCalledTimes(transformed ? 1 : 0);
		// Transformed text with no matching painted ink must still be excluded.
		expect(result.pages[0].paragraphs.map((p) => p.source)).toEqual(
			transformed ? [] : ["Ordinary paragraph"],
		);
	});
	it("assigns a detector boundary line as a whole despite varying ink centers", async () => {
		const characters = chars("Taiyuan, Shanxi").map((c) => ({
			...c,
			box: { ...c.box, y: 148, h: 9 },
			visualBox: {
				...c.visualBox,
				y: /[a-z]/.test(c.text) ? 152 : 149,
				h: /[a-z]/.test(c.text) ? 4 : 7,
			},
		}));
		const engine = {
			getPageGlyphs: () => ({
				toPromise: async () =>
					characters.map((c) => ({
						origin: { x: c.box.x, y: c.box.y },
						size: { width: c.box.w, height: c.box.h },
						tightOrigin: { x: c.visualBox.x, y: c.visualBox.y },
						tightSize: { width: c.visualBox.w, height: c.visualBox.h },
					})),
			}),
			getPageTextRuns: () => ({ toPromise: async () => ({ runs: [] }) }),
			getTextSlices: () => ({
				toPromise: async () => characters.map((c) => c.text),
			}),
			renderPageRaw: () => ({
				toPromise: async () => ({
					width: 1,
					height: 1,
					data: new Uint8ClampedArray(4),
				}),
			}),
		} as unknown as PdfEngine;
		const selected = [
			{ id: "first", y: 136.25, h: 17.5 },
			{ id: "overlap", y: 148.875, h: 9 },
		].map((r) => ({
			id: r.id,
			pageIndex: 0,
			kind: "text",
			readingOrder: r.y,
			bbox: { x: 0, y: r.y / 200, w: 1, h: r.h / 200 },
			source: "",
			status: "pending",
		})) as LayoutTranslateItem[];
		const result = await extractReflowDocument(
			engine,
			{
				pages: [{ index: 0, size: { width: 200, height: 200 } }],
			} as PdfDocumentObject,
			selected,
			[],
		);
		expect(result.pages[0].paragraphs.map((p) => p.source)).toEqual([
			"Taiyuan, Shanxi",
		]);
		expect(
			result.pages[0].paragraphs[0].box.y + result.pages[0].paragraphs[0].box.h,
		).toBeGreaterThanOrEqual(157);
	});
	it.each([
		true,
		false,
	])("retains complete paragraphs with missing run metadata (object identity: %s)", async (hasObjectId) => {
		const text = "under high source-drain bias voltages";
		const doc = {
			pages: [{ index: 0, size: { width: 200, height: 200 } }],
		} as PdfDocumentObject;
		const characters = chars(text);
		const run = {
			charIndex: 0,
			charCount: 1,
			fontSize: 1,
			font: { name: "STIX-Regular", weight: 400 },
			color: { red: 0, green: 0, blue: 0 },
		} as PdfTextRun;
		const engine = {
			getPageGlyphs: () => ({
				toPromise: async () =>
					characters.map((c) => ({
						origin: { x: c.box.x, y: c.box.y },
						size: { width: c.box.w, height: c.box.h },
						textMatrix: [10, 0, 0, 10, 10, 10],
						textObjectId: hasObjectId ? 42 : undefined,
					})),
			}),
			getPageTextRuns: () => ({ toPromise: async () => ({ runs: [run] }) }),
			getTextSlices: () => ({
				toPromise: async () => characters.map((c) => c.text),
			}),
			renderPageRaw: () => ({
				toPromise: async () => ({
					width: 1,
					height: 1,
					data: new Uint8ClampedArray(4),
				}),
			}),
		} as unknown as PdfEngine;
		const item: LayoutTranslateItem = {
			id: "body",
			pageIndex: 0,
			kind: "text",
			readingOrder: 0,
			bbox: { x: 0, y: 0, w: 1, h: 1 },
			source: text,
			status: "pending",
		};
		const extracted = await extractReflowDocument(engine, doc, [item], []);
		const [paragraph] = extracted.pages[0].paragraphs;
		expect(paragraph.source).toBe(text);
		expect(paragraph.style.size).toBe(10);
		if (hasObjectId) expect(paragraph.style.font).toBe("STIX-Regular");
		expect(paragraph.characters).toHaveLength(characters.length);
		expect(extracted.pages[0].paragraphs).toHaveLength(1);
		const caption = {
			...item,
			id: "caption",
			kind: "figure_title",
			source: "Fig. 1. A caption.",
		} as LayoutTranslateItem;
		const overlap = await extractReflowDocument(
			engine,
			doc,
			[item, caption],
			[],
		);
		expect(overlap.pages[0].paragraphs.map((p) => p.id)).toEqual(["caption"]);
	});

	it("recovers an unselected text page only when whole-document extraction is requested", async () => {
		const doc = {
			pages: [{ index: 0, size: { width: 200, height: 200 } }],
		} as PdfDocumentObject;
		const characters = chars("Uncovered source paragraph");
		const engine = {
			getPageGlyphs: () => ({
				toPromise: async () =>
					characters.map((c) => ({
						origin: { x: c.box.x, y: c.box.y },
						size: { width: c.box.w, height: c.box.h },
					})),
			}),
			getPageTextRuns: () => ({ toPromise: async () => ({ runs: [] }) }),
			getTextSlices: () => ({
				toPromise: async () => characters.map((c) => c.text),
			}),
			renderPageRaw: () => ({
				toPromise: async () => ({
					width: 1,
					height: 1,
					data: new Uint8ClampedArray(4),
				}),
			}),
		} as unknown as PdfEngine;
		expect((await extractReflowDocument(engine, doc, [], [])).pages).toEqual(
			[],
		);
		const extracted = await extractReflowDocument(
			engine,
			doc,
			[],
			[],
			undefined,
			{ includeUnselectedPages: true },
		);
		expect(extracted.pages.map((page) => page.index)).toEqual([0]);
		expect(
			extracted.pages[0].paragraphs.map((paragraph) => paragraph.source),
		).toEqual(["Uncovered source paragraph"]);
		expect(
			extracted.pages[0].coverage?.every(
				(character) => character.disposition === "translated",
			),
		).toBe(true);
	});
});

describe("reflow PDF navigation", () => {
	it("interleaves pages without changing translated page references", async () => {
		const source = await PDFDocument.create();
		const sourceFirst = source.addPage([100, 120]);
		const sourceSecond = source.addPage([200, 220]);
		sourceFirst.node.addAnnot(
			source.context.register(
				source.context.obj({
					Type: "Annot",
					Subtype: "Link",
					Rect: [0, 0, 10, 10],
					Dest: [sourceSecond.ref, "Fit"],
				}),
			),
		);
		const translated = await PDFDocument.create();
		const first = translated.addPage([101, 121]);
		const second = translated.addPage([201, 221]);
		first.node.addAnnot(
			translated.context.register(
				translated.context.obj({
					Type: "Annot",
					Subtype: "Link",
					Rect: [0, 0, 10, 10],
					Dest: [second.ref, "Fit"],
				}),
			),
		);
		const result = await PDFDocument.load(
			await interleaveReflowPdf(await source.save(), await translated.save()),
		);
		expect(result.getPages().map((p) => p.getWidth())).toEqual([
			100, 101, 200, 201,
		]);
		const originalAnnotation = result
			.getPage(0)
			.node.Annots()
			?.lookup(0, PDFDict);
		expect(
			originalAnnotation
				?.lookup(PDFName.of("Dest"), PDFArray)
				.get(0)
				.toString(),
		).toBe(result.getPage(2).ref.toString());
		const annotation = result.getPage(1).node.Annots()?.lookup(0, PDFDict);
		expect(
			annotation?.lookup(PDFName.of("Dest"), PDFArray).get(0).toString(),
		).toBe(result.getPage(3).ref.toString());
	});
	it("replaces only changed pages and keeps navigation to and from untouched pages", async () => {
		const old = await PDFDocument.create();
		const originals = [
			old.addPage([100, 120]),
			old.addPage([200, 220]),
			old.addPage([300, 320]),
		];
		const addLink = (pdf: PDFDocument, pageIndex: number, target: number) => {
			pdf.getPage(pageIndex).node.addAnnot(
				pdf.context.register(
					pdf.context.obj({
						Type: "Annot",
						Subtype: "Link",
						Rect: [0, 0, 10, 10],
						Dest: [pdf.getPage(target).ref, "Fit"],
					}),
				),
			);
		};
		addLink(old, 0, 1);
		const replacement = await PDFDocument.create();
		replacement.addPage([900, 900]);
		replacement.addPage([201, 221]);
		replacement.addPage([901, 901]);
		addLink(replacement, 1, 2);
		const output = await PDFDocument.load(
			await replaceReflowPages(await old.save(), await replacement.save(), [1]),
		);
		expect(output.getPages().map((p) => p.getWidth())).toEqual([100, 201, 300]);
		expect(output.getPages().map((p) => p.ref.toString())).toEqual(
			originals.map((p) => p.ref.toString()),
		);
		for (const [pageIndex, target] of [
			[0, 1],
			[1, 2],
		]) {
			const annotation = output
				.getPage(pageIndex)
				.node.Annots()
				?.lookup(0, PDFDict);
			expect(
				annotation?.lookup(PDFName.of("Dest"), PDFArray).get(0).toString(),
			).toBe(output.getPage(target).ref.toString());
		}
	});
	it("reuses embedded font data and releases resources from repeated page replacements", async () => {
		const make = async (label: string) => {
			const pdf = await PDFDocument.create();
			const fontData = pdf.context.register(
				pdf.context.stream(new Uint8Array(4096).fill(65)),
			);
			const descriptor = pdf.context.register(
				pdf.context.obj({ Type: "FontDescriptor", FontFile2: fontData }),
			);
			const font = pdf.context.register(
				pdf.context.obj({ Type: "Font", FontDescriptor: descriptor }),
			);
			for (let i = 0; i < 2; i++) {
				const page = pdf.addPage([100, 100]);
				page.node.set(
					PDFName.of("Resources"),
					pdf.context.obj({ Font: { F0: font } }),
				);
				page.drawText(`${label}-${i}`);
			}
			return pdf.save();
		};
		let bytes = await make("old");
		const replacement = await make("new");
		let objectCount = 0;
		for (let i = 0; i < 3; i++) {
			bytes = await replaceReflowPages(bytes, replacement, [1]);
			const pdf = await PDFDocument.load(bytes);
			const objects = pdf.context.enumerateIndirectObjects();
			expect(
				objects.filter(
					([, object]) =>
						object instanceof PDFRawStream &&
						object.getContents().length === 4096,
				),
			).toHaveLength(1);
			if (i > 0) expect(objects.length).toBe(objectCount);
			objectCount = objects.length;
		}
	});
	it("moves citation links with formula units and preserves their action", async () => {
		const pdf = await PDFDocument.create();
		const target = pdf.addPage([200, 200]);
		const p = paragraphFromCharacters(
			"p",
			0,
			{ x: 10, y: 10, w: 100, h: 40 },
			chars("See [12]."),
			[],
			false,
		);
		expect(p.formulas.map((f) => f.text)).toEqual(["[12]"]);
		target.node.addAnnot(
			pdf.context.register(
				pdf.context.obj({
					Type: "Annot",
					Subtype: "Link",
					Rect: [30, 180, 50, 190],
					A: { S: "URI", URI: PDFString.of("https://example.org/paper") },
				}),
			),
		);
		const page = {
			index: 0,
			width: 200,
			height: 200,
			paragraphs: [p],
			obstacles: [],
		};
		const placed = layoutParagraph(p, "引用 ⟪F0⟫。", page, fonts);
		relocateReflowLinks(target, page, { ...page, paragraphs: [placed] });
		const moved = target.node.Annots()?.lookup(0, PDFDict);
		expect(
			moved
				?.lookup(PDFName.of("A"), PDFDict)
				.get(PDFName.of("URI"))
				?.toString(),
		).toContain("example.org/paper");
		const rect = moved?.lookup(PDFName.of("Rect"), PDFArray);
		expect(rect?.lookup(0, PDFNumber).asNumber()).toBeCloseTo(
			placed.units.find((u) => u.formula)?.x ?? -1,
		);
	});
});

it("keeps a stacked inline denominator with its numerator instead of the next prose line", () => {
	const paragraph = paragraphFromCharacters(
		"fraction",
		1,
		fractionFixture.box,
		fractionFixture.characters as Character[],
		[],
		false,
	);
	const formula = paragraph.formulas.find((f) =>
		f.characterIndexes.includes(2666),
	);
	expect(formula?.characterIndexes).toContain(2670);
	if (!formula) throw new Error("Missing fraction");
	expect(formula.box.y + formula.box.h).toBeGreaterThanOrEqual(476);
	expect(
		paragraph.formulas.some(
			(f) => f.characterIndexes.includes(2670) && f.id !== formula?.id,
		),
	).toBe(false);
});
