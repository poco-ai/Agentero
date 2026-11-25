/**
 * Layout regions for one document, bucketed per page.
 *
 * Results live in `layoutAnalysisStore` (shared with the Figures rail and the
 * CLI-written sidecar); this hook only subscribes and derives. The two bucket
 * passes are whole-document (NMS / spurious-detection suppression), so they must
 * never run inside per-page render — scrolling re-renders every mounted page.
 */

import { useMemo } from "react";
import { useStore } from "zustand";
import { EMPTY_LAYOUT_REGIONS_BY_PAGE } from "@/components/viewer/pdf/constants";
import {
	LAYOUT_SIDEBAR_MIN_SCORE,
	layoutAnalysisStore,
	layoutDocumentKey,
	type PdfLayoutRegion,
	rawLayoutRegionsByPage,
	selectableLayoutRegionsByPage,
} from "@/lib/pdf/layout";

export type PdfLayoutRegions = {
	/** Figures rail header toggle; also drives the debug Eye overlay. */
	layoutOverlayVisible: boolean;
	/** Post-merge regions, flat (bulk translate walks the raw set instead). */
	layoutDocRegions: PdfLayoutRegion[] | null;
	/** Pre-merge detections, flat: the bulk-translate source. */
	layoutRawRegions: PdfLayoutRegion[] | null;
	/**
	 * Element-selection targets, bucketed by 0-based page index, largest first.
	 * Includes display formulas without a numbered sidebar host.
	 */
	selectableRegionsByPage: ReadonlyMap<number, PdfLayoutRegion[]>;
	/** Pre-merge detections for the debug Eye overlay, bucketed by page. */
	rawRegionsByPage: ReadonlyMap<number, PdfLayoutRegion[]>;
};

export function usePdfLayoutRegions(docId: string): PdfLayoutRegions {
	// `byDocument` is keyed by the revision-stripped base id (the translation
	// pane seeds it from the source pane while each viewer mounts its own
	// `tab::r<n>`); `overlayVisible` stays raw — same-viewer writers only.
	const documentKey = layoutDocumentKey(docId);
	/** Figures rail header toggles this; mirror into EmbedPDF plugin. */
	const layoutOverlayVisible = useStore(
		layoutAnalysisStore,
		(s) => s.overlayVisible[docId] ?? false,
	);
	/** Post-merge layout regions for the element selection view. */
	const layoutDocRegions = useStore(
		layoutAnalysisStore,
		(s) => s.byDocument[documentKey]?.regions ?? null,
	);
	/** Pre-merge detections for the debug Eye overlay (all model boxes). */
	const layoutRawRegions = useStore(
		layoutAnalysisStore,
		(s) =>
			s.byDocument[documentKey]?.rawRegions ??
			s.byDocument[documentKey]?.regions ??
			null,
	);
	/**
	 * Element-selection targets and debug boxes, bucketed by page. Both passes
	 * are whole-document (NMS / spurious-detection suppression), so they must
	 * not run inside per-page render — scrolling re-renders every mounted page.
	 */
	const selectableRegionsByPage = useMemo(
		() =>
			layoutDocRegions
				? selectableLayoutRegionsByPage(
						layoutDocRegions,
						LAYOUT_SIDEBAR_MIN_SCORE,
						layoutRawRegions,
					)
				: EMPTY_LAYOUT_REGIONS_BY_PAGE,
		[layoutDocRegions, layoutRawRegions],
	);
	const rawRegionsByPage = useMemo(
		() =>
			layoutOverlayVisible && layoutRawRegions
				? rawLayoutRegionsByPage(layoutRawRegions)
				: EMPTY_LAYOUT_REGIONS_BY_PAGE,
		[layoutOverlayVisible, layoutRawRegions],
	);

	return {
		layoutOverlayVisible,
		layoutDocRegions,
		layoutRawRegions,
		selectableRegionsByPage,
		rawRegionsByPage,
	};
}
