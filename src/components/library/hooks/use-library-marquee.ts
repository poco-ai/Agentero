/**
 * Rectangle (marquee) selection for the papers library table.
 *
 * Rows are virtualized: only visible rows exist in the DOM, and the box is
 * clamped to the viewport, so hit-testing the rendered rows is exact. The
 * overlay lives inside the scroll container and is positioned in content
 * coordinates, so it tracks the rows while the list auto-scrolls near an edge.
 */
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	keysIntersectingBand,
	type RowBand,
} from "@/components/library/library-selection";

/** Px the pointer must travel before a press becomes a marquee drag. */
const DRAG_THRESHOLD_PX = 4;
/** Distance from the scroller edge that starts auto-scrolling. */
const AUTO_SCROLL_EDGE_PX = 28;
/** Max px per animation frame while auto-scrolling. */
const AUTO_SCROLL_MAX_STEP_PX = 14;
/**
 * Elements that keep the pointer: text fields, links and the column-resize
 * handles. Row cells are mostly copy buttons — a drag has to start there, so
 * buttons are deliberately not excluded (a press without movement still
 * clicks them).
 */
const INTERACTIVE_SELECTOR = [
	"input",
	"textarea",
	"select",
	"[contenteditable='true']",
	"a",
	"[data-library-resize]",
].join(",");

type Session = {
	pointerId: number;
	startX: number;
	startY: number;
	lastX: number;
	lastY: number;
	/** ⌘/Ctrl at press time → union with the previous selection. */
	additive: boolean;
	started: boolean;
	frame: number | null;
};

export type LibraryMarquee = {
	/** Attach to the scroll container. */
	onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
	/** Attach to the selection rectangle element inside the scroll container. */
	overlayRef: RefObject<HTMLDivElement | null>;
	/** True while a marquee drag is drawing (suppresses hover preview). */
	dragging: boolean;
	/** Same, readable from callbacks that must not re-subscribe. */
	isDragging: () => boolean;
	/** True for the click that ends a drag — the row must not open. */
	didJustDrag: () => boolean;
};

