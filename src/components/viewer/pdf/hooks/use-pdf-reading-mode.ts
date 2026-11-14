/**
 * Applies the PDF reading preferences (scroll direction + page layout) to one
 * EmbedPDF viewer.
 *
 * The preferences live in Host settings and are broadcast across windows, so a
 * change here re-applies without a reload. The document has already loaded by
 * the time the inner viewers mount, so the scroll/spread scopes exist; the
 * `totalPages` dependency retries the no-op that `setScrollStrategy` /
 * `setSpreadMode` perform if the document state is not ready yet.
 */

import { ScrollStrategy, useScroll } from "@embedpdf/plugin-scroll/react";
import { SpreadMode, useSpread } from "@embedpdf/plugin-spread/react";
import { useEffect, useRef } from "react";
import { useSettings } from "@/hooks/use-app-stores";
import type { PdfScrollStrategy, PdfSpreadMode } from "@/lib/settings/types";

const SCROLL_STRATEGY: Record<PdfScrollStrategy, ScrollStrategy> = {
	vertical: ScrollStrategy.Vertical,
	horizontal: ScrollStrategy.Horizontal,
	paginated: ScrollStrategy.Vertical,
};

const SPREAD_MODE: Record<PdfSpreadMode, SpreadMode> = {
	none: SpreadMode.None,
	odd: SpreadMode.Odd,
	even: SpreadMode.Even,
};

export function usePdfReadingMode(docId: string): void {
	const strategy = useSettings((s) => s.pdfScrollStrategy);
	const spreadMode = useSettings((s) => s.pdfSpreadMode);
	const { provides: scroll, state: scrollState } = useScroll(docId);
	const totalPages = scrollState.totalPages || 0;
	const { provides: spread } = useSpread(docId);

	// EmbedPDF returns a fresh scope object every render; keep it out of deps and
	// key the effects on primitives (+ totalPages as the layout-ready signal).
	const scrollRef = useRef(scroll);
	scrollRef.current = scroll;
	const spreadRef = useRef(spread);
	spreadRef.current = spread;

	const appliedModeRef = useRef<string | null>(null);

	useEffect(() => {
		const scope = scrollRef.current;
		if (!scope || !totalPages) return;
		const mode = `${docId}:${strategy}:${spreadMode}`;
		const changed =
			appliedModeRef.current !== null && appliedModeRef.current !== mode;
		appliedModeRef.current = mode;
		const pageNumber = scope.getCurrentPage();
		scope.setScrollStrategy(SCROLL_STRATEGY[strategy]);
		spreadRef.current?.setSpreadMode(
			strategy === "paginated" ? SpreadMode.None : SPREAD_MODE[spreadMode],
		);
		// Changing layout recomputes the current page from the old scroll offset.
		// Re-anchor to the page the reader was on before switching modes.
		// Initial position belongs to usePdfNavigation's reading-position restore.
		if (changed) scope.scrollToPage({ pageNumber, behavior: "instant" });
	}, [docId, strategy, spreadMode, totalPages]);
}
