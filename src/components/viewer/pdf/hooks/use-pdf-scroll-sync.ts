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
	const partnerId = useMemo(() => getScrollSyncPartner(docId), [docId]);

	useEffect(() => {
		if (!partnerId || !viewportCap) return;

		const myScope = viewportCap.forDocument(docId);
		const partnerScope = viewportCap.forDocument(partnerId);

		const unsubscribeMy = myScope.onScrollChange((metrics) => {
			if (isScrollSyncApplying(docId)) return;
			const myMetrics = myScope.getMetrics();
			const ratioY =
				myMetrics.scrollHeight > 0
					? metrics.scrollTop / myMetrics.scrollHeight
					: 0;
			const ratioX =
				myMetrics.scrollWidth > 0
					? metrics.scrollLeft / myMetrics.scrollWidth
					: 0;
			const partnerMetrics = partnerScope.getMetrics();
			runSyncedScroll(partnerId, () => {
				partnerScope.scrollTo({
					x: ratioX * partnerMetrics.scrollWidth,
					y: ratioY * partnerMetrics.scrollHeight,
					behavior: "instant",
				});
			});
		});

		const unsubscribePartner = partnerScope.onScrollChange((metrics) => {
			if (isScrollSyncApplying(partnerId)) return;
			const partnerMetrics = partnerScope.getMetrics();
			const ratioY =
				partnerMetrics.scrollHeight > 0
					? metrics.scrollTop / partnerMetrics.scrollHeight
					: 0;
			const ratioX =
				partnerMetrics.scrollWidth > 0
					? metrics.scrollLeft / partnerMetrics.scrollWidth
					: 0;
			const myMetrics = myScope.getMetrics();
			runSyncedScroll(docId, () => {
				myScope.scrollTo({
					x: ratioX * myMetrics.scrollWidth,
					y: ratioY * myMetrics.scrollHeight,
					behavior: "instant",
				});
			});
		});

		return () => {
			unsubscribeMy();
			unsubscribePartner();
		};
	}, [docId, partnerId, viewportCap]);
}
