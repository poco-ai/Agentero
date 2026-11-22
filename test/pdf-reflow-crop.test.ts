/** Real PDFium regression fixtures; generated PDFs stay outside the repository. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { init } from "@embedpdf/pdfium";
import {
	PDFArray,
	PDFDict,
	PDFDocument,
	PDFName,
	PDFNumber,
	PDFString,
	StandardFonts,
} from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";
import { buildReflowPage, buildReflowPdf } from "@/lib/pdf/reflow/export";
import { paragraphFromCharacters } from "@/lib/pdf/reflow/extract";
import type { Character, ReflowDocument } from "@/lib/pdf/reflow/types";

/**
 * Formula fragments open a second PDFium engine. Vitest turns
 * `pdfium.wasm?url` into a filesystem path, and Node's fetch rejects that.
 * Serve the file so the real redact path still runs.
 */
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
	if (url.includes("pdfium.wasm") && !/^[a-z][a-z0-9+.-]*:/i.test(url)) {
		const path = existsSync(url)
			? url
			: resolve(process.cwd(), url.replace(/^\//, ""));
		return new Response(readFileSync(path));
	}
	return nativeFetch(input, init);
}) as typeof fetch;
afterAll(() => {
	globalThis.fetch = nativeFetch;
});

const fontPath = process.env.AGENTERO_REFLOW_FONT;
const outputDir = process.env.AGENTERO_REFLOW_CROP_OUTPUT;
const cases = [
	{
		name: "positive-crop",
		media: [0, 0, 240, 260],
		crop: [20, 30, 200, 200],
		x: 20,
		y: 30,
	},
	{
		name: "negative-media",
		media: [-40, -60, 200, 200],
		crop: [-80, -90, 260, 250],
		x: -40,
		y: -60,
	},
];
const characters: Character[] = Array.from("See [12].", (text, index) => ({
	index,
	text,
	box: { x: 10 + index * 5, y: 10, w: 5, h: 10 },
	visualBox: { x: 10 + index * 5, y: 10, w: 5, h: 10 },
	style: {
		font: "Times",
		size: 10,
		bold: false,
		italic: false,
		color: { r: 0, g: 0, b: 0 },
	},
}));
const paragraph = paragraphFromCharacters(
	"p",
	0,
	{ x: 10, y: 10, w: 160, h: 40 },
	characters,
	[],
	false,
);
const ir: ReflowDocument = {
	version: 1,
	pages: [
		{
			index: 0,
			width: 200,
			height: 200,
			paragraphs: [paragraph],
			obstacles: [],
		},
	],
};

async function fixture(sample: (typeof cases)[number]) {
	const pdf = await PDFDocument.create();
	const page = pdf.addPage([200, 200]);
	page.setMediaBox(
		sample.media[0],
		sample.media[1],
		sample.media[2],
		sample.media[3],
	);
	page.setCropBox(
		sample.crop[0],
		sample.crop[1],
		sample.crop[2],
		sample.crop[3],
	);
	const font = await pdf.embedFont(StandardFonts.TimesRoman);
	for (const c of characters)
		page.drawText(c.text, {
			x: sample.x + c.box.x,
			y: sample.y + 182,
			size: 10,
			font,
		});
	// Untouched vector content outside the translated paragraph.
	page.drawLine({
		start: { x: sample.x + 20, y: sample.y + 80 },
		end: { x: sample.x + 180, y: sample.y + 80 },
		thickness: 2,
	});
	page.node.addAnnot(
		pdf.context.register(
			pdf.context.obj({
				Type: "Annot",
				Subtype: "Link",
				Rect: [sample.x + 30, sample.y + 180, sample.x + 50, sample.y + 190],
				A: { S: "URI", URI: PDFString.of("https://example.org/paper") },
			}),
		),
	);
	return pdf.save();
}

