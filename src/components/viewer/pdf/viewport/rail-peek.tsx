import { useViewportElement } from "@embedpdf/plugin-viewport/react";
import { type RefObject, useEffect, useRef } from "react";
import { EMBED_PAGE_ATTR, pageElByIndex } from "@/components/viewer/pdf/coords";
import { railPeekKeepsOpen, railPeekScrollDelta } from "@/lib/pdf/rail-peek";

/** Strip along the viewport's right edge that arms the peek. */
const PEEK_EDGE_PX = 28;
/** Vertical slack around the card stack, so moving between cards stays in. */
const PEEK_CARD_HALO_PX = 12;
/** Rest on the edge strip before panning. */
const PEEK_DWELL_MS = 400;
/** Outlast the highlight's 500ms leave grace before committing to a pan. */
const PEEK_HIGHLIGHT_DWELL_MS = 550;
/** Grace after leaving the revealed column or moving away from a highlight. */
const PEEK_LEAVE_MS = 80;
/** Small pointer jitter after the page moves should not dismiss the peek. */
const PEEK_HOVER_SLOP_PX = 8;
/** Time to cross from a highlighted passage to its revealed card. */
const PEEK_CARD_TRAVEL_MS = 500;
/** Clearance kept between the revealed rail and the viewport edge. */
const PEEK_MARGIN_PX = 8;
/**
 * Cap for the reveal pan. A page wider than this has its right edge well
 * outside the viewport, so a hover must not drag the view across the page.
 */
const PEEK_MAX_PAN_PX = 240;

type RailPeekProps = {
	/** PDF host, used to measure the page beside the pointer. */
	hostRef: RefObject<HTMLDivElement | null>;
	/** Outer width of the page-outside comment card column. */
	railWidth: number;
	/** True when the 1-based page carries comment cards worth revealing. */
	hasCommentsOnPage: (pageNumber: number) => boolean;
	/** Comment whose highlight is hovered; reveals the rail that holds its card. */
	hoveredCommentId?: string | null;
	/** 1-based page whose card editor is open; reveals without any hover. */
	revealPage?: number | null;
	/** Keep the rail revealed while a card editor owns focus. */
	holdOpen?: boolean;
};

type RailPeekApi = {
	/** Pan towards the card column at the last pointer position. */
	peek: () => void;
	/** Pan towards the card column for one page, whatever the pointer does. */
	revealPage: (pageNumber: number) => void;
	/** Retract after the leave grace unless the pointer is on the rail. */
	release: () => void;
};

/**
 * Reveal the comment rail by panning the viewport.
 *
 * Comment cards live outside the page's right edge and the reader reserves no
 * space for them, so at fit-width the card column sits just beyond the
 * viewport. Resting on the right edge, or hovering a commented highlight,
 * scrolls the viewport horizontally just far enough to show the column;
 * leaving it scrolls back. Nothing about page width, zoom or fit-width changes,
 * so zooming never drags the page sideways.
 *
 * Must render inside `DockviewViewport` (ViewportElementContext).
 */
