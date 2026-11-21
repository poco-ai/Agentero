/**
 * A translation highlight stores two geometries.
 *
 * English glyph boxes stay on the annotation (`segmentRects`) and are painted
 * only while the original page is showing. The boxes of the translated text
 * the reader actually selected live here, as page fractions, and are painted
 * only while that page's translation overlay is showing.
 */

import type { HighlightColor } from "@/lib/pdf/highlight/palette";
import { normalizeHighlightColor } from "@/lib/pdf/highlight/palette";
import type {
	PdfHighlight,
	PdfHighlightRect,
	PdfTextMarkupKind,
} from "@/lib/pdf/highlight/types";

export type TranslatedHighlightPaint = {
	id: string;
	color: HighlightColor;
	shape: PdfTextMarkupKind;
	rects: PdfHighlightRect[];
};

/**
 * English highlight with no translated boxes. `rects` are the English glyph
 * boxes already stored on the annotation. The overlay tints the sentence
 * whose own English boxes overlap these.
 */
export type HighlightQuoteTint = {
	id: string;
	quote: string;
	color: HighlightColor;
	shape: PdfTextMarkupKind;
	rects: PdfHighlightRect[];
};

/** Drop anything that is not a finite, positive page-fraction box. */
export function sanitizeTranslatedRects(value: unknown): PdfHighlightRect[] {
	if (!Array.isArray(value)) return [];
	const rects: PdfHighlightRect[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const rect = item as Partial<PdfHighlightRect>;
		const { x, y, w, h } = rect;
		if (
			typeof x !== "number" ||
			typeof y !== "number" ||
			typeof w !== "number" ||
			typeof h !== "number" ||
			!Number.isFinite(x) ||
			!Number.isFinite(y) ||
			!Number.isFinite(w) ||
			!Number.isFinite(h) ||
			w <= 0 ||
			h <= 0
		) {
			continue;
		}
		rects.push({ x, y, w, h });
	}
	return rects;
}

/**
 * Split highlights into the two paint paths. A highlight that recorded the
 * translated selection is not also sent to the sentence tint: that tint covers
 * the whole matched sentence, which is a different shape from the selection.
 */
export function partitionHighlightPaint(highlights: readonly PdfHighlight[]): {
	quotesByPage: Map<number, HighlightQuoteTint[]>;
	translatedByPage: Map<number, TranslatedHighlightPaint[]>;
} {
	const quotesByPage = new Map<number, HighlightQuoteTint[]>();
	const translatedByPage = new Map<number, TranslatedHighlightPaint[]>();
	for (const highlight of highlights) {
		const translated = sanitizeTranslatedRects(highlight.translatedRects);
		if (translated.length > 0) {
			const paint: TranslatedHighlightPaint = {
				id: highlight.id,
				color: normalizeHighlightColor(highlight.color),
				shape: highlight.kind,
				rects: translated,
			};
			const list = translatedByPage.get(highlight.page);
			if (list) list.push(paint);
			else translatedByPage.set(highlight.page, [paint]);
			continue;
		}
		const quote = highlight.quote.trim();
		if (!quote) continue;
		const tint: HighlightQuoteTint = {
			id: highlight.id,
			quote,
			color: normalizeHighlightColor(highlight.color),
			shape: highlight.kind,
			rects: highlight.rects,
		};
		const list = quotesByPage.get(highlight.page);
		if (list) list.push(tint);
		else quotesByPage.set(highlight.page, [tint]);
	}
	return { quotesByPage, translatedByPage };
}
