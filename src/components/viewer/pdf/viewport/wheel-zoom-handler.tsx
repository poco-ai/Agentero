import {
	useViewportCapability,
	useViewportElement,
} from "@embedpdf/plugin-viewport/react";
import { useZoom } from "@embedpdf/plugin-zoom/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { EMBED_PAGE_ATTR } from "@/components/viewer/pdf/coords";
import { cancelPendingViewportScroll } from "@/lib/pdf/scroll-sync";
import { bindZoomGesture, type ZoomGesturePoint } from "@/lib/pdf/wheel-zoom";
import {
	clampZoomPreviewScale,
	zoomCommitPreviewTransform,
	zoomGestureCenteringMargin,
	zoomPreviewTranslateForViewport,
	zoomReadingWidth,
} from "@/lib/pdf/zoom";

/** Safety net for a dropped `gestureend`: commit the pending preview. */
const ZOOM_GESTURE_WATCHDOG_MS = 1200;

/** Zoom deltas below this are not worth a real relayout. */
const ZOOM_COMMIT_EPSILON = 1e-3;

/** Let the virtual scroller publish its new page dimensions before giving up. */
const ZOOM_LAYOUT_SETTLE_FRAMES = 30;

type PageAnchor = {
	pageIndex: number;
	x: number;
	y: number;
	width: number;
	height: number;
};

/**
 * Ctrl/Cmd+wheel and trackpad pinch zoom.
 *
 * EmbedPDF's ZoomGestureWrapper maps a wheel tick to a scale factor of
 * `1 - deltaY * 0.01`, which collapses the zoom to its minimum on a single
 * mouse notch. We bind the gestures ourselves and drive the zoom the way that
 * wrapper drives touch: scale the gesture element with a CSS transform while
 * the fingers move, then commit one real zoom on release.
 *
 * Committing once is not just cheaper. Every real zoom re-lays out the scroller
 * and queues a viewport scroll request for the next frame; committing one per
 * animation frame (or per coarse fixed step) supersedes that anchor and walks
 * the viewport towards the start of the document, and a fixed step of 10–20%
 * made a slow pinch feel like it was not responding at all.
 *
 * The transform follows the reader's centered layout while pages fit the
 * viewport, then hands the horizontal anchor smoothly to the gesture point as
 * the page overflows.
 */
function readingWidthOf(container: HTMLElement): number {
	const style = getComputedStyle(container);
	return zoomReadingWidth(
		container.clientWidth,
		parseFloat(style.paddingLeft) || 0,
		parseFloat(style.paddingRight) || 0,
	);
}

