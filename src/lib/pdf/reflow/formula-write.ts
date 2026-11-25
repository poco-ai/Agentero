import {
	beginText,
	clip,
	concatTransformationMatrix,
	drawObject,
	endPath,
	endText,
	fill,
	PDFDict,
	type PDFDocument,
	type PDFEmbeddedPage,
	PDFHexString,
	PDFName,
	PDFNumber,
	PDFOperator,
	PDFOperatorNames,
	type PDFPage,
	type PDFRef,
	popGraphicsState,
	pushGraphicsState,
	rectangle,
	setFontAndSize,
	setTextMatrix,
	setTextRenderingMode,
	showText,
	TextRenderingMode,
	toHexStringOfMinLength,
	utf16Encode,
} from "pdf-lib";
import { visiblePageBox } from "../page-box";
import type { Formula, PageLayout, PlacedUnit } from "./types";

type FormulaUnit = PlacedUnit & { formula: Formula };
type FormulaGlyph = { font: PDFName; code: string; source: PDFEmbeddedPage };
const GLYPHS_PER_FONT = 255;

/** A bounded Type 3 glyph gives the vector clip selectable text at its destination. */
function formulaGlyphs(
	target: PDFPage,
	page: PDFEmbeddedPage,
	units: readonly FormulaUnit[],
): Map<PlacedUnit, FormulaGlyph> {
	const { context } = target.doc;
	const glyphs = new Map<PlacedUnit, FormulaGlyph>();
	for (let offset = 0; offset < units.length; offset += GLYPHS_PER_FONT) {
		const batch = units.slice(offset, offset + GLYPHS_PER_FONT);
		const procedures: Record<string, PDFRef> = {};
		const widths: number[] = [];
		const mappings: string[] = [];
		const codes = batch.map((_, index) => toHexStringOfMinLength(index + 1, 2));
		let maxWidth = 0;
		let maxHeight = 0;
		for (const [index, { formula }] of batch.entries()) {
			const { w, h } = formula.box;
			const code = codes[index];
			procedures[`g${code}`] = context.register(
				context.contentStream([
					PDFOperator.of(
						PDFOperatorNames.Type3D1,
						[w, 0, 0, 0, w, h].map(PDFNumber.of),
					),
					rectangle(0, 0, w, h),
					fill(),
				]),
			);
			widths.push(w);
			maxWidth = Math.max(maxWidth, w);
			maxHeight = Math.max(maxHeight, h);
			if (formula.text) {
				const unicode = Array.from(utf16Encode(formula.text, false), (value) =>
					toHexStringOfMinLength(value, 4),
				).join("");
				mappings.push(`<${code}> <${unicode}>`);
			}
		}
		const toUnicode = context.register(
			context.flateStream(
				[
					"/CIDInit /ProcSet findresource begin",
					"12 dict begin",
					"begincmap",
					"/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
					"/CMapName /Adobe-Identity-UCS def",
					"/CMapType 2 def",
					"1 begincodespacerange",
					"<00> <FF>",
					"endcodespacerange",
					...Array.from(
						{ length: Math.ceil(mappings.length / 100) },
						(_, index) => {
							const entries = mappings.slice(index * 100, (index + 1) * 100);
							return [`${entries.length} beginbfchar`, ...entries, "endbfchar"];
						},
					).flat(),
					"endcmap",
					"CMapName currentdict /CMap defineresource pop",
					"end",
					"end",
				].join("\n"),
			),
		);
		const fontBox = [0, 0, maxWidth, maxHeight];
		const descriptor = context.register(
			context.obj({
				Type: "FontDescriptor",
				FontName: "ReflowFormula",
				Flags: 4,
				FontBBox: fontBox,
				Ascent: maxHeight,
				Descent: 0,
				CapHeight: maxHeight,
				ItalicAngle: 0,
				StemV: 0,
			}),
		);
		const fontRef = context.register(
			context.obj({
				Type: "Font",
				Subtype: "Type3",
				Name: "ReflowFormula",
				BaseFont: "ReflowFormula",
				FontBBox: fontBox,
				FontMatrix: [1, 0, 0, 1, 0, 0],
				CharProcs: procedures,
				Encoding: {
					Type: "Encoding",
					Differences: [1, ...Object.keys(procedures)],
				},
				FirstChar: 1,
				LastChar: batch.length,
				Widths: widths,
				FontDescriptor: descriptor,
				ToUnicode: toUnicode,
			}),
		);
		const font = target.node.newFontDictionary("ReflowFormula", fontRef);
		batch.forEach((unit, index) => {
			glyphs.set(unit, { font, code: codes[index], source: page });
		});
	}
	return glyphs;
}

