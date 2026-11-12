import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { init } from "@embedpdf/pdfium";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { expect, it } from "vitest";
import {
	listTranslatableLayoutRegions,
	toLayoutTranslateItems,
} from "@/lib/pdf/layout/layout-translate";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";
import { prepareReflowItems } from "@/lib/pdf/reflow/service";

const WIDTH = 300;
const HEIGHT = 400;

function region(
	id: string,
	pageIndex: number,
	kind: PdfLayoutRegion["kind"],
	label: string,
	text: string,
	top: number,
	height: number,
): PdfLayoutRegion {
	const x = 0.1;
	const width = 0.8;
	return {
		id,
		pageIndex,
		kind,
		label,
		text,
		score: 1,
		readingOrder: top * HEIGHT,
		rect: {
			x: x * WIDTH,
			y: top * HEIGHT,
			w: width * WIDTH,
			h: height * HEIGHT,
		},
		bbox: { x, y: top, w: width, h: height },
	};
}

const regions = [
	region(
		"header-1",
		0,
		"header",
		"header",
		"Journal of Testing 2026",
		0.02,
		0.025,
	),
	region(
		"title",
		0,
		"header",
		"doc_title",
		"Attention Is All You Need",
		0.08,
		0.05,
	),
	region(
		"authors",
		0,
		"text",
		"text",
		"Ada Lovelace and Alan Turing",
		0.15,
		0.03,
	),
	region(
		"affiliation",
		0,
		"text",
		"text",
		"Institute for Advanced Study",
		0.19,
		0.03,
	),
	region(
		"abstract",
		0,
		"abstract",
		"abstract",
		"Abstract body stays translatable.",
		0.25,
		0.12,
	),
	region("body", 0, "text", "text", "Main body prose.", 0.45, 0.1),
	region(
		"footnote",
		0,
		"text",
		"footnote",
		"Corresponding author.",
		0.88,
		0.05,
	),
	region(
		"header-2",
		1,
		"header",
		"header",
		"Journal of Testing 2026",
		0.02,
		0.025,
	),
	region("body-2", 1, "text", "text", "More body prose.", 0.45, 0.1),
];

async function fixture() {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.TimesRoman);
	for (let index = 0; index < 2; index++) {
		const page = pdf.addPage([WIDTH, HEIGHT]);
		for (const layout of regions.filter(
			(candidate) => candidate.pageIndex === index,
		)) {
			page.drawText(layout.text ?? "", {
				x: layout.rect.x + 2,
				y: HEIGHT - layout.rect.y - 12,
				size: 8,
				font,
			});
		}
	}
	return pdf.save();
}

async function expectMetadataExcluded(
	layoutRegions: readonly PdfLayoutRegion[],
) {
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
			id: "translation-metadata",
			content: (await fixture()).slice().buffer,
		})
		.toPromise();
	try {
		const selected = listTranslatableLayoutRegions(layoutRegions);
		expect(selected.map((item) => item.id)).toEqual([
			"abstract",
			"body",
			"body-2",
		]);

		const items = await prepareReflowItems(
			engine,
			doc,
			toLayoutTranslateItems(selected),
			layoutRegions,
		);
		expect(items.map((item) => item.id).sort()).toEqual([
			"abstract",
			"body",
			"body-2",
		]);
		for (const blocked of [
			"Attention Is All You Need",
			"Ada Lovelace",
			"Institute for Advanced Study",
			"Corresponding author",
			"Journal of Testing 2026",
		])
			expect(items.some((item) => item.raw?.includes(blocked))).toBe(false);
	} finally {
		await engine.closeDocument(doc).toPromise();
	}
}

it("keeps first-page metadata and page furniture out of reflow fallback", async () => {
	await expectMetadataExcluded(regions);
});

it("covers legacy MinerU titles and low-confidence page furniture", async () => {
	const legacyMineruRegions = regions.map((item) => {
		if (item.id === "title")
			return { ...item, label: "paragraph_title", score: 1 };
		if (
			["authors", "affiliation", "footnote", "header-1", "header-2"].includes(
				item.id,
			)
		)
			return { ...item, score: 0.05 };
		return item;
	});
	await expectMetadataExcluded(legacyMineruRegions);
});
