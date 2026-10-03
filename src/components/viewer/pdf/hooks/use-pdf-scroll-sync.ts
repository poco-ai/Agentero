import { useScrollCapability } from "@embedpdf/plugin-scroll/react";
import { useViewportCapability } from "@embedpdf/plugin-viewport/react";
import { useZoomCapability } from "@embedpdf/plugin-zoom/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { stripEmbedPdfRevision } from "@/lib/pdf/document-id";
import {
	getScrollSyncElement,
	getScrollSyncPartner,
	getScrollSyncPeer,
	getScrollSyncRole,
	mapScrollByContent,
	mergeSyncedScrollPosition,
	registerScrollSyncPair,
	registerScrollSyncPeer,
	type ScrollSyncPeer,
	subscribeScrollSyncPairs,
	subscribeScrollSyncPeers,
} from "@/lib/pdf/scroll-sync";

const TRANSLATION_DOC_SUFFIX = "::translation";

/**
 * Scroll events within this distance of the last position we commanded onto a
 * pane are echoes of our own write, not user input. Browser scrollTop rounding
 * keeps the tolerance above the 0.5px apply threshold.
 */
const ECHO_TOLERANCE_PX = 2;

/**
 * Frames to wait for the target's zoom relayout before realigning its scroll.
 * The plugin applies the zoom level synchronously, but the viewport's content
 * metrics (scrollHeight / scrollWidth) only settle after the Scroller
 * re-renders, so a fixed one-frame delay reads stale geometry.
 */
const MAX_ZOOM_SETTLE_FRAMES = 16;

/**
 * Zoom gestures (wheel / pinch) step the level many times per second; pushing
 * every step to the partner re-rasterizes both panes on the main thread and
 * the visible alignment only lands anyway. Land the partner once, this long
 * after the last step.
 */
const ZOOM_SYNC_SETTLE_MS = 120;

export type PdfScrollPosition = {
	x: number;
	y: number;
};