describe.skipIf(!fontPath)("reflow with offset page boxes", () => {
	it.each(
		cases,
	)("preserves text, formulas and links: $name", async (sample) => {
		const engine = new PdfiumNative(
			await init({
				wasmBinary: readFileSync(
					fileURLToPath(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")),
				),
			}),
			{ fontFallback: null },
		);
		const font = readFileSync(fontPath ?? "");
		const fonts = {
			regular: font,
			bold: font,
			italic: font,
			boldItalic: font,
			cjk: font,
			cjkBold: font,
		};
		const translations = new Map([["p", "Read ⟪F0⟫."]]);
		expect(paragraph.formulas.map((f) => f.text)).toEqual(["[12]"]);
		const open = (bytes: Uint8Array) =>
			engine
				.openDocumentBuffer({
					id: crypto.randomUUID(),
					content: bytes.slice().buffer,
				})
				.toPromise();
		const baseline = await open(
			await fixture({
				name: "zero",
				media: [0, 0, 200, 200],
				crop: [0, 0, 200, 200],
				x: 0,
				y: 0,
			}),
		);
		const input = await fixture(sample);
		const source = await open(input);
		try {
			const reference = await buildReflowPdf(
				engine,
				baseline,
				ir,
				translations,
				fonts,
			);
			const result = await buildReflowPdf(
				engine,
				source,
				ir,
				translations,
				fonts,
			);
			const preview = await buildReflowPage(
				engine,
				source,
				ir,
				translations,
				fonts,
			);
			const expected = await open(reference.bytes);
			try {
				const pixels = await engine
					.renderPageRaw(expected, expected.pages[0], { scaleFactor: 1 })
					.toPromise();
				for (const bytes of [result.bytes, preview.bytes]) {
					const actual = await open(bytes);
					try {
						expect(actual.pages[0].size).toEqual({ width: 200, height: 200 });
						expect(
							await engine
								.renderPageRaw(actual, actual.pages[0], { scaleFactor: 1 })
								.toPromise(),
						).toEqual(pixels);
						const runs = await engine
							.getPageTextRuns(actual, actual.pages[0])
							.toPromise();
						const text = runs.runs
							.map((r) => r.text)
							.join("")
							.replace(/\s/g, "");
						expect(text).toContain("Read");
						expect(text).toContain("[12]");
						expect(text).not.toContain("See");
					} finally {
						await engine.closeDocument(actual).toPromise();
					}
				}
			} finally {
				await engine.closeDocument(expected).toPromise();
			}
			const pdf = await PDFDocument.load(result.bytes);
			const page = pdf.getPage(0);
			expect(page.getMediaBox()).toEqual({
				x: sample.media[0],
				y: sample.media[1],
				width: sample.media[2],
				height: sample.media[3],
			});
			const link = page.node.Annots()?.lookup(0, PDFDict);
			if (!link) throw new Error("Missing relocated link");
			expect(
				link
					.lookup(PDFName.of("A"), PDFDict)
					.get(PDFName.of("URI"))
					?.toString(),
			).toContain("example.org/paper");
			const rect = link.lookup(PDFName.of("Rect"), PDFArray);
			const formula = result.pages[0].paragraphs[0].units.find(
				(u) => u.formula,
			);
			if (!formula) throw new Error("Missing formula unit");
			expect(rect.lookup(0, PDFNumber).asNumber()).toBeCloseTo(
				sample.x + formula.x,
			);
			expect(rect.lookup(1, PDFNumber).asNumber()).toBeCloseTo(
				sample.y + 200 - formula.y,
			);
			if (outputDir) {
				mkdirSync(outputDir, { recursive: true });
				writeFileSync(join(outputDir, `${sample.name}-input.pdf`), input);
				writeFileSync(
					join(outputDir, `${sample.name}-output.pdf`),
					result.bytes,
				);
			}
		} finally {
			await engine.closeDocument(source).toPromise();
			await engine.closeDocument(baseline).toPromise();
		}
	}, 30000);
});
