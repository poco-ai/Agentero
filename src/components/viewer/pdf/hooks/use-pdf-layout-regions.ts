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
	hoverableLayoutRegionsByPage,
	layoutAnalysisStore,
	type PdfLayoutRegion,
	rawLayoutRegionsByPage,
} from "@/lib/pdf/layout";

export type PdfLayoutRegions = {
	/** Figures rail header toggle; also drives the debug Eye overlay. */
	layoutOverlayVisible: boolean;
	/** Post-merge regions, flat (bulk translate walks the raw set instead). */
	layoutDocRegions: PdfLayoutRegion[] | null;
	/** Pre-merge detections, flat: the bulk-translate source. */
	layoutRawRegions: PdfLayoutRegion[] | null;
	/** Post-merge hover hit targets, bucketed by 0-based page index. */
	hoverableRegionsByPage: ReadonlyMap<number, PdfLayoutRegion[]>;
	/** Pre-merge detections for the debug Eye overlay, bucketed by page. */
	rawRegionsByPage: ReadonlyMap<number, PdfLayoutRegion[]>;
};

export function usePdfLayoutRegions(docId: string): PdfLayoutRegions {
	/** Figures rail header toggles this; mirror into EmbedPDF plugin. */
	const layoutOverlayVisible = useStore(
		layoutAnalysisStore,
		(s) => s.overlayVisible[docId] ?? false,
	);
	/** Post-merge layout regions for hover hit targets (figures rail source). */
	const layoutDocRegions = useStore(
		layoutAnalysisStore,
		(s) => s.byDocument[docId]?.regions ?? null,
	);
	/** Pre-merge detections for the debug Eye overlay (all model boxes). */
	const layoutRawRegions = useStore(
		layoutAnalysisStore,
		(s) =>
			s.byDocument[docId]?.rawRegions ?? s.byDocument[docId]?.regions ?? null,
	);
	/**
	 * Hover hit targets and debug boxes, bucketed by page. Both passes are
	 * whole-document (NMS / spurious-detection suppression), so they must not run
	 * inside per-page render — scrolling re-renders every mounted page.
	 */
	const hoverableRegionsByPage = useMemo(
		() =>
			layoutDocRegions
				? hoverableLayoutRegionsByPage(layoutDocRegions)
				: EMPTY_LAYOUT_REGIONS_BY_PAGE,
		[layoutDocRegions],
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
		hoverableRegionsByPage,
		rawRegionsByPage,
	};
}
