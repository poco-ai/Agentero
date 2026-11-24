/**
 * Mirror a zoom gesture's CSS-transform preview onto the paired pane.
 *
 * The pane under the fingers previews the pinch with a transform and only asks
 * the zoom plugin for the real zoom when the gesture ends. Without a matching
 * preview the partner stays frozen for the whole gesture, then jumps into a
 * full relayout. Both panes show the same content at the same zoom with their
 * viewport centers aligned, so the gesture point maps by center (see
 * mapZoomPointToPeer) and the partner can scale its current raster on the
 * compositor instead of re-rasterizing.
 *
 * The real zoom re-lays out the page DOM under that transform, which would
 * double-scale the raster for the duration of the relayout. The commit
 * therefore hands the preview to a per-frame compensation (settlePeerZoom-
 * Preview) that keeps the page point under the gesture until the page reaches
 * the committed size; the zoom reconcile then aligns the scroll and drops the
 * transform in the same frame.
 *
 * One gesture at a time owns the preview. A commit only clears the preview it
 * started (see `token`), so quickly repeated pinches cannot lose the newer
 * preview to the older commit's cleanup.
 */

import { stripEmbedPdfRevision } from "@/lib/pdf/document-id";
import { EMBED_PAGE_ATTR } from "@/lib/pdf/page-dom";
import {
	getScrollSyncElement,
	getScrollSyncPartner,
	setScrollSyncFollowerScroll,
} from "@/lib/pdf/scroll-sync";
import type { ZoomGesturePoint } from "@/lib/pdf/wheel-zoom";
import {
	mapZoomPointToPeer,
	zoomCommitPreviewTransform,
	zoomPreviewTranslateForViewport,
	zoomReadingWidth,
} from "@/lib/pdf/zoom";

export type PeerZoomAnchor = {
	pageIndex: number;
	/** Gesture point in page fractions. */
	x: number;
	y: number;
};

type PeerZoomPreview = {
	/** Partner doc whose element is transformed; revision-stripped. */
	docId: string;
	/** Monotonic gesture id; a commit only clears the preview it started. */
	token: number;
	element: HTMLElement;
	/** Scroll container the element lives in (the viewport). */
	viewport: HTMLElement;
	/** Partner page the gesture is anchored to, when one could be measured. */
	page: HTMLElement | null;
	anchor: PeerZoomAnchor | null;
	/** Partner page size at gesture start. */
	pageWidth: number;
	/** Gesture wrapper box before any preview transform, in client space. */
	elementRect: { left: number; top: number };
	elementWidth: number;
	readingWidth: number;
	sourceViewport: DOMRect;
	partnerViewport: DOMRect;
	/** Latest preview magnification relative to the gesture-start zoom. */
	scale: number;
	/** Page point's client position under the preview, captured at commit. */
	commitTarget: { x: number; y: number } | null;
	committedScale: number;
	/** Compensates the preview as the page DOM relayouts, before the paint. */
	resizeObserver: ResizeObserver | null;
};

let preview: PeerZoomPreview | null = null;
let previewSequence = 0;

function readingWidthOf(container: HTMLElement): number {
	const style = getComputedStyle(container);
	return zoomReadingWidth(
		container.clientWidth,
		parseFloat(style.paddingLeft) || 0,
		parseFloat(style.paddingRight) || 0,
	);
}

function clearTransform(element: HTMLElement): void {
	element.style.transform = "";
	element.style.transformOrigin = "";
	element.style.willChange = "";
}

/**
 * Start mirroring the gesture that begins on `sourceDocId`. Captures the
 * partner's geometry once: a transform would otherwise feed back into the
 * measured box on every gesture change. Without an anchor page the preview
 * could not be compensated across the real relayout, so this stays off for
 * gestures that start between pages.
 */
export function beginPeerZoomPreview(
	sourceDocId: string,
	anchor: PeerZoomAnchor | null,
): void {
	clearPeerZoomPreview();
	if (!anchor) return;
	const partnerId = getScrollSyncPartner(sourceDocId);
	const sourceViewport = getScrollSyncElement(sourceDocId);
	const partnerViewport = partnerId ? getScrollSyncElement(partnerId) : null;
	const element = partnerViewport?.firstElementChild as HTMLElement | null;
	const page =
		partnerViewport?.querySelector<HTMLElement>(
			`[${EMBED_PAGE_ATTR}="${anchor.pageIndex}"]`,
		) ?? null;
	if (!partnerId || !sourceViewport || !partnerViewport || !element || !page) {
		return;
	}
	// A transform left by the previous gesture would skew the measurements.
	clearTransform(element);
	const elementRect = element.getBoundingClientRect();
	const pageRect = page.getBoundingClientRect();
	if (!(elementRect.width > 0) || !(pageRect.width > 0)) return;
	previewSequence += 1;
	preview = {
		docId: partnerId,
		token: previewSequence,
		element,
		viewport: partnerViewport,
		page,
		anchor,
		pageWidth: pageRect.width,
		elementRect: { left: elementRect.left, top: elementRect.top },
		elementWidth: element.offsetWidth,
		readingWidth: readingWidthOf(partnerViewport),
		sourceViewport: sourceViewport.getBoundingClientRect(),
		partnerViewport: partnerViewport.getBoundingClientRect(),
		scale: 1,
		commitTarget: null,
		committedScale: 1,
		resizeObserver: null,
	};
}