export function RailPeek({
	hostRef,
	railWidth,
	hasCommentsOnPage,
	hoveredCommentId = null,
	revealPage = null,
	holdOpen = false,
}: RailPeekProps) {
	const viewportRef = useViewportElement();
	const hasCommentsRef = useRef(hasCommentsOnPage);
	hasCommentsRef.current = hasCommentsOnPage;
	const holdOpenRef = useRef(holdOpen);
	holdOpenRef.current = holdOpen;
	const hoveredCommentRef = useRef(hoveredCommentId);
	hoveredCommentRef.current = hoveredCommentId;
	const apiRef = useRef<RailPeekApi | null>(null);

	useEffect(() => {
		const viewport = viewportRef?.current;
		if (!viewport) return;

		let revealed = false;
		let savedScrollLeft = 0;
		let targetScrollLeft = 0;
		let dwell: ReturnType<typeof setTimeout> | null = null;
		let hoverDwell: ReturnType<typeof setTimeout> | null = null;
		let leave: ReturnType<typeof setTimeout> | null = null;
		let hoverAnchor: { x: number; y: number } | null = null;
		let lastPointer: { x: number; y: number } | null = null;
		let pressed = false;
		let zoomSuspended = false;
		let zoomActive = false;

		const clearDwell = () => {
			if (dwell === null) return;
			clearTimeout(dwell);
			dwell = null;
		};
		const clearHoverDwell = () => {
			if (hoverDwell === null) return;
			clearTimeout(hoverDwell);
			hoverDwell = null;
		};
		const clearLeave = () => {
			if (leave === null) return;
			clearTimeout(leave);
			leave = null;
		};

		/** Vertical span of the comment cards currently on screen. */
		const cardSpan = () => {
			const host = hostRef.current;
			if (!host) return null;
			const view = viewport.getBoundingClientRect();
			let top = Number.POSITIVE_INFINITY;
			let bottom = Number.NEGATIVE_INFINITY;
			for (const element of host.querySelectorAll<HTMLElement>(
				"[data-comment-card]",
			)) {
				const box = element.getBoundingClientRect();
				if (box.width <= 0 || box.height <= 0) continue;
				if (box.bottom < view.top || box.top > view.bottom) continue;
				top = Math.min(top, box.top);
				bottom = Math.max(bottom, box.bottom);
			}
			return Number.isFinite(top) ? { top, bottom } : null;
		};

		const keepsOpen = (clientX: number, clientY: number) => {
			const rect = viewport.getBoundingClientRect();
			return railPeekKeepsOpen({
				x: clientX,
				y: clientY,
				viewport: {
					left: rect.left,
					right: rect.right,
					top: rect.top,
					bottom: rect.bottom,
				},
				revealed,
				edge: PEEK_EDGE_PX,
				railColumn: railWidth,
				cards: revealed ? cardSpan() : null,
				halo: PEEK_CARD_HALO_PX,
			});
		};

		/** Rendered page under the pointer; pages stack vertically. */
		const pageAt = (clientY: number) => {
			const host = hostRef.current;
			if (!host) return null;
			for (const element of host.querySelectorAll<HTMLElement>(
				`[${EMBED_PAGE_ATTR}]`,
			)) {
				const rect = element.getBoundingClientRect();
				if (rect.height <= 0) continue;
				if (clientY < rect.top || clientY > rect.bottom) continue;
				const pageIndex = Number(element.getAttribute(EMBED_PAGE_ATTR));
				return { pageNumber: pageIndex + 1, rect };
			}
			return null;
		};

		const restore = () => {
			clearDwell();
			clearHoverDwell();
			clearLeave();
			if (!revealed) return;
			if (holdOpenRef.current) return;
			revealed = false;
			hoverAnchor = null;
			// A quick leave can interrupt the reveal animation before it reaches
			// the target. Only a scroll outside that path belongs to the reader.
			if (
				viewport.scrollLeft < savedScrollLeft - 2 ||
				viewport.scrollLeft > targetScrollLeft + 2
			)
				return;
			viewport.scrollTo({ left: savedScrollLeft, behavior: "smooth" });
		};

		const revealAt = (clientY: number, soft = false) => {
			clearDwell();
			if (revealed || pressed) return;
			const page = pageAt(clientY);
			if (!page) return;
			revealPageRect(page.pageNumber, page.rect, soft);
		};

		const revealPageRect = (
			pageNumber: number,
			rect: { right: number },
			soft: boolean,
		) => {
			if (revealed || pressed) return;
			if (!hasCommentsRef.current(pageNumber)) return;
			const delta = railPeekScrollDelta({
				pageRight: rect.right,
				viewportRight: viewport.getBoundingClientRect().right,
				railWidth,
				margin: PEEK_MARGIN_PX,
				maxPan: PEEK_MAX_PAN_PX,
			});
			if (delta === null) return;
			const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
			const from = viewport.scrollLeft;
			const to = Math.min(maxScrollLeft, from + delta);
			if (to - from < 2) return;
			savedScrollLeft = from;
			targetScrollLeft = to;
			revealed = true;
			hoverAnchor = soft ? lastPointer : null;
			clearHoverDwell();
			clearLeave();
			viewport.scrollTo({ left: to, behavior: "smooth" });
		};

		/**
		 * A commented highlight (or its card) is hovered. Dwell before the first
		 * pan; switching comments restarts the dwell rather than panning at once.
		 */
		const peek = () => {
			if (pressed || zoomSuspended || !lastPointer) return;
			clearLeave();
			clearHoverDwell();
			if (revealed) return;
			hoverDwell = setTimeout(() => {
				hoverDwell = null;
				if (lastPointer) revealAt(lastPointer.y, true);
			}, PEEK_HIGHLIGHT_DWELL_MS);
		};

		/** Editor opened from the toolbar / annotations panel. */
		const revealForPage = (pageNumber: number) => {
			const element = pageElByIndex(hostRef.current, pageNumber - 1);
			if (!element) return;
			revealPageRect(pageNumber, element.getBoundingClientRect(), false);
		};

		const armDwell = (clientY: number) => {
			if (dwell !== null || pressed || zoomSuspended) return;
			dwell = setTimeout(() => {
				dwell = null;
				revealAt(clientY);
			}, PEEK_DWELL_MS);
		};
		const armLeave = (delay: number) => {
			if (leave !== null) return;
			leave = setTimeout(restore, delay);
		};

		const release = () => {
			clearDwell();
			clearHoverDwell();
			if (!revealed || holdOpenRef.current || hoverAnchor) return;
			// The pointer may be on its way to a card: the band keeps it open.
			if (lastPointer && keepsOpen(lastPointer.x, lastPointer.y)) return;
			// Start the retract once; continued movement does not postpone it.
			armLeave(PEEK_LEAVE_MS);
		};

		apiRef.current = {
			peek,
			revealPage: revealForPage,
			release,
		};

		const handlePointerMove = (event: PointerEvent) => {
			lastPointer = { x: event.clientX, y: event.clientY };
			if (event.pointerType === "touch" || pressed) return;
			if (zoomSuspended) {
				if (
					zoomActive ||
					hoveredCommentRef.current ||
					keepsOpen(event.clientX, event.clientY)
				)
					return;
				zoomSuspended = false;
				return;
			}
			if (holdOpenRef.current) {
				clearLeave();
				return;
			}
			if (revealed) {
				if (keepsOpen(event.clientX, event.clientY)) {
					hoverAnchor = null;
					clearLeave();
				} else if (hoverAnchor) {
					const dx = event.clientX - hoverAnchor.x;
					const dy = event.clientY - hoverAnchor.y;
					if (Math.hypot(dx, dy) <= PEEK_HOVER_SLOP_PX) return;
					hoverAnchor = null;
					// Moving right is the path to the card; give that trip time.
					// Other directions are leaving the comment interaction.
					armLeave(dx > Math.abs(dy) ? PEEK_CARD_TRAVEL_MS : PEEK_LEAVE_MS);
				} else if (leave === null) {
					release();
				}
				return;
			}
			if (keepsOpen(event.clientX, event.clientY)) armDwell(event.clientY);
			else clearDwell();
		};

		const handlePointerLeave = () => {
			lastPointer = null;
			zoomSuspended = false;
			// Leaving the reading area entirely: retract without the card grace,
			// there is no card to travel to.
			clearDwell();
			clearHoverDwell();
			restore();
		};

		// A wheel or a press is reading intent elsewhere; retract rather than
		// fight the gesture. Wheel over a card keeps the rail (editor in use).
		const suspendForZoom = () => {
			zoomSuspended = true;
			clearDwell();
			clearHoverDwell();
			clearLeave();
			// The zoom gesture owns the current viewport offset. Do not restore or
			// start another rail pan while its layout changes under the pointer.
			revealed = false;
			hoverAnchor = null;
		};
		const handleWheel = (event: WheelEvent) => {
			if (event.ctrlKey || event.metaKey) {
				suspendForZoom();
				return;
			}
			clearDwell();
			clearHoverDwell();
			if (!revealed) return;
			const target = event.target;
			if (target instanceof Element && target.closest("[data-pdf-chrome]")) {
				return;
			}
			restore();
		};
		const handleGesture = () => suspendForZoom();
		const handleZoomStart = () => {
			zoomActive = true;
			suspendForZoom();
		};
		const handleZoomSettled = () => {
			zoomActive = false;
		};

		const handlePointerDown = (event: PointerEvent) => {
			pressed = true;
			clearDwell();
			clearHoverDwell();
			if (!revealed) return;
			const target = event.target;
			if (target instanceof Element && target.closest("[data-pdf-chrome]")) {
				return;
			}
			restore();
		};

		const handlePointerUp = () => {
			pressed = false;
		};

		viewport.addEventListener("pointermove", handlePointerMove, {
			passive: true,
		});
		viewport.addEventListener("pointerleave", handlePointerLeave);
		viewport.addEventListener("wheel", handleWheel, {
			capture: true,
			passive: true,
		});
		viewport.addEventListener("gesturestart", handleGesture, true);
		viewport.addEventListener("gesturechange", handleGesture, true);
		viewport.addEventListener("gestureend", handleGesture, true);
		viewport.addEventListener("pdf-zoom-start", handleZoomStart);
		viewport.addEventListener("pdf-zoom-settled", handleZoomSettled);
		viewport.addEventListener("pointerdown", handlePointerDown, true);
		window.addEventListener("pointerup", handlePointerUp, true);
		window.addEventListener("pointercancel", handlePointerUp, true);

		return () => {
			clearDwell();
			clearHoverDwell();
			clearLeave();
			apiRef.current = null;
			viewport.removeEventListener("pointermove", handlePointerMove);
			viewport.removeEventListener("pointerleave", handlePointerLeave);
			viewport.removeEventListener("wheel", handleWheel, true);
			viewport.removeEventListener("gesturestart", handleGesture, true);
			viewport.removeEventListener("gesturechange", handleGesture, true);
			viewport.removeEventListener("gestureend", handleGesture, true);
			viewport.removeEventListener("pdf-zoom-start", handleZoomStart);
			viewport.removeEventListener("pdf-zoom-settled", handleZoomSettled);
			viewport.removeEventListener("pointerdown", handlePointerDown, true);
			window.removeEventListener("pointerup", handlePointerUp, true);
			window.removeEventListener("pointercancel", handlePointerUp, true);
		};
	}, [hostRef, railWidth, viewportRef]);

	// Hovering a commented highlight (or its card) reveals the column that
	// holds the note; letting go retracts after the leave grace.
	useEffect(() => {
		if (hoveredCommentId) apiRef.current?.peek();
		else apiRef.current?.release();
	}, [hoveredCommentId]);

	// A card editor opened from the toolbar or the annotations panel needs the
	// column on screen even though nothing was hovered.
	useEffect(() => {
		if (revealPage != null) apiRef.current?.revealPage(revealPage);
	}, [revealPage]);

	// Keep the revealed column in place while a card editor owns focus.
	useEffect(() => {
		if (!holdOpen) apiRef.current?.release();
	}, [holdOpen]);

	return null;
}
