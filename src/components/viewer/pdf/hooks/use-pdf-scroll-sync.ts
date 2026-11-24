import { useScrollCapability } from "@embedpdf/plugin-scroll/react";
import { useViewportCapability } from "@embedpdf/plugin-viewport/react";
import { useZoomCapability } from "@embedpdf/plugin-zoom/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { stripEmbedPdfRevision } from "@/lib/pdf/document-id";
import {
	alignScrollSyncFrom,
	beginZoomSync,
	cancelPendingViewportScroll,
	endScrollSyncGesture,
	endZoomSync,
	getScrollSyncElement,
	getScrollSyncPartner,
	getScrollSyncPeer,
	getScrollSyncRole,
	holdScrollSync,
	registerScrollSyncPair,
	registerScrollSyncPeer,
	type ScrollSyncPeer,
	subscribeScrollSyncPairs,
	subscribeScrollSyncPeers,
} from "@/lib/pdf/scroll-sync";
import {
	clearPeerZoomPreview,
	commitPeerZoomPreview,
	finishPeerZoomPreview,
	peerZoomPreviewToken,
	settlePeerZoomPreview,
} from "@/lib/pdf/zoom-preview";
import { getTabs } from "@/lib/workspace/store";
import { findTranslationSourceId } from "@/lib/workspace/tabs";

/**
 * Frames to wait for the target's zoom relayout before realigning its scroll.
 * The plugin applies the zoom level synchronously, but the viewport's content
 * metrics (scrollHeight / scrollWidth) only settle after the Scroller
 * re-renders, so a fixed one-frame delay reads stale geometry. The mirrored
 * zoom preview is compensated on each of these frames, so waiting for the page
 * box matches the source pane's own settle allowance.
 */
const MAX_ZOOM_SETTLE_FRAMES = 30;

/**
 * The zoom gesture itself is a CSS-transform preview (see wheel-zoom-handler),
 * so the real level only lands once, when the gesture ends. The partner's
 * commit then only needs to clear this short debounce so both panes relayout
 * in the same window instead of one after the other.
 */
const ZOOM_SYNC_SETTLE_MS = 40;

/**
 * Sync zoom between this PDF viewer and its paired translation pane, and
 * align scroll once both viewports have layout.
 *
 * The pane under the pointer keeps the browser's own scroll. The partner
 * follows it every animation frame (see followScrollSyncFrom) while its
 * plugin metrics commit at a reduced cadence, then lands the exact content
 * point when the gesture settles. This hook publishes the zoom peer and,
 * after a zoom gesture settles, realigns the follower.
 */