export async function embedFormulaPages(
	pdf: PDFDocument,
	pages: readonly PageLayout[],
	source: PDFDocument,
) {
	const entries = pages.flatMap((page) => {
		const units = page.paragraphs.flatMap((paragraph) =>
			paragraph.units.filter((unit): unit is FormulaUnit =>
				Boolean(
					unit.formula && unit.formula.box.w > 0 && unit.formula.box.h > 0,
				),
			),
		);
		return units.length ? [{ index: page.index, units }] : [];
	});
	const originals = entries.map(({ index }) => {
		const page = source.getPage(index);
		page.node.delete(source.context.obj("Annots"));
		return page;
	});
	const embedded = await pdf.embedPages(
		originals,
		originals.map((page) => {
			const { x, y, width, height } = visiblePageBox(page);
			return { left: x, bottom: y, right: x + width, top: y + height };
		}),
	);
	return new Map(
		entries.map(({ index, units }, position) => [
			index,
			formulaGlyphs(pdf.getPage(index), embedded[position], units),
		]),
	);
}

export function drawFormulaGlyph(
	target: PDFPage,
	glyph: FormulaGlyph,
	unit: PlacedUnit,
	box: Formula["box"],
	x: number,
	y: number,
) {
	const { context } = target.doc;
	const { w, h } = box;
	const scaleX = unit.width / w;
	const scaleY = unit.height / h;
	const resources = target.node.normalizedEntries().Resources;
	const patternKey = PDFName.of("Pattern");
	let patterns = resources.lookupMaybe(patternKey, PDFDict);
	if (!patterns) {
		patterns = context.obj({});
		resources.set(patternKey, patterns);
	}
	const pattern = patterns.uniqueKey("ReflowFormula");
	patterns.set(
		pattern,
		context.register(
			context.contentStream(
				[
					pushGraphicsState(),
					rectangle(0, 0, w, h),
					clip(),
					endPath(),
					concatTransformationMatrix(
						1,
						0,
						0,
						1,
						-box.x,
						box.y + h - glyph.source.height,
					),
					drawObject("Source"),
					popGraphicsState(),
				],
				{
					Type: "Pattern",
					PatternType: 1,
					PaintType: 1,
					TilingType: 1,
					BBox: [0, 0, w, h],
					XStep: w,
					YStep: h,
					Matrix: [scaleX, 0, 0, scaleY, x, y],
					Resources: { XObject: { Source: glyph.source.ref } },
				},
			),
		),
	);
	target.pushOperators(
		pushGraphicsState(),
		PDFOperator.of(PDFOperatorNames.NonStrokingColorspace, [patternKey]),
		PDFOperator.of(PDFOperatorNames.NonStrokingColorN, [pattern]),
		rectangle(x, y, unit.width, unit.height),
		fill(),
		popGraphicsState(),
		pushGraphicsState(),
		beginText(),
		setFontAndSize(glyph.font, 1),
		setTextRenderingMode(TextRenderingMode.Invisible),
		setTextMatrix(scaleX, 0, 0, scaleY, x, y),
		showText(PDFHexString.of(glyph.code)),
		endText(),
		popGraphicsState(),
	);
}
