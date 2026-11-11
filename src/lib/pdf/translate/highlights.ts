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

/**
 * Records that keep a source tint while their card is closed.
 *
 * Only pinned results survive dismissal, so an unpinned leftover — a mark
 * file from a crashed/killed session, or a card that never got placed — must
 * not paint a highlight with nothing behind it.
 */
export function tintedTranslateRecords(
	records: readonly PdfTranslateRecord[],
): PdfTranslateRecord[] {
	return records.filter((record) => record.pinned === true);
}

export function translateHighlightsByPage(
	records: readonly PdfTranslateRecord[],
): Map<number, TranslateHighlight[]> {
	const byPage = new Map<number, TranslateHighlight[]>();
	for (const rec of records) {
		if (rec.rects.length === 0) continue;
		const item: TranslateHighlight = { id: rec.id, rects: rec.rects };
		const list = byPage.get(rec.page);
		if (list) list.push(item);
		else byPage.set(rec.page, [item]);
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
		out += rec.page;
		out += ":";
		for (const rect of rec.rects) {
			out += rect.x;
			out += ",";
			out += rect.y;
			out += ",";
			out += rect.w;
			out += ",";
			out += rect.h;
			out += ";";
		}
		out += "|";
	}
	return out;
}