export function usePdfScrollSync(docId: string): void {
	const viewportCap = useViewportCapability().provides;
	const scrollCap = useScrollCapability().provides;
	const zoomCap = useZoomCapability().provides;
	const [pairRevision, setPairRevision] = useState(0);
	const [peerRevision, setPeerRevision] = useState(0);
	const [scopeRetry, setScopeRetry] = useState(0);
	const initialSyncDoneRef = useRef<string | null>(null);

	useEffect(
		() => subscribeScrollSyncPairs(() => setPairRevision((n) => n + 1)),
		[],
	);
	useEffect(
		() => subscribeScrollSyncPeers(() => setPeerRevision((n) => n + 1)),
		[],
	);

	// Restored translation tabs skip openTranslationTab. Pair from the pane
	// marker, and keep the legacy `::translation` id working across reload.
	useEffect(() => {
		const baseId = stripEmbedPdfRevision(docId);
		const sourceId = findTranslationSourceId(getTabs(), baseId);
		if (!sourceId || sourceId === baseId) return;
		registerScrollSyncPair(sourceId, baseId);
	}, [docId]);

	// pairRevision is an external-store tick: re-read after registerScrollSyncPair.
	// biome-ignore lint/correctness/useExhaustiveDependencies: pairRevision is a refresh signal
	const partnerId = useMemo(
		() => getScrollSyncPartner(docId),
		[docId, pairRevision],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: pairRevision is a refresh signal
	const role = useMemo(() => getScrollSyncRole(docId), [docId, pairRevision]);

	// Publish this viewer's viewport / zoom into the cross-instance registry so
	// the paired pane (another EmbedPDF tree) can drive and observe us.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scopeRetry retriggers while document scopes initialize
	useEffect(() => {
		if (!viewportCap || !scrollCap || !zoomCap) return;
		const myScope = viewportCap.forDocument(docId);
		const myScrollScope = scrollCap.forDocument(docId);
		const myZoomScope = zoomCap.forDocument(docId);
		if (!myScope || !myScrollScope || !myZoomScope) {
			// Document scopes can lag capability readiness by a frame; retry so
			// the peer is not permanently missing from the registry.
			const retry = window.setTimeout(() => setScopeRetry((n) => n + 1), 50);
			return () => window.clearTimeout(retry);
		}

		return registerScrollSyncPeer(docId, {
			getMetrics: () => {
				const metrics = myScope.getMetrics();
				const element = getScrollSyncElement(docId);
				return {
					...metrics,
					// Side-by-side panes share a screen; a pane with the paper
					// path bar above its viewport must not shift the content.
					viewportTop: element?.getBoundingClientRect().top,
				};
			},
			scrollTo: ({ x, y }) => {
				// Direct element write: the plugin's scroll-request pipeline wraps
				// every programmatic scroll in another animation frame. The plugin
				// still observes the write through its own scroll listener.
				const element = getScrollSyncElement(docId);
				if (element) {
					element.scrollLeft = x;
					element.scrollTop = y;
					return;
				}
				try {
					myScope.scrollTo({ x, y, behavior: "instant" });
				} catch {
					// Ignore transient scroll failures while the viewport initializes.
				}
			},
			onScrollChange: (listener) => myScrollScope.onScroll(() => listener()),
			getZoom: () => myZoomScope.getState().currentZoomLevel,
			setZoom: (nextZoom) => {
				if (!Number.isFinite(nextZoom) || nextZoom <= 0) return;
				try {
					myZoomScope.requestZoom(nextZoom);
				} catch {
					// Ignore transient zoom failures while the target initializes.
				}
			},
			onZoomChange: (listener) =>
				myZoomScope.onZoomChange((event) => listener(event.newZoom)),
		});
	}, [docId, viewportCap, scrollCap, zoomCap, scopeRetry]);

	// Source owns the bidirectional wiring. Target only registers (above) so
	// user gestures on the translation pane still reach the source through the
	// peer's onScrollChange / onZoomChange callbacks.
	// biome-ignore lint/correctness/useExhaustiveDependencies: peerRevision retriggers when the partner peer registers
	useEffect(() => {
		if (!partnerId || role !== "source") return;
		const me = getScrollSyncPeer(docId);
		const partner = getScrollSyncPeer(partnerId);
		if (!me || !partner) return;

		let cancelled = false;
		const settleTokens = new Map<string, number>();
		const settleHolds = new Map<string, () => void>();
		/** Preview gesture a pending zoom commit is allowed to clear. */
		const zoomPreviewTokens = new Map<string, number>();
		let zoomGestureTimer: ReturnType<typeof setTimeout> | null = null;

		const releaseSettleHold = (targetDocId: string) => {
			settleHolds.get(targetDocId)?.();
			settleHolds.delete(targetDocId);
		};

		const clearZoomSync = (targetDocId: string, latest = false) => {
			endZoomSync(targetDocId);
			clearPeerZoomPreview(
				targetDocId,
				latest ? undefined : (zoomPreviewTokens.get(targetDocId) ?? 0),
			);
			zoomPreviewTokens.delete(targetDocId);
		};

		/**
		 * Realign after a zoom change. The level lands synchronously, but the
		 * target's content box only settles once the Scroller re-renders, so
		 * poll until that geometry stops changing. Scroll events on the target
		 * during this window are the zoom anchor, not a new gesture.
		 */
		const reconcileAfterZoom = (
			fromDocId: string,
			to: ScrollSyncPeer,
			targetDocId: string,
			expectedZoom: number,
			expectResize: boolean,
			previewToken = 0,
		) => {
			const token = (settleTokens.get(targetDocId) ?? 0) + 1;
			settleTokens.set(targetDocId, token);
			releaseSettleHold(targetDocId);
			settleHolds.set(targetDocId, holdScrollSync(targetDocId));
			let frames = 0;
			let lastHeight = -1;
			let lastWidth = -1;
			let stableFrames = 0;
			let sawResize = !expectResize;
			const step = () => {
				if (cancelled || settleTokens.get(targetDocId) !== token) return;
				if (previewToken > 0 && peerZoomPreviewToken() > previewToken) {
					// A newer pinch replaced this commit's preview; its own commit
					// lands the zoom, so stop touching the preview or the scroll.
					releaseSettleHold(targetDocId);
					if (settleTokens.get(targetDocId) === token) {
						settleTokens.delete(targetDocId);
					}
					if (zoomPreviewTokens.get(targetDocId) === previewToken) {
						zoomPreviewTokens.delete(targetDocId);
						endZoomSync(targetDocId);
					}
					return;
				}
				frames += 1;
				const previewSettled = settlePeerZoomPreview();
				const metrics = to.getMetrics();
				if (
					metrics.scrollHeight !== lastHeight ||
					metrics.scrollWidth !== lastWidth
				) {
					// Frame 1 always differs from the -1 sentinels; only a change
					// after that counts as the zoom relayout arriving.
					if (frames > 1) sawResize = true;
					stableFrames = 0;
				} else {
					stableFrames += 1;
				}
				lastHeight = metrics.scrollHeight;
				lastWidth = metrics.scrollWidth;
				const zoomApplied = Math.abs(to.getZoom() - expectedZoom) < 0.0001;
				if (
					(zoomApplied && previewSettled && sawResize && stableFrames >= 1) ||
					frames >= MAX_ZOOM_SETTLE_FRAMES
				) {
					releaseSettleHold(targetDocId);
					// The preview already shows the target position; hand it back
					// to real scrolling instead of recomputing a center alignment
					// that could shift the page under the reader.
					if (finishPeerZoomPreview()) {
						endScrollSyncGesture(fromDocId);
					} else {
						alignScrollSyncFrom(fromDocId, true);
					}
					clearZoomSync(targetDocId);
					return;
				}
				requestAnimationFrame(step);
			};
			requestAnimationFrame(step);
		};

		/**
		 * Coalesce a zoom step from either pane and land it on the partner once
		 * the gesture settles. The preview scales both panes during the
		 * gesture; this window only decides when the real relayout starts.
		 */
		const applyZoom = (
			fromDocId: string,
			to: ScrollSyncPeer,
			targetDocId: string,
			nextZoom: number,
		) => {
			if (cancelled) return;
			if (!Number.isFinite(nextZoom) || nextZoom <= 0) return;
			// Levels already match: this is either the echo of a zoom we
			// commanded or a genuine no-op step. The viewport mirror follows
			// the initiator's own re-anchor.
			if (Math.abs(to.getZoom() - nextZoom) < 0.0001) {
				// The preview scaled a zoom the partner already has.
				clearZoomSync(targetDocId, true);
				return;
			}
			beginZoomSync(targetDocId);
			commitPeerZoomPreview(targetDocId);
			const previewToken = peerZoomPreviewToken();
			zoomPreviewTokens.set(targetDocId, previewToken);
			if (zoomGestureTimer != null) clearTimeout(zoomGestureTimer);
			const flush = () => {
				zoomGestureTimer = null;
				if (cancelled) return;
				if (Math.abs(to.getZoom() - nextZoom) < 0.0001) {
					clearZoomSync(targetDocId);
					return;
				}
				to.setZoom(nextZoom);
				// The mirrored preview (and its hand-off) owns this pane's scroll
				// through the relayout. The plugin's queued re-anchor would land
				// under the transform and shift the page for a frame.
				cancelPendingViewportScroll(targetDocId);
				reconcileAfterZoom(
					fromDocId,
					to,
					targetDocId,
					nextZoom,
					true,
					previewToken,
				);
			};
			zoomGestureTimer = setTimeout(flush, ZOOM_SYNC_SETTLE_MS);
		};

		const unsubscribeMyZoom = me.onZoomChange((nextZoom) => {
			if (cancelled) return;
			applyZoom(docId, partner, partnerId, nextZoom);
		});
		const unsubscribePartnerZoom = partner.onZoomChange((nextZoom) => {
			if (cancelled) return;
			applyZoom(partnerId, me, docId, nextZoom);
		});

		const pairKey = `${docId}::${partnerId}`;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		const viewportsReady = () => {
			const mine = getScrollSyncElement(docId);
			const theirs = getScrollSyncElement(partnerId);
			if (!mine || !theirs) return false;
			return (
				mine.clientHeight > 0 &&
				mine.scrollHeight > 0 &&
				theirs.clientHeight > 0 &&
				theirs.scrollHeight > 0
			);
		};
		const tryInitialSync = () => {
			if (cancelled || initialSyncDoneRef.current === pairKey) return;
			if (!viewportsReady()) {
				retryTimer = setTimeout(tryInitialSync, 100);
				return;
			}
			initialSyncDoneRef.current = pairKey;
			const nextZoom = me.getZoom();
			if (Math.abs(partner.getZoom() - nextZoom) >= 0.0001) {
				partner.setZoom(nextZoom);
				reconcileAfterZoom(docId, partner, partnerId, nextZoom, true);
			} else {
				alignScrollSyncFrom(docId, true);
			}
		};
		tryInitialSync();

		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
			if (zoomGestureTimer != null) clearTimeout(zoomGestureTimer);
			for (const release of settleHolds.values()) release();
			settleHolds.clear();
			for (const targetDocId of zoomPreviewTokens.keys()) {
				endZoomSync(targetDocId);
			}
			zoomPreviewTokens.clear();
			clearPeerZoomPreview();
			unsubscribeMyZoom();
			unsubscribePartnerZoom();
		};
	}, [docId, partnerId, role, peerRevision]);
}
