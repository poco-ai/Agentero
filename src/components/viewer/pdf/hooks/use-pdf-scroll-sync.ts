import { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import { useViewportCapability } from "@embedpdf/plugin-viewport/react";
import { useEffect, useMemo, useRef } from "react";
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
	const initialSyncDoneRef = useRef(false);

	useEffect(() => {
		if (!partnerId || !viewportCap || !docCap) return;
		if (!docCap.isDocumentOpen(docId) || !docCap.isDocumentOpen(partnerId))
			return;

		const myScope = viewportCap.forDocument(docId);
		const partnerScope = viewportCap.forDocument(partnerId);
		if (!myScope || !partnerScope) return;

		const applyScroll = (
			fromScope: typeof myScope,
			toScope: typeof partnerScope,
			targetDocId: string,
		) => {
			if (isScrollSyncApplying(targetDocId)) return;
			const fromMetrics = fromScope.getMetrics();
			if (fromMetrics.scrollHeight <= 0 || fromMetrics.scrollWidth <= 0) return;
			const toMetrics = toScope.getMetrics();
			if (toMetrics.scrollHeight <= 0 || toMetrics.scrollWidth <= 0) return;
			const ratioY = fromMetrics.scrollTop / fromMetrics.scrollHeight;
			const ratioX = fromMetrics.scrollLeft / fromMetrics.scrollWidth;
			runSyncedScroll(targetDocId, () => {
				try {
					toScope.scrollTo({
						x: ratioX * toMetrics.scrollWidth,
						y: ratioY * toMetrics.scrollHeight,
						behavior: "instant",
					});
				} catch {
					// Ignore transient scroll failures while the target viewport is
					// still initializing.
				}
			});
		};

		const unsubscribeMy = myScope.onScrollChange(() => {
			applyScroll(myScope, partnerScope, partnerId);
		});

		const unsubscribePartner = partnerScope.onScrollChange(() => {
			applyScroll(partnerScope, myScope, docId);
		});

		// One-time initial alignment: when the translation pane first loads,
		// snap it to the source pane's current scroll ratio so both panels show
		// the same page instead of the right pane staying at the top.
		if (!initialSyncDoneRef.current) {
			initialSyncDoneRef.current = true;
			applyScroll(myScope, partnerScope, partnerId);
		}

		return () => {
			unsubscribeMy();
			unsubscribePartner();
		};
	}, [docId, partnerId, viewportCap, docCap]);
}
