/**
 * Pin-anchor projections of the ask threads / translate records.
 *
 * The viewer's marks arrays are replaced wholesale on every stream chunk, but
 * gutter pins only depend on anchor geometry — these projections isolate that
 * geometry with a stable identity (see {@link useStableDerived}) so
 * `buildMarksIndex` (and with it every mounted page) skips re-deriving while an
 * answer / translation streams.
 */

import { useStableDerived } from "@/components/viewer/pdf/hooks/use-stable-derived";
import { threadHasUserQuestion, threadPreview } from "@/lib/pdf/ask/schema";
import type { PdfAskNormalizedRect, PdfAskThread } from "@/lib/pdf/ask/types";
import type {
	PdfTranslateRecord,
	PdfTranslateRect,
} from "@/lib/pdf/translate/types";

/**
 * Geometry-only projection of a mark for gutter pins. Extracted from the ask /
 * translate arrays with a stable identity (see {@link useStableDerived}) so the
 * per-chunk streaming message bodies cannot invalidate `pinsByPage` (and with it
 * every mounted page).
 */
export type AskPinAnchor = {
	id: string;
	/** 1-based page number */
	page: number;
	rects: PdfAskNormalizedRect[];
	preview: string;
	ended: boolean;
};

export type TranslatePinAnchor = {
	id: string;
	/** 1-based page number */
	page: number;
	rects: PdfTranslateRect[];
	preview: string;
	hasError: boolean;
};

/** Compact value fingerprint of normalized rects (pin geometry input). */
function rectsKey(
	rects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
): string {
	return rects.map((r) => `${r.x},${r.y},${r.w},${r.h}`).join("~");
}

export type UsePdfPinAnchorsOptions = {
	threads: PdfAskThread[];
	translates: PdfTranslateRecord[];
};

export type PdfPinAnchors = {
	askPinAnchors: AskPinAnchor[];
	translatePinAnchors: TranslatePinAnchor[];
};

export function usePdfPinAnchors({
	threads,
	translates,
}: UsePdfPinAnchorsOptions): PdfPinAnchors {
	/**
	 * Pin geometry is anchor data only. While an answer / translation streams,
	 * every chunk replaces the whole threads / translates array, but none of the
	 * fields fingerprinted below change — so these projections keep their
	 * identity and `pinsByPage` (and thus every mounted page) skips re-rendering
	 * per chunk. The translate pin preview therefore uses the source quote, not
	 * the streamed result (the open card shows the live text).
	 */
	const askPinAnchors = useStableDerived<AskPinAnchor[]>(
		() =>
			threads.filter(threadHasUserQuestion).map((th) => ({
				id: th.id,
				page: th.anchor.page,
				rects: th.anchor.rects,
				preview: threadPreview(th),
				ended: th.status === "ended",
			})),
		threads
			.map(
				(th) =>
					`${th.id}|${threadHasUserQuestion(th) ? 1 : 0}|${th.anchor.page}|${th.status}|${threadPreview(th)}|${rectsKey(th.anchor.rects)}`,
			)
			.join(";"),
	);
	const translatePinAnchors = useStableDerived<TranslatePinAnchor[]>(
		() =>
			translates.map((tr) => ({
				id: tr.id,
				page: tr.page,
				rects: tr.rects,
				preview: tr.quote?.trim() || tr.id,
				hasError: Boolean(tr.error),
			})),
		translates
			.map(
				(tr) =>
					`${tr.id}|${tr.page}|${tr.error ? 1 : 0}|${tr.quote ?? ""}|${rectsKey(tr.rects)}`,
			)
			.join(";"),
	);
	return { askPinAnchors, translatePinAnchors };
}