export function WheelZoomHandler({ docId }: { docId: string }) {
	const viewportRef = useViewportElement();
	const { provides: viewportCapability } = useViewportCapability();
	const viewportCapabilityRef = useRef(viewportCapability);
	viewportCapabilityRef.current = viewportCapability;
	const { provides: zoom, state: zoomState } = useZoom(docId);
	const zoomRef = useRef(zoom);
	zoomRef.current = zoom;
	const zoomLevelRef = useRef(1);
	zoomLevelRef.current = zoomState.currentZoomLevel || 1;
	/** EmbedPDF's ZoomGestureWrapper div: the node the preview transform scales. */
	const previewElementRef = useRef<HTMLElement | null>(null);
	/** Set while a committed zoom is waiting for its layout to land. */
	const pendingCommitRef = useRef(false);
	/** Scroll the zoom plugin derived for the commit, read in the same task. */
	const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);
	/** The PDF point under the gesture, used to join preview and real layout. */
	const pendingAnchorRef = useRef<PageAnchor | null>(null);
	const settleCommitRef = useRef<(() => void) | null>(null);

	// A zoom-state change can precede the virtual scroller's DOM resize. Let the
	// settle loop verify the rendered page dimensions before removing the preview
	// transform; clearing it immediately exposes a stale layout for one frame.
	useLayoutEffect(() => {
		if (
			!pendingCommitRef.current ||
			!Number.isFinite(zoomState.currentZoomLevel)
		)
			return;
		settleCommitRef.current?.();
	}, [zoomState.currentZoomLevel]);

	useEffect(() => {
		const container = viewportRef?.current;
		if (!container) return;
		// Its own touch gestures transform this node, so the preview scales the same
		// subtree the zoom plugin would scale.
		previewElementRef.current =
			container.firstElementChild as HTMLElement | null;

		const resetPreview = () => {
			const element = previewElementRef.current;
			if (!element) return;
			element.style.transform = "";
			element.style.willChange = "";
		};

		let previewZoom = 1;
		let previewScale = 1;
		let previewElementWidth = 0;
		let previewViewportWidth = 0;
		let pointer: ZoomGesturePoint = { x: 0, y: 0 };
		/** Gesture point in the transformed element's own coordinates. */
		let local = { x: 0, y: 0 };
		let watchdog: ReturnType<typeof setTimeout> | null = null;
		let settleFrame: number | null = null;
		let settleFrames = 0;
		let running = false;

		const clearWatchdog = () => {
			if (watchdog === null) return;
			clearTimeout(watchdog);
			watchdog = null;
		};

		const cancelSettle = () => {
			if (settleFrame === null) return;
			cancelAnimationFrame(settleFrame);
			settleFrame = null;
		};

		const completeCommit = () => {
			cancelSettle();
			pendingCommitRef.current = false;
			pendingScrollRef.current = null;
			pendingAnchorRef.current = null;
			resetPreview();
			container.dispatchEvent(new Event("pdf-zoom-settled"));
		};

		const scheduleSettle = () => {
			if (settleFrame !== null || !pendingCommitRef.current) return;
			settleFrame = requestAnimationFrame(() => {
				settleFrame = null;
				settleCommit();
			});
		};

		const settleCommit = () => {
			if (!pendingCommitRef.current) return;
			const element = previewElementRef.current;
			const scroll = pendingScrollRef.current;
			const anchor = pendingAnchorRef.current;
			if (!element || !scroll) {
				completeCommit();
				return;
			}

			// Transforms change getBoundingClientRect(). Temporarily inspect the real
			// layout, then restore the preview if the virtual page sizes are still old.
			const previewTransform = element.style.transform;
			element.style.transform = "";
			const elementRect = element.getBoundingClientRect();
			const page = anchor
				? container.querySelector<HTMLElement>(
						`[${EMBED_PAGE_ATTR}="${anchor.pageIndex}"]`,
					)
				: null;
			const pageRect = page?.getBoundingClientRect();
			const expectedWidth = anchor ? anchor.width * previewScale : 0;
			const expectedHeight = anchor ? anchor.height * previewScale : 0;
			const layoutReady =
				!anchor ||
				(Math.abs((pageRect?.width ?? Infinity) - expectedWidth) <= 2 &&
					Math.abs((pageRect?.height ?? Infinity) - expectedHeight) <= 2);

			if (!layoutReady && settleFrames < ZOOM_LAYOUT_SETTLE_FRAMES) {
				if (anchor && page && pageRect && pageRect.width > 0) {
					const offset = zoomCommitPreviewTransform(
						pageRect,
						elementRect,
						anchor,
						pointer,
						expectedWidth,
					);
					element.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${offset.scale})`;
				} else {
					element.style.transform = previewTransform;
				}
				settleFrames += 1;
				scheduleSettle();
				return;
			}

			// The gesture wrapper recenters with marginLeft after layout, in a
			// resize observer that runs after this frame's anchor correction.
			// Write the final margin first so that correction measures the
			// position the observer will keep, instead of letting a collapsing
			// margin slide the page sideways once the transform is gone.
			const readingWidth = readingWidthOf(container);
			element.style.marginLeft = `${zoomGestureCenteringMargin(
				element.offsetWidth,
				readingWidth,
			)}px`;

			if (Number.isFinite(scroll.left)) container.scrollLeft = scroll.left;
			if (Number.isFinite(scroll.top)) container.scrollTop = scroll.top;
			if (anchor && page) {
				const current = page.getBoundingClientRect();
				const anchoredX = current.left + current.width * anchor.x;
				const anchoredY = current.top + current.height * anchor.y;
				container.scrollLeft += anchoredX - pointer.x;
				container.scrollTop += anchoredY - pointer.y;
			}
			// The zoom plugin also queues a viewport scroll for the next frame.
			// Once the real page is anchored, that older request must not undo it.
			cancelPendingViewportScroll(docId);
			completeCommit();
		};
		settleCommitRef.current = settleCommit;

		const commit = () => {
			if (!running) return;
			running = false;
			clearWatchdog();
			const containerRect = container.getBoundingClientRect();
			// The focus keeps the gesture point in place once the real layout lands.
			const focus = {
				vx: pointer.x - containerRect.left,
				vy: pointer.y - containerRect.top,
			};
			const target = previewZoom * previewScale;
			if (Math.abs(target - zoomLevelRef.current) < ZOOM_COMMIT_EPSILON) {
				resetPreview();
				container.dispatchEvent(new Event("pdf-zoom-settled"));
				return;
			}
			pendingCommitRef.current = true;
			settleFrames = 0;
			zoomRef.current?.requestZoom(target, focus);
			// Read the scroll the plugin derived for this focus in the same task as
			// the request, before anything can walk the cached metrics back to the
			// DOM's (still pre-zoom) position.
			const metrics = viewportCapabilityRef.current
				?.forDocument(docId)
				.getMetrics();
			pendingScrollRef.current = metrics
				? { left: metrics.scrollLeft, top: metrics.scrollTop }
				: null;
			scheduleSettle();
		};

		const armWatchdog = () => {
			clearWatchdog();
			watchdog = setTimeout(commit, ZOOM_GESTURE_WATCHDOG_MS);
		};

		const binding = bindZoomGesture({
			target: container,
			onZoomStart: (point) => {
				if (running) commit();
				clearWatchdog();
				cancelSettle();
				// Measure the element without a stale preview transform; a commit whose
				// layout effect has not run yet finishes through the plugin's own
				// deferred scroll instead.
				pendingCommitRef.current = false;
				pendingScrollRef.current = null;
				pendingAnchorRef.current = null;
				resetPreview();
				container.dispatchEvent(new Event("pdf-zoom-start"));
				const containerRect = container.getBoundingClientRect();
				// WebKit's GestureEvent does not always carry coordinates.
				pointer = {
					x: Number.isFinite(point.x)
						? point.x
						: containerRect.left + containerRect.width / 2,
					y: Number.isFinite(point.y)
						? point.y
						: containerRect.top + containerRect.height / 2,
				};
				const page = document
					.elementFromPoint(pointer.x, pointer.y)
					?.closest<HTMLElement>(`[${EMBED_PAGE_ATTR}]`);
				const pageRect = page?.getBoundingClientRect();
				pendingAnchorRef.current =
					page && pageRect && pageRect.width > 0 && pageRect.height > 0
						? {
								pageIndex: Number(page.getAttribute(EMBED_PAGE_ATTR)),
								x: (pointer.x - pageRect.left) / pageRect.width,
								y: (pointer.y - pageRect.top) / pageRect.height,
								width: pageRect.width,
								height: pageRect.height,
							}
						: null;
				previewZoom = zoomLevelRef.current || 1;
				previewScale = 1;
				previewElementWidth = previewElementRef.current?.offsetWidth ?? 0;
				previewViewportWidth = readingWidthOf(container);
				running = true;
				const element = previewElementRef.current;
				if (element) {
					const elementRect = element.getBoundingClientRect();
					local = {
						x: pointer.x - elementRect.left,
						y: pointer.y - elementRect.top,
					};
					element.style.transformOrigin = "0 0";
					// Rasterize the pages once and let the compositor scale that raster
					// for the rest of the gesture. Without it the compositor re-rasterizes
					// on every scale change, which shows up as jank when a pinch turns
					// around (zoom in, then straight back out). Cleared with the transform
					// so it can never outlive the gesture.
					element.style.willChange = "transform";
				}
				armWatchdog();
			},
			onZoomChange: (ratio) => {
				if (!running) return;
				previewScale = clampZoomPreviewScale(ratio, previewZoom);
				armWatchdog();
				const element = previewElementRef.current;
				if (!element) return;
				const offset = zoomPreviewTranslateForViewport(
					local.x,
					local.y,
					previewScale,
					previewElementWidth,
					previewViewportWidth,
				);
				element.style.transform = `translate(${offset.x}px, ${offset.y}px) scale(${previewScale})`;
			},
			onZoomEnd: commit,
		});

		return () => {
			binding.dispose();
			clearWatchdog();
			cancelSettle();
			settleCommitRef.current = null;
			pendingCommitRef.current = false;
			pendingScrollRef.current = null;
			pendingAnchorRef.current = null;
			resetPreview();
		};
	}, [docId, viewportRef]);

	return null;
}
