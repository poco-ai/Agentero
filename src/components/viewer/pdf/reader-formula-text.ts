import type {
	PdfDocumentObject,
	PdfEngine,
	PdfGlyphObject,
} from "@embedpdf/models";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";

export type ReaderFormulaContent = {
	text: string;
	glyphs: { index: number; text: string; box: PdfAskNormalizedRect }[];
};

type PageText = { glyphs: PdfGlyphObject[]; text: string[] };
const documents = new WeakMap<
	PdfDocumentObject,
	Map<number, Promise<PageText>>
>();

/** Native text only; a PDF glyph sequence is never passed off as LaTeX. */
export async function readerFormulaText({
	engine,
	document,
	pageIndex,
	region,
}: {
	engine: PdfEngine;
	document: PdfDocumentObject;
	pageIndex: number;
	region: PdfAskNormalizedRect;
}): Promise<ReaderFormulaContent> {
	const page = document.pages[pageIndex];
	if (!page) return { text: "", glyphs: [] };
	let cache = documents.get(document);
	if (!cache) {
		cache = new Map();
		documents.set(document, cache);
	}
	let pending = cache.get(pageIndex);
	if (!pending) {
		pending = (async () => {
			const glyphs = await engine.getPageGlyphs(document, page).toPromise();
			const text = await engine
				.getTextSlices(
					document,
					glyphs.map((_, charIndex) => ({
						pageIndex,
						charIndex,
						charCount: 1,
						rawCharacters: true,
					})),
				)
				.toPromise();
			return { glyphs, text };
		})();
		cache.set(pageIndex, pending);
		const entries = cache;
		void pending.catch(() => {
			if (entries.get(pageIndex) === pending) entries.delete(pageIndex);
		});
	}
	cache.delete(pageIndex);
	cache.set(pageIndex, pending);
	while (cache.size > 3) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	const { glyphs, text } = await pending;
	const selected = glyphs.flatMap((glyph, index) => {
		const origin = glyph.tightOrigin ?? glyph.origin,
			size = glyph.tightSize ?? glyph.size;
		const x = (origin.x + size.width / 2) / page.size.width,
			y = (origin.y + size.height / 2) / page.size.height;
		return x >= region.x &&
			x <= region.x + region.w &&
			y >= region.y &&
			y <= region.y + region.h
			? [
					{
						index,
						text: text[index] ?? "",
						box: {
							x: (origin.x / page.size.width - region.x) / region.w,
							y: (origin.y / page.size.height - region.y) / region.h,
							w: size.width / page.size.width / region.w,
							h: size.height / page.size.height / region.h,
						},
					},
				]
			: [];
	});
	return {
		text: selected
			.map((glyph) => glyph.text)
			.join("")
			.trim(),
		glyphs: selected,
	};
}
