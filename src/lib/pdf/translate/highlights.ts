/**
 * Geometry-only index of selection-translate spans.
 *
 * Streaming updates `result` on every chunk. Callers must key memos on
 * {@link translateHighlightsFingerprint}, not the record array, or every
 * token re-renders mounted PDF pages.
 */

import type {
	PdfTranslateRecord,
	PdfTranslateRect,
} from "@/lib/pdf/translate/types";

export type TranslateHighlight = {
	id: string;
	rects: PdfTranslateRect[];
};

export function translateHighlightsByPage(
	records: readonly PdfTranslateRecord[],
): Map<number, TranslateHighlight[]> {
	const byPage = new Map<number, TranslateHighlight[]>();
	for (const rec of records) {
		for (const selection of rec.selectionPages ?? [rec]) {
			if (selection.rects.length === 0) continue;
			const item: TranslateHighlight = { id: rec.id, rects: selection.rects };
			const list = byPage.get(selection.page);
			if (list) list.push(item);
			else byPage.set(selection.page, [item]);
		}
	}
	return byPage;
}

export function translateHighlightsFingerprint(
	records: readonly PdfTranslateRecord[],
): string {
	let out = "";
	for (const rec of records) {
		out += rec.id;
		out += ":";
		for (const selection of rec.selectionPages ?? [rec]) {
			out += selection.page;
			out += ":";
			for (const rect of selection.rects) {
				out += rect.x;
				out += ",";
				out += rect.y;
				out += ",";
				out += rect.w;
				out += ",";
				out += rect.h;
				out += ";";
			}
		}
		out += "|";
	}
	return out;
}
