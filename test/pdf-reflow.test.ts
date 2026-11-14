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
import { describe, expect, it } from "vitest";
import {
	interleaveReflowPdf,
	replaceReflowPages,
} from "@/lib/pdf/reflow/export";
import { paragraphFromCharacters } from "@/lib/pdf/reflow/extract";
import { layoutParagraph, type ReflowFonts } from "@/lib/pdf/reflow/layout";
import { relocateReflowLinks } from "@/lib/pdf/reflow/links";
import {
	type Character,
	type CharacterStyle,
	type ReflowPage,
	validReflowTranslation,
} from "@/lib/pdf/reflow/types";

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
	it("recognizes TeX symbol fonts as math instead of prose", () => {
		const p = paragraphFromCharacters(
			"p",
			0,
			{ x: 10, y: 10, w: 200, h: 40 },
			chars("Use N = 6 layers", (c) => ({
				...c,
				style: {
					...style,
					font: c.index >= 4 && c.index <= 8 ? "txsys" : "Times",
				},
			})),
			[],
			false,
		);
		expect(p.formulas.map((f) => f.text)).toEqual(["N = 6"]);
		expect(p.protectedText).toContain("Use ⟪F0⟫ layers");
	});
	it("keeps a formula snippet's full descender in its baseline offset", () => {
		const input = chars("a] ∈", (c) => ({
			...c,
			style: {
				...style,
				font: c.text === "a" || c.text === " " ? "Times" : "txsys",
			},
			box:
				c.text === "]"
					? { ...c.box, y: 4, h: 18 }
					: c.text === "∈"
						? { ...c.box, y: 12, h: 7 }
						: c.box,
			visualBox:
				c.text === "]"
					? { x: c.box.x, y: 5, w: c.box.w, h: 18 }
					: c.text === "∈"
						? { x: c.box.x, y: 12, w: c.box.w, h: 7 }
						: { x: c.box.x, y: 12, w: c.box.w, h: 7 },
		}));
		const p = paragraphFromCharacters(
			"p",
			0,
			{ x: 10, y: 10, w: 200, h: 40 },
			input,
			[],
			false,
		);
		expect(p.formulas).toHaveLength(1);
		expect(p.formulas[0]?.baselineOffset).toBeGreaterThan(4);
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