/**
 * Bidirectionally sync scroll position and zoom between this PDF viewer and
 * its paired partner (e.g. the right-hand translation pane).
 *
 * Each dual-pane viewer mounts its own EmbedPDF provider, so peers publish
 * themselves into the module-level registry. Only the pair's source wires
 * listeners; the target merely registers so the source can drive it and so
 * target-originated scroll / zoom still reach the source via peer callbacks.
 *
 * Positions are mapped in content coordinates (both panes render the same
 * document at the same zoom) so differing viewport sizes — comment rail,
 * split ratio, scrollbars — do not shift the visible region. Scroll signals
 * are taken from the panes' live elements and applied as direct DOM writes:
 * the viewport plugin's scroll-request pipeline defers every programmatic
 * scroll by an extra animation frame, which put the follower 2-3 frames
 * behind and swallowed pan-drag writes. Loopback is suppressed by comparing
 * event positions against the last commanded position instead of a time
 * window, so genuine user scrolls are never swallowed.
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

	// Restored translation tabs skip openTranslationTab; re-bind the pair from
	// the conventional `::translation` document id so sync survives reload.
	// Bytes-backed panes mount as `…::translation::r<n>` — strip the buffer
	// revision before matching the suffix.
	useEffect(() => {
		const baseId = stripEmbedPdfRevision(docId);
		if (!baseId.endsWith(TRANSLATION_DOC_SUFFIX)) return;
		const sourceId = baseId.slice(0, -TRANSLATION_DOC_SUFFIX.length);
		if (!sourceId) return;
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
			getMetrics: () => myScope.getMetrics(),
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
		let scrollFrame: number | null = null;
		let pendingScroll: {
			from: ScrollSyncPeer;
			fromDocId: string;
			to: ScrollSyncPeer;
			targetDocId: string;
			changed: { x: boolean; y: boolean };
		} | null = null;
		// Last position commanded onto each pane; matching scroll events are
		// echoes of our own write rather than user input.
		const commandedScroll = new Map<string, { x: number; y: number }>();
		// Panes whose zoom relayout is still settling: their scroll events are
		// zoom side effects and must not be mirrored back to the partner.
		const settlingDocs = new Set<string>();
		const settleTokens = new Map<string, number>();
		// A zoom gesture is in flight: levels differ between the panes, so
		// content coordinates no longer correspond — hold scroll follow until
		// the gesture lands on the partner and reconcile realigns.
		let zoomGestureTimer: ReturnType<typeof setTimeout> | null = null;
		let zoomGestureActive = false;

		/** Live scroll position: the element when mounted, plugin metrics otherwise. */
		const readPosition = (paneDocId: string, pane: ScrollSyncPeer) => {
			const element = getScrollSyncElement(paneDocId);
			if (element) return { x: element.scrollLeft, y: element.scrollTop };
			const metrics = pane.getMetrics();
			return { x: metrics.scrollLeft, y: metrics.scrollTop };
		};

		// Native DOM and plugin scroll notifications can both describe one
		// gesture. Retain the last observed position per pane so we can mirror
		// only the axis that genuinely moved.
		const observedScroll = new Map<string, { x: number; y: number }>([
			[docId, readPosition(docId, me)],
			[partnerId, readPosition(partnerId, partner)],
		]);

		const isEchoScroll = (paneDocId: string, pane: ScrollSyncPeer) => {
			const last = commandedScroll.get(paneDocId);
			if (!last) return false;
			const position = readPosition(paneDocId, pane);
			return (
				Math.abs(position.x - last.x) <= ECHO_TOLERANCE_PX &&
				Math.abs(position.y - last.y) <= ECHO_TOLERANCE_PX
			);
		};

		const applyScrollNow = (
			from: ScrollSyncPeer,
			fromDocId: string,
			to: ScrollSyncPeer,
			targetDocId: string,
			changed: { x: boolean; y: boolean },
		) => {
			if (cancelled) return;
			const fromMetrics = from.getMetrics();
			const fromPosition = readPosition(fromDocId, from);
			const toMetrics = to.getMetrics();
			const mapped = mapScrollByContent(
				{
					...fromMetrics,
					scrollLeft: fromPosition.x,
					scrollTop: fromPosition.y,
				},
				toMetrics,
			);
			if (!mapped) return;
			const toElement = getScrollSyncElement(targetDocId);
			const current = {
				x: toElement ? toElement.scrollLeft : toMetrics.scrollLeft,
				y: toElement ? toElement.scrollTop : toMetrics.scrollTop,
			};
			const next = mergeSyncedScrollPosition(mapped, current, changed);
			// Skip sub-pixel no-ops so paired scroll events do not fight each other.
			if (
				Math.abs(current.x - next.x) < 0.5 &&
				Math.abs(current.y - next.y) < 0.5
			) {
				return;
			}
			commandedScroll.set(targetDocId, next);
			observedScroll.set(targetDocId, next);
			to.scrollTo(next);
		};

		const scheduleScroll = (
			from: ScrollSyncPeer,
			fromDocId: string,
			to: ScrollSyncPeer,
			targetDocId: string,
			changed: { x: boolean; y: boolean },
		) => {
			if (pendingScroll) {
				pendingScroll = {
					from,
					fromDocId,
					to,
					targetDocId,
					changed: {
						x: pendingScroll.changed.x || changed.x,
						y: pendingScroll.changed.y || changed.y,
					},
				};
			} else {
				pendingScroll = { from, fromDocId, to, targetDocId, changed };
			}
			if (scrollFrame != null) return;
			scrollFrame = requestAnimationFrame(() => {
				scrollFrame = null;
				const next = pendingScroll;
				pendingScroll = null;
				if (!next || cancelled) return;
				applyScrollNow(
					next.from,
					next.fromDocId,
					next.to,
					next.targetDocId,
					next.changed,
				);
			});
		};

		/**
		 * Realign the target's scroll after a zoom change. The zoom level lands
		 * synchronously, but the target's content metrics only settle once the
		 * Scroller re-renders, so poll until the geometry stops changing (and,
		 * when we commanded the zoom, until it has actually changed once), then
		 * map the initiator's viewport center into content coordinates. A newer
		 * reconcile supersedes an older one via the per-doc token.
		 */
		const reconcileAfterZoom = (
			from: ScrollSyncPeer,
			fromDocId: string,
			to: ScrollSyncPeer,
			targetDocId: string,
			expectedZoom: number,
			expectResize: boolean,
		) => {
			const token = (settleTokens.get(targetDocId) ?? 0) + 1;
			settleTokens.set(targetDocId, token);
			settlingDocs.add(targetDocId);
			let frames = 0;
			let lastHeight = -1;
			let lastWidth = -1;
			let stableFrames = 0;
			let sawResize = !expectResize;
			const step = () => {
				if (cancelled || settleTokens.get(targetDocId) !== token) return;
				frames += 1;
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
					(zoomApplied && sawResize && stableFrames >= 1) ||
					frames >= MAX_ZOOM_SETTLE_FRAMES
				) {
					settlingDocs.delete(targetDocId);
					applyScrollNow(from, fromDocId, to, targetDocId, {
						x: true,
						y: true,
					});
					return;
				}
				requestAnimationFrame(step);
			};
			requestAnimationFrame(step);
		};

		/**
		 * Coalesce a zoom step from either pane and land it on the partner once
		 * the gesture settles. Applying every step would re-rasterize both panes
		 * per step on the main thread for an alignment that keeps moving.
		 */
		const applyZoom = (
			from: ScrollSyncPeer,
			fromDocId: string,
			to: ScrollSyncPeer,
			targetDocId: string,
			nextZoom: number,
		) => {
			if (cancelled) return;
			if (!Number.isFinite(nextZoom) || nextZoom <= 0) return;
			// Levels already match: this is either the echo of a zoom we
			// commanded or a genuine no-op step. Either way the zoom plugin has
			// re-anchored the initiator's own scroll, and that realignment
			// reaches the partner through the normal scroll-event path.
			if (Math.abs(to.getZoom() - nextZoom) < 0.0001) return;
			zoomGestureActive = true;
			if (zoomGestureTimer != null) clearTimeout(zoomGestureTimer);
			const flush = () => {
				zoomGestureTimer = null;
				zoomGestureActive = false;
				if (cancelled) return;
				if (Math.abs(to.getZoom() - nextZoom) < 0.0001) return;
				to.setZoom(nextZoom);
				reconcileAfterZoom(from, fromDocId, to, targetDocId, nextZoom, true);
			};
			zoomGestureTimer = setTimeout(flush, ZOOM_SYNC_SETTLE_MS);
		};

		const handleScrollFrom = (
			paneDocId: string,
			pane: ScrollSyncPeer,
			other: ScrollSyncPeer,
			otherDocId: string,
		) => {
			const position = readPosition(paneDocId, pane);
			const previous = observedScroll.get(paneDocId) ?? position;
			observedScroll.set(paneDocId, position);
			const changed = {
				x: Math.abs(position.x - previous.x) >= 0.5,
				y: Math.abs(position.y - previous.y) >= 0.5,
			};
			if (
				cancelled ||
				zoomGestureActive ||
				settlingDocs.has(paneDocId) ||
				isEchoScroll(paneDocId, pane) ||
				(!changed.x && !changed.y)
			) {
				return;
			}
			scheduleScroll(pane, paneDocId, other, otherDocId, changed);
		};

		// Raw DOM scroll events are the primary signal: they fire for wheel,
		// scrollbar and pan-drag writes alike, before any plugin state update.
		const myElement = getScrollSyncElement(docId);
		const partnerElement = getScrollSyncElement(partnerId);
		const onMyNativeScroll = () =>
			handleScrollFrom(docId, me, partner, partnerId);
		const onPartnerNativeScroll = () =>
			handleScrollFrom(partnerId, partner, me, docId);
		myElement?.addEventListener("scroll", onMyNativeScroll, { passive: true });
		partnerElement?.addEventListener("scroll", onPartnerNativeScroll, {
			passive: true,
		});

		// Plugin events cover the window before the elements register (and any
		// programmatic scrolls the plugin applies on its own).
		const unsubscribeMyScroll = me.onScrollChange(() =>
			handleScrollFrom(docId, me, partner, partnerId),
		);
		const unsubscribePartnerScroll = partner.onScrollChange(() =>
			handleScrollFrom(partnerId, partner, me, docId),
		);
		const unsubscribeMyZoom = me.onZoomChange((nextZoom) => {
			if (cancelled) return;
			applyZoom(me, docId, partner, partnerId, nextZoom);
		});
		const unsubscribePartnerZoom = partner.onZoomChange((nextZoom) => {
			if (cancelled) return;
			applyZoom(partner, partnerId, me, docId, nextZoom);
		});

		const pairKey = `${docId}::${partnerId}`;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		const tryInitialSync = () => {
			if (cancelled || initialSyncDoneRef.current === pairKey) return;
			const mapped = mapScrollByContent(me.getMetrics(), partner.getMetrics());
			if (!mapped) {
				retryTimer = setTimeout(tryInitialSync, 100);
				return;
			}
			initialSyncDoneRef.current = pairKey;
			const nextZoom = me.getZoom();
			if (Math.abs(partner.getZoom() - nextZoom) >= 0.0001) {
				partner.setZoom(nextZoom);
				reconcileAfterZoom(me, docId, partner, partnerId, nextZoom, true);
			} else {
				reconcileAfterZoom(me, docId, partner, partnerId, nextZoom, false);
			}
		};
		tryInitialSync();

		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
			if (zoomGestureTimer != null) clearTimeout(zoomGestureTimer);
			if (scrollFrame != null) cancelAnimationFrame(scrollFrame);
			myElement?.removeEventListener("scroll", onMyNativeScroll);
			partnerElement?.removeEventListener("scroll", onPartnerNativeScroll);
			unsubscribeMyScroll();
			unsubscribePartnerScroll();
			unsubscribeMyZoom();
			unsubscribePartnerZoom();
		};
	}, [docId, partnerId, role, peerRevision]);
}
