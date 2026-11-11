import type {
	PdfDocumentObject,
	PdfEngine,
	PdfPageObject,
} from "@embedpdf/models";
import { expect, it } from "vitest";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";
import { extractReflowDocument } from "@/lib/pdf/reflow/extract";

it("keeps font metadata local to each page across asynchronous extraction", async () => {
	const count = 2400;
	const task = <T>(value: T) => ({
		toPromise: () =>
			new Promise<T>((resolve) => setTimeout(() => resolve(value), 0)),
	});
	const document = {
		id: "page-fonts",
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
					// Object handles are only meaningful within a page.
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
	const result = await extractReflowDocument(engine, document, items, []);
	for (const page of result.pages) {
		const characters = page.paragraphs.flatMap(
			(paragraph) => paragraph.characters,
		);
		expect(characters).toHaveLength(count);
		expect(
			new Set(characters.map((character) => character.style.font)),
		).toEqual(new Set([`PageFont${page.index}`]));
	}
});
