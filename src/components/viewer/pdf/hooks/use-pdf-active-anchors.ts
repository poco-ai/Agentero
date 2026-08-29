/**
 * Active-card lookups and their on-page anchor projections.
 *
 * `activeThread` / `activeTranslate` / `activeVisualTrace` feed the card stack
 * (full records, fresh identity per stream chunk). The `*Anchor` values are
 * anchor geometry only and go into the page layers via `pageMarks`.
 */

import { useMemo } from "react";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import { isVisualMarkKind } from "@/lib/pdf/agent-trace";
import type { PdfAskNormalizedRect, PdfAskThread } from "@/lib/pdf/ask/types";
import type { ActiveSelectionCard } from "@/lib/pdf/selection";
import type {
	PdfTranslateRecord,
	PdfTranslateRect,
} from "@/lib/pdf/translate/types";

export type UsePdfActiveAnchorsOptions = {
	/** Open card; owned by {@link usePdfCards}. */
	activeCard: ActiveSelectionCard | null;
	threads: PdfAskThread[];
	translates: PdfTranslateRecord[];
	visualTraces: PdfVisualSessionTrace[];
};

export type PdfActiveAnchors = {
	activeThread: PdfAskThread | null;
	activeTranslate: PdfTranslateRecord | null;
	activeVisualTrace: PdfVisualSessionTrace | null;
	activeAskAnchor: {
		id: string;
		page: number;
		rects: PdfAskNormalizedRect[];
	} | null;
	activeTranslateAnchor: {
		id: string;
		page: number;
		rects: PdfTranslateRect[];
	} | null;
};

export function usePdfActiveAnchors({
	activeCard,
	threads,
	translates,
	visualTraces,
}: UsePdfActiveAnchorsOptions): PdfActiveAnchors {
	const activeThread = useMemo(() => {
		if (activeCard?.kind !== "ask") return null;
		return threads.find((th) => th.id === activeCard.id) ?? null;
	}, [threads, activeCard]);
	const activeTranslate = useMemo(() => {
		if (activeCard?.kind !== "translate") return null;
		return translates.find((tr) => tr.id === activeCard.id) ?? null;
	}, [translates, activeCard]);
	const activeVisualTrace = useMemo(() => {
		if (!isVisualMarkKind(activeCard?.kind)) return null;
		return visualTraces.find((tr) => tr.id === activeCard.id) ?? null;
	}, [visualTraces, activeCard]);
	/**
	 * On-page source frame of the active ask / translate card: anchor geometry
	 * only. The page layers never read the streaming body, and the rects
	 * reference survives chunk updates (updaters spread the record and replace
	 * `messages` / `result` only), so these keep their identity while streaming
	 * — unlike the full records the card stack consumes.
	 */
	const activeAskId = activeThread?.id ?? null;
	const activeAskPage = activeThread?.anchor.page ?? null;
	const activeAskRects = activeThread?.anchor.rects ?? null;
	const activeAskAnchor = useMemo(
		() =>
			activeAskId !== null && activeAskPage !== null && activeAskRects !== null
				? { id: activeAskId, page: activeAskPage, rects: activeAskRects }
				: null,
		[activeAskId, activeAskPage, activeAskRects],
	);
	const activeTranslateId = activeTranslate?.id ?? null;
	const activeTranslatePage = activeTranslate?.page ?? null;
	const activeTranslateRects = activeTranslate?.rects ?? null;
	const activeTranslateAnchor = useMemo(
		() =>
			activeTranslateId !== null &&
			activeTranslatePage !== null &&
			activeTranslateRects !== null
				? {
						id: activeTranslateId,
						page: activeTranslatePage,
						rects: activeTranslateRects,
					}
				: null,
		[activeTranslateId, activeTranslatePage, activeTranslateRects],
	);
	return {
		activeThread,
		activeTranslate,
		activeVisualTrace,
		activeAskAnchor,
		activeTranslateAnchor,
	};
}
