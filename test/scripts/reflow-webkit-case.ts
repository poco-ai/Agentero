// Bundled for the optional native JSC runner, not included in ordinary Vitest.
import type {
	PdfDocumentObject,
	PdfEngine,
	PdfPageObject,
} from "@embedpdf/models";
import type { LayoutTranslateItem } from "../../src/lib/pdf/layout/types";
import { extractReflowDocument } from "../../src/lib/pdf/reflow/extract";

const count = 2400;
const task = <T>(value: T) => ({
	toPromise: () =>
		new Promise<T>((resolve) => setTimeout(() => resolve(value), 0)),
});
const document = {
	id: "webkit-page-fonts",
	pages: Array.from({ length: 4 }, (_, index) => ({
		index,
		size: { width: 600, height: 800 },
	})),
} as PdfDocumentObject;
const engine = {
	getPageGlyphs: () =>
		task(
			Array.from({ length: count }, (_, index) => ({
				origin: {
					x: 10 + (index % 80) * 6,
					y: 10 + Math.floor(index / 80) * 14,
				},
				size: { width: 6, height: 10 },
				textObjectId: 1,
			})),
		),
	getTextSlices: () => task(Array<string>(count).fill("a")),
	getPageTextRuns: (_: PdfDocumentObject, page: PdfPageObject) =>
		task({
			runs: [
				{
					charIndex: 0,
					charCount: count,
					font: { name: `PageFont${page.index}`, weight: 400 },
					fontSize: 10,
					color: { red: 0, green: 0, blue: 0 },
				},
			],
		}),
	renderPageRaw: () =>
		task({ width: 1, height: 1, data: new Uint8ClampedArray(4) }),
} as unknown as PdfEngine;
const items: LayoutTranslateItem[] = document.pages.flatMap((page) =>
	Array.from({ length: 30 }, (_, row) => ({
		id: `${page.index}:${row}`,
		pageIndex: page.index,
		kind: "text",
		source: "body",
		status: "pending",
		bbox: { x: 0, y: (8 + row * 14) / 800, w: 1, h: 14 / 800 },
		readingOrder: row,
	})),
);
const state = globalThis as typeof globalThis & {
	reflowCheckDone?: boolean;
	reflowCheckError?: string;
};
void extractReflowDocument(engine, document, items, [])
	.then((result) => {
		if (result.pages.length !== 4) throw new Error("Missing pages");
		for (const page of result.pages) {
			const characters = page.paragraphs.flatMap((p) => p.characters);
			if (characters.length !== count)
				throw new Error(
					`Page ${page.index}: ${characters.length}/${count} characters`,
				);
			if (characters.some((c) => c.style.font !== `PageFont${page.index}`))
				throw new Error(`Page ${page.index}: wrong page font`);
		}
		state.reflowCheckDone = true;
	})
	.catch((error) => {
		state.reflowCheckDone = true;
		state.reflowCheckError = String(error);
	});
