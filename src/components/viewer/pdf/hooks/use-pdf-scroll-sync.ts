import { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import { useViewportCapability } from "@embedpdf/plugin-viewport/react";
import { useEffect, useMemo } from "react";
import {
	getScrollSyncPartner,
	isScrollSyncApplying,
	runSyncedScroll,
} from "@/lib/pdf/scroll-sync";

export type PdfScrollPosition = {
	x: number;
	y: number;
};

/**
 * Bidirectionally sync scroll position between this PDF viewer and its paired
 * partner (e.g. the right-hand translation pane). Synchronization uses relative
 * ratios so small differences in panel size do not drift the two views apart.
 */
export function usePdfScrollSync(docId: string): void {
	const viewportCap = useViewportCapability().provides;
	const docCap = useDocumentManagerCapability().provides;
	const partnerId = useMemo(() => getScrollSyncPartner(docId), [docId]);

	useEffect(() => {
		if (!partnerId || !viewportCap || !docCap) return;
		if (!docCap.isDocumentOpen(docId) || !docCap.isDocumentOpen(partnerId))
			return;

		const myScope = viewportCap.forDocument(docId);
		const partnerScope = viewportCap.forDocument(partnerId);

		const unsubscribeMy = myScope.onScrollChange((metrics) => {
			if (isScrollSyncApplying(docId)) return;
			const myMetrics = myScope.getMetrics();
			if (myMetrics.scrollHeight <= 0 || myMetrics.scrollWidth <= 0) return;
			const ratioY = metrics.scrollTop / myMetrics.scrollHeight;
			const ratioX = metrics.scrollLeft / myMetrics.scrollWidth;
			const partnerMetrics = partnerScope.getMetrics();
			if (partnerMetrics.scrollHeight <= 0 || partnerMetrics.scrollWidth <= 0)
				return;
			runSyncedScroll(partnerId, () => {
				try {
					partnerScope.scrollTo({
						x: ratioX * partnerMetrics.scrollWidth,
						y: ratioY * partnerMetrics.scrollHeight,
						behavior: "instant",
					});
				} catch {
					// Ignore transient scroll failures while the partner viewport is
					// still initializing.
				}
			});
		});

		const unsubscribePartner = partnerScope.onScrollChange((metrics) => {
			if (isScrollSyncApplying(partnerId)) return;
			const partnerMetrics = partnerScope.getMetrics();
			if (partnerMetrics.scrollHeight <= 0 || partnerMetrics.scrollWidth <= 0)
				return;
			const ratioY = metrics.scrollTop / partnerMetrics.scrollHeight;
			const ratioX = metrics.scrollLeft / partnerMetrics.scrollWidth;
			const myMetrics = myScope.getMetrics();
			if (myMetrics.scrollHeight <= 0 || myMetrics.scrollWidth <= 0) return;
			runSyncedScroll(docId, () => {
				try {
					myScope.scrollTo({
						x: ratioX * myMetrics.scrollWidth,
						y: ratioY * myMetrics.scrollHeight,
						behavior: "instant",
					});
				} catch {
					// Ignore transient scroll failures while this viewport is
					// still initializing.
				}
			});
		});

		return () => {
			unsubscribeMy();
			unsubscribePartner();
		};
	}, [docId, partnerId, viewportCap, docCap]);
}
