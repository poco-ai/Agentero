import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { init } from "@embedpdf/pdfium";
import {
	PDFArray,
	PDFDict,
	PDFDocument,
	PDFName,
	PDFString,
	StandardFonts,
} from "pdf-lib";
import { expect, it } from "vitest";
import {
	listTranslatableLayoutRegions,
	toLayoutTranslateItems,
} from "@/lib/pdf/layout/layout-translate";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";
import { buildReflowPdf, interleaveReflowPdf } from "@/lib/pdf/reflow/export";
import {
	prepareReflowItems,
	reflowDocumentFromItems,
} from "@/lib/pdf/reflow/service";

const region = (
	id: string,
	pageIndex: number,
	text: string,
	y: number,
	kind: PdfLayoutRegion["kind"] = "text",
	label: string = kind,
): PdfLayoutRegion => ({
	id,
	pageIndex,
	kind,
	label,
	text,
	score: 1,
	readingOrder: y,
	rect: { x: 20, y: y - 12, w: 260, h: 20 },
	bbox: { x: 20 / 300, y: (y - 12) / 400, w: 260 / 300, h: 20 / 400 },
});

const regions = [
	region("body", 0, "Body cites [1].", 40),
	region("heading", 0, "References", 100, "header"),
	region("ref", 0, "[1] Smith. A reference. 2024.", 140, "text", "reference"),
	region("ref-table", 0, "", 140, "table"),
	region(
		"ref-only",
		1,
		"[2] Jones. Another reference. 2025.",
		40,
		"text",
		"reference_content",
	),
	region("appendix", 2, "A. Appendix", 40, "header"),
	region("appendix-body", 2, "Additional experiments.", 80),
];

async function fixture() {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.TimesRoman);
	for (let index = 0; index < 3; index++) {
		const page = pdf.addPage([300, 400]);
		for (const r of regions.filter((r) => r.pageIndex === index && r.text))
			page.drawText(r.text ?? "", {
				x: 20,
				y: 400 - r.readingOrder,
				size: 10,
				font,
			});
		if (index === 0) {
			page.drawText("Unlabelled figure text", {
				x: 20,
				y: 200,
				size: 10,
				font,
			});
			page.node.addAnnot(
				pdf.context.register(
					pdf.context.obj({
						Type: "Annot",
						Subtype: "Link",
						Rect: [20, 258, 180, 272],
						A: { S: "URI", URI: PDFString.of("https://example.org/reference") },
					}),
				),
			);
		}
	}
	return pdf.save();
}

it("keeps bibliography out of detected, table and fallback IR while retaining body citations and appendices", async () => {
	const engine = new PdfiumNative(
		await init({
			wasmBinary: readFileSync(
				fileURLToPath(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")),
			),
		}),
		{ fontFallback: null },
	);
	const doc = await engine
		.openDocumentBuffer({
			id: "reference-exclusions",
			content: (await fixture()).slice().buffer,
		})
		.toPromise();
	try {
		const items = await prepareReflowItems(
			engine,
			doc,
			toLayoutTranslateItems(listTranslatableLayoutRegions(regions)),
			regions,
		);
		expect(items.map((item) => item.id)).toEqual(
			expect.arrayContaining(["body", "appendix", "appendix-body"]),
		);
		expect(items.some((item) => item.pageIndex === 1)).toBe(false);
		expect(
			items.some(
				(item) => item.raw?.includes("reference") || item.raw === "References",
			),
		).toBe(false);
		expect(items.find((item) => item.id === "body")?.raw).toContain("[1]");
		expect(items.some((item) => item.raw === "Unlabelled figure text")).toBe(
			true,
		);

		const fontPath = process.env.AGENTERO_REFLOW_FONT;
		if (!fontPath) return;
		const ir = reflowDocumentFromItems(doc, items, regions);
		const output = await buildReflowPdf(
			engine,
			doc,
			ir,
			new Map(items.map((item) => [item.id, item.source])),
			readFileSync(fontPath),
		);
		const translated = await engine
			.openDocumentBuffer({
				id: "references-output",
				content: output.bytes.slice().buffer,
			})
			.toPromise();
		try {
			expect(translated.pages).toHaveLength(3);
			const referenceText = await engine
				.getPageTextRuns(translated, translated.pages[1])
				.toPromise();
			expect(referenceText.runs.map((run) => run.text).join("")).toContain(
				"Jones. Another reference.",
			);
			const sourceRaster = await engine
				.renderPageRaw(doc, doc.pages[1], { scaleFactor: 1 })
				.toPromise();
			const resultRaster = await engine
				.renderPageRaw(translated, translated.pages[1], { scaleFactor: 1 })
				.toPromise();
			expect(resultRaster).toEqual(sourceRaster);
			const sourceMixed = await engine
				.renderPageRaw(doc, doc.pages[0], { scaleFactor: 1 })
				.toPromise();
			const resultMixed = await engine
				.renderPageRaw(translated, translated.pages[0], { scaleFactor: 1 })
				.toPromise();
			// Reference heading, entry, and link area remain pixel-identical on a translated page.
			const start = 80 * sourceMixed.width * 4,
				end = 155 * sourceMixed.width * 4;
			expect(resultMixed.data.slice(start, end)).toEqual(
				sourceMixed.data.slice(start, end),
			);
		} finally {
			await engine.closeDocument(translated).toPromise();
		}
		const pdf = await PDFDocument.load(output.bytes);
		const annotations = pdf.getPage(0).node.Annots();
		expect(annotations?.size()).toBe(1);
		const link = annotations?.lookup(0, PDFDict);
		expect(
			link?.lookup(PDFName.of("Rect"), PDFArray).asArray().map(String),
		).toEqual(["20", "258", "180", "272"]);
		const dual = await interleaveReflowPdf(await fixture(), output.bytes);
		expect((await PDFDocument.load(dual)).getPageCount()).toBe(6);
	} finally {
		await engine.closeDocument(doc).toPromise();
		engine.destroy();
	}
});
