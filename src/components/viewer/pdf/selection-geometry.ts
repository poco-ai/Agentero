import type { PdfEngine, Rect } from "@embedpdf/models";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import type { FormattedSelection } from "@embedpdf/plugin-selection/react";
import {
	bboxToPageRect,
	locateSelectionGlyphs,
	type TranslationPagePick,
	type TranslationSelection,
} from "@/lib/pdf/layout/layout-sentence-selection";
import {
	mergeTightGlyphRects,
	unionRectsAll,
} from "@/lib/pdf/selection-appearance";

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];
export async function locatePdfSelectionPages(
	engine: PdfEngine | null,
	docCap: DocumentManagerCapability,
	docId: string,
	selection: TranslationSelection,
	generation: () => boolean,
): Promise<FormattedSelection[] | null> {
	if (!selection.canLocate) return [];
	const doc = docCap?.getDocument(docId);
	const grouped = new Map<number, TranslationPagePick[]>();
	for (const pick of selection.pages) {
		const list = grouped.get(pick.pageIndex) ?? [];
		list.push(pick);
		grouped.set(pick.pageIndex, list);
	}
	const formatted: FormattedSelection[] = [];
	for (const [pageIndex, picks] of grouped) {
		if (!generation()) return null;
		const page = doc?.pages[pageIndex];
		const size = page?.size;
		if (!page || !size || size.width <= 0 || size.height <= 0) return [];
		let glyphs: { text: string; rect: Rect }[] = [];
		if (engine && doc && picks.some((pick) => !pick.glyphRects?.length)) {
			try {
				const raw = await engine.getPageGlyphs(doc, page).toPromise();
				if (!generation()) return null;
				const text = await engine
					.getTextSlices(
						doc,
						raw.map((_, charIndex) => ({
							pageIndex,
							charIndex,
							charCount: 1,
							rawCharacters: true,
						})),
					)
					.toPromise();
				glyphs = raw.map((glyph, index) => ({
					text: text[index] ?? "",
					rect: {
						origin: glyph.tightOrigin ?? glyph.origin,
						size: glyph.tightSize ?? glyph.size,
					},
				}));
			} catch {
				glyphs = [];
			}
		}
		if (!generation()) return null;
		const locatePick = (pick: TranslationPagePick): Rect[] => {
			if (pick.glyphRects?.length) return pick.glyphRects;
			const located = locateSelectionGlyphs(
				pick,
				glyphs,
				size.width,
				size.height,
			);
			if (located.length) return located;
			// The whole block is the annotation only when the selection is that
			// block. A sentence that missed the text layer must not fill the block.
			if (pick.wholeBlock) {
				return [bboxToPageRect(pick.bbox, size.width, size.height)];
			}
			return [];
		};
		const rectsByBlock = new Map<TranslationPagePick["bbox"], Rect[]>();
		for (const pick of picks) {
			const located = locatePick(pick).filter(
				(rect) => rect.size.width > 0 && rect.size.height > 0,
			);
			// Do not persist only the locatable pieces of a multi-sentence selection.
			if (!located.length) return [];
			const rects = rectsByBlock.get(pick.bbox);
			if (rects) rects.push(...located);
			else rectsByBlock.set(pick.bbox, located);
		}
		const segmentRects = [...rectsByBlock.values()].flatMap(
			mergeTightGlyphRects,
		);
		const rect = unionRectsAll(segmentRects);
		if (!rect) return [];
		formatted.push({ pageIndex, rect, segmentRects });
	}
	return formatted;
}