/** Scale the partner's current raster around the mapped gesture point. */
export function updatePeerZoomPreview(
	sourceDocId: string,
	scale: number,
	point: ZoomGesturePoint,
): void {
	if (!preview || !Number.isFinite(scale) || scale <= 0) return;
	const sourceViewport = getScrollSyncElement(sourceDocId);
	if (!sourceViewport) return;
	preview.scale = scale;
	const mapped = mapZoomPointToPeer(
		preview.sourceViewport,
		preview.partnerViewport,
		point,
	);
	const operation = zoomPreviewTranslateForViewport(
		mapped.x - preview.elementRect.left,
		mapped.y - preview.elementRect.top,
		scale,
		preview.elementWidth,
		preview.readingWidth,
	);
	preview.element.style.transformOrigin = "0 0";
	preview.element.style.willChange = "transform";
	preview.element.style.transform = `translate(${operation.x}px, ${operation.y}px) scale(${scale})`;
}

/**
 * Capture what the preview currently shows right before the real zoom lands:
 * the anchored page point's on-screen position and the target magnification.
 * Measuring the transformed page keeps the hand-off to the settle exact.
 */
export function commitPeerZoomPreview(docId?: string): void {
	if (!preview) return;
	if (docId && stripEmbedPdfRevision(docId) !== preview.docId) return;
	const { page, anchor } = preview;
	if (!page || !anchor) {
		clearPeerZoomPreview();
		return;
	}
	const rect = page.getBoundingClientRect();
	if (!(rect.width > 0) || !(rect.height > 0)) {
		clearPeerZoomPreview();
		return;
	}
	preview.commitTarget = {
		x: rect.left + rect.width * anchor.x,
		y: rect.top + rect.height * anchor.y,
	};
	preview.committedScale = preview.scale;
	// The scroller can relayout in a commit the zoom state's own layout effect
	// does not see; observing the page box keeps the compensation ahead of the
	// paint instead of showing one frame at the wrong scale.
	if (preview.resizeObserver == null && typeof ResizeObserver !== "undefined") {
		const observer = new ResizeObserver(() => {
			settlePeerZoomPreview();
		});
		observer.observe(page);
		observer.observe(preview.element);
		preview.resizeObserver = observer;
	}
}

/**
 * Compensate the preview while the partner's page DOM relayouts at the new
 * zoom. Returns true once the pages reached the committed size, at which point
 * the reconcile can align the scroll and clear the transform in one frame.
 */
export function settlePeerZoomPreview(): boolean {
	if (!preview) return true;
	const { page, anchor, commitTarget, element } = preview;
	if (!element.isConnected) {
		clearPeerZoomPreview();
		return true;
	}
	if (!anchor || !commitTarget) {
		// Not committed yet: the gesture still owns the preview, and only a
		// commit may hand it to the settle compensation.
		return true;
	}
	if (!page?.isConnected) {
		// Virtualization can unmount the anchored page for a frame while the
		// scroller relayouts. Keep waiting instead of snapping to a half layout.
		return false;
	}
	const saved = element.style.transform;
	// Transforms change getBoundingClientRect(); inspect the real layout, then
	// restore the preview if the page sizes have not caught up yet.
	element.style.transform = "";
	const elementRect = element.getBoundingClientRect();
	const pageRect = page.getBoundingClientRect();
	if (!(elementRect.width > 0) || !(pageRect.width > 0)) {
		// Mid-relayout the boxes can collapse for a frame; wait it out rather
		// than dropping the preview onto a layout that is still moving.
		element.style.transform = saved;
		return false;
	}
	const targetWidth = preview.pageWidth * preview.committedScale;
	const scale = targetWidth / pageRect.width;
	if (Math.abs(scale - 1) <= 1e-3) {
		element.style.transform = saved;
		return true;
	}
	const operation = zoomCommitPreviewTransform(
		pageRect,
		elementRect,
		anchor,
		commitTarget,
		targetWidth,
	);
	element.style.transformOrigin = "0 0";
	element.style.willChange = "transform";
	element.style.transform = `translate(${operation.x}px, ${operation.y}px) scale(${operation.scale})`;
	return false;
}

/**
 * Hand the settled preview back to real scrolling. The page point is placed at
 * the same client position the preview showed before the transform is dropped,
 * so the swap is a no-op for the eye. Returns false when there was no anchored
 * preview and the caller should fall back to content-center alignment.
 */
export function finishPeerZoomPreview(): boolean {
	const current = preview;
	if (!current) return false;
	const { docId, element, viewport, page, anchor, commitTarget } = current;
	if (!page?.isConnected || !anchor || !commitTarget) {
		clearPeerZoomPreview();
		return false;
	}
	// Measure the real layout, then move the scroll by the same delta the
	// transform was applying. Both writes happen in this task, so the browser
	// paints the hand-off as one frame.
	element.style.transform = "";
	const pageRect = page.getBoundingClientRect();
	if (!(pageRect.width > 0)) {
		clearPeerZoomPreview();
		return false;
	}
	setScrollSyncFollowerScroll(docId, {
		x:
			viewport.scrollLeft +
			pageRect.left +
			pageRect.width * anchor.x -
			commitTarget.x,
		y:
			viewport.scrollTop +
			pageRect.top +
			pageRect.height * anchor.y -
			commitTarget.y,
	});
	clearPeerZoomPreview();
	return true;
}

/**
 * Gesture token of the active preview, captured when a commit starts so the
 * cleanup that lands later cannot clear a preview a newer gesture has begun.
 */
export function peerZoomPreviewToken(): number {
	return preview?.token ?? 0;
}

/**
 * Drop the partner preview, or only the one owned by `docId` and no newer than
 * `token`.
 */
export function clearPeerZoomPreview(docId?: string, token?: number): void {
	if (!preview) return;
	if (docId && stripEmbedPdfRevision(docId) !== preview.docId) return;
	if (token !== undefined && preview.token > token) return;
	preview.resizeObserver?.disconnect();
	clearTransform(preview.element);
	preview = null;
}
