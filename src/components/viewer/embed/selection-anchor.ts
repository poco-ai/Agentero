import type { Size } from "@embedpdf/models";
import type { FormattedSelection } from "@embedpdf/plugin-selection/react";

import { clamp01 } from "@/lib/core/math";
import type {
	PdfAskAnchor,
	PdfAskNormalizedRect,
	PdfAskTrigger,
} from "@/lib/pdf/ask/types";

/**
 * Build a normalized {@link PdfAskAnchor} from an EmbedPDF text selection.
 * EmbedPDF reports rects in PDF page coordinates (points); dividing by the page
 * size yields the 0–1 rects the Ask/Translate marks + pins use.
 *
 * Ask/Translate anchor to a single page — the first page of the selection.
 */
export function anchorFromEmbedSelection(
	pages: FormattedSelection[],
	quote: string,
	pageSizePoints: (pageIndex: number) => Size | null,
	trigger: PdfAskTrigger = "selection",
): PdfAskAnchor | null {
	const first = pages[0];
	if (!first) return null;
	const size = pageSizePoints(first.pageIndex);
	if (!size || size.width <= 0 || size.height <= 0) return null;
	const rects: PdfAskNormalizedRect[] = first.segmentRects
		.filter((r) => r.size.width > 0 && r.size.height > 0)
		.map((r) => ({
			x: clamp01(r.origin.x / size.width),
			y: clamp01(r.origin.y / size.height),
			w: clamp01(r.size.width / size.width),
			h: clamp01(r.size.height / size.height),
		}));
	if (!rects.length) return null;
	return {
		page: first.pageIndex + 1,
		rects,
		quote: quote.trim() || undefined,
		trigger,
	};
}