export function useLibraryMarquee({
	scrollRef,
	keyForIndex,
	onSelect,
	onDragStart,
	onCancel,
	enabled = true,
}: {
	scrollRef: RefObject<HTMLDivElement | null>;
	keyForIndex: (index: number) => string;
	onSelect: (keys: string[], additive: boolean) => void;
	onDragStart?: () => void;
	onCancel?: () => void;
	enabled?: boolean;
}): LibraryMarquee {
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const sessionRef = useRef<Session | null>(null);
	const cleanupRef = useRef<(() => void) | null>(null);
	const draggedRef = useRef(false);
	const lastSignatureRef = useRef("");
	const draggingRef = useRef(false);
	const [dragging, setDragging] = useState(false);

	// Latest-value refs keep the window listeners bound once per drag while the
	// table keeps re-rendering on every selection frame.
	const enabledRef = useRef(enabled);
	enabledRef.current = enabled;
	const keyForIndexRef = useRef(keyForIndex);
	keyForIndexRef.current = keyForIndex;
	const onSelectRef = useRef(onSelect);
	onSelectRef.current = onSelect;
	const onDragStartRef = useRef(onDragStart);
	onDragStartRef.current = onDragStart;
	const onCancelRef = useRef(onCancel);
	onCancelRef.current = onCancel;

	useEffect(
		() => () => {
			cleanupRef.current?.();
			cleanupRef.current = null;
		},
		[],
	);

	const onPointerDown = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (!enabledRef.current || event.button !== 0) return;
			const scroller = scrollRef.current;
			if (!scroller) return;
			const target = event.target as HTMLElement | null;
			if (!target?.closest("table") || target.closest("thead")) return;
			if (target.closest(INTERACTIVE_SELECTOR)) return;

			// A fresh press starts a fresh gesture: a previous drag must not keep
			// swallowing this click.
			draggedRef.current = false;

			const session: Session = {
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				lastX: event.clientX,
				lastY: event.clientY,
				additive: event.metaKey || event.ctrlKey,
				started: false,
				frame: null,
			};
			sessionRef.current = session;
			lastSignatureRef.current = "";

			const rowBands = (): RowBand[] => {
				const bands: RowBand[] = [];
				for (const row of scroller.querySelectorAll<HTMLElement>(
					"tr[data-index]",
				)) {
					const index = Number(row.dataset.index);
					if (!Number.isFinite(index)) continue;
					const key = keyForIndexRef.current(index);
					if (!key) continue;
					const rect = row.getBoundingClientRect();
					bands.push({ key, top: rect.top, bottom: rect.bottom });
				}
				return bands;
			};

			const paint = () => {
				const box = scroller.getBoundingClientRect();
				const left = Math.min(session.startX, session.lastX);
				const right = Math.max(session.startX, session.lastX);
				const top = Math.min(session.startY, session.lastY);
				const bottom = Math.max(session.startY, session.lastY);
				const overlay = overlayRef.current;
				if (overlay) {
					overlay.style.display = "block";
					overlay.style.left = `${left - box.left + scroller.scrollLeft}px`;
					overlay.style.top = `${top - box.top + scroller.scrollTop}px`;
					overlay.style.width = `${right - left}px`;
					overlay.style.height = `${bottom - top}px`;
				}
				const keys = keysIntersectingBand(rowBands(), { top, bottom });
				const signature = keys.join("\n");
				if (signature === lastSignatureRef.current) return;
				lastSignatureRef.current = signature;
				onSelectRef.current(keys, session.additive);
			};

			const step = () => {
				session.frame = null;
				if (sessionRef.current !== session || !session.started) return;
				const box = scroller.getBoundingClientRect();
				const edge = AUTO_SCROLL_EDGE_PX;
				let delta = 0;
				if (session.lastY < box.top + edge) {
					delta = -Math.ceil(
						((box.top + edge - session.lastY) / edge) * AUTO_SCROLL_MAX_STEP_PX,
					);
				} else if (session.lastY > box.bottom - edge) {
					delta = Math.ceil(
						((session.lastY - (box.bottom - edge)) / edge) *
							AUTO_SCROLL_MAX_STEP_PX,
					);
				}
				if (delta !== 0) {
					const before = scroller.scrollTop;
					scroller.scrollTop = before + delta;
					// Already at an end: keep the frame loop cheap.
					if (scroller.scrollTop === before) delta = 0;
				}
				paint();
				session.frame = requestAnimationFrame(step);
			};

			const move = (pointerEvent: PointerEvent) => {
				if (pointerEvent.pointerId !== session.pointerId) return;
				session.lastX = pointerEvent.clientX;
				session.lastY = pointerEvent.clientY;
				if (!session.started) {
					const dx = pointerEvent.clientX - session.startX;
					const dy = pointerEvent.clientY - session.startY;
					if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
					session.started = true;
					onDragStartRef.current?.();
					draggingRef.current = true;
					setDragging(true);
					// Stop the browser from starting a text selection instead.
					scroller.style.userSelect = "none";
					document.body.style.userSelect = "none";
					window.getSelection?.()?.removeAllRanges();
					session.frame = requestAnimationFrame(step);
				}
				pointerEvent.preventDefault();
				paint();
			};

			const finish = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", finish);
				window.removeEventListener("pointercancel", finish);
				window.removeEventListener("keydown", onKeyDown);
				if (session.frame !== null) cancelAnimationFrame(session.frame);
				session.frame = null;
				const overlay = overlayRef.current;
				if (overlay) overlay.style.display = "none";
				scroller.style.removeProperty("user-select");
				document.body.style.removeProperty("user-select");
				if (sessionRef.current === session) sessionRef.current = null;
				if (cleanupRef.current === finish) cleanupRef.current = null;
				lastSignatureRef.current = "";
				if (!session.started) return;
				draggingRef.current = false;
				setDragging(false);
				// Swallow the click that follows the drag: releasing over the row
				// where the press started must not open the paper. Cleared by the
				// next press, so a stale flag can never eat a later click.
				draggedRef.current = true;
			};

			const onKeyDown = (keyEvent: KeyboardEvent) => {
				if (keyEvent.key !== "Escape") return;
				keyEvent.preventDefault();
				const wasStarted = session.started;
				finish();
				if (wasStarted) onCancelRef.current?.();
			};

			cleanupRef.current = finish;
			window.addEventListener("pointermove", move, { passive: false });
			window.addEventListener("pointerup", finish);
			window.addEventListener("pointercancel", finish);
			window.addEventListener("keydown", onKeyDown);
		},
		[scrollRef],
	);

	const didJustDrag = useCallback(() => draggedRef.current, []);
	const isDragging = useCallback(() => draggingRef.current, []);

	return { onPointerDown, overlayRef, dragging, isDragging, didJustDrag };
}
