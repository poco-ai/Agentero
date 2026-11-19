/**
 * Drag-to-pan (momentary hand tool) for the PDF viewport.
 *
 * Matches the common PDF-reader interaction: hold the middle or right button,
 * or hold Space and use the left button, and the page follows the cursor 1:1 on
 * both axes until the button is released.
 *
 * The gesture writes native `scrollLeft` / `scrollTop` on the viewport element;
 * `DockviewViewport` already coalesces the resulting scroll events into
 * EmbedPDF's per-frame scroll metrics, so tiling, fit modes and floating card
 * anchors stay in sync without further work.
 */

export type PanDragState = "idle" | "panning";

/** Scroll container the gesture drives; structural so it stays testable. */
export type PanDragTarget = Pick<
	HTMLElement,
	| "addEventListener"
	| "removeEventListener"
	| "setPointerCapture"
	| "releasePointerCapture"
	| "hasPointerCapture"
	| "scrollLeft"
	| "scrollTop"
>;

type PanDragGestureOptions = {
	target: PanDragTarget;
	/** True while Space is held, arming left-button drag as well. */
	isLeftDragArmed: () => boolean;
	/** True for targets that must keep their own pointer behavior (editors). */
	isExcludedTarget: (target: EventTarget | null) => boolean;
	/**
	 * Right-drag pans too, so the page loses its native context menu. Chrome
	 * that owns its right click (toolbars, selection menus, cards) opts out here
	 * and keeps the native / custom menu.
	 */
	isRightDragExcludedTarget?: (target: EventTarget | null) => boolean;
	/** Cursor feedback; `"panning"` for the duration of a drag. */
	onStateChange?: (state: PanDragState) => void;
};

export type PanDragBinding = {
	/** End an in-flight drag (window lost focus) without detaching listeners. */
	cancel(): void;
	dispose(): void;
};

export function bindPanDragGesture({
	target,
	isLeftDragArmed,
	isExcludedTarget,
	isRightDragExcludedTarget,
	onStateChange,
}: PanDragGestureOptions): PanDragBinding {
	let disposed = false;
	let drag: {
		pointerId: number;
		startX: number;
		startY: number;
		scrollLeft: number;
		scrollTop: number;
	} | null = null;
	/**
	 * A right press that started a pan owns this button's context menu: WebKit
	 * dispatches it on mousedown (before any movement) and WebView2 after the
	 * release, so the flag survives the whole press and is consumed by the menu
	 * event or the next pointerdown.
	 */
	let rightPanPress = false;

	const endDrag = () => {
		if (!drag) return;
		const { pointerId } = drag;
		drag = null;
		if (target.hasPointerCapture(pointerId)) {
			target.releasePointerCapture(pointerId);
		}
		onStateChange?.("idle");
	};

	/** Middle or right button, or left button while Space arms the hand tool. */
	const isPanButton = (event: MouseEvent) =>
		event.button === 1 ||
		event.button === 2 ||
		(event.button === 0 && isLeftDragArmed());

	const isRightDragExcluded = (eventTarget: EventTarget | null) =>
		isRightDragExcludedTarget?.(eventTarget) ?? false;

	const handlePointerDown = (event: PointerEvent) => {
		if (disposed || drag || event.pointerType !== "mouse") return;
		// Each new press decides its own right-click behavior afresh.
		rightPanPress = false;
		if (!isPanButton(event) || isExcludedTarget(event.target)) return;
		if (event.button === 2 && isRightDragExcluded(event.target)) return;
		// Capture phase on the scroll container: stopping propagation here keeps
		// EmbedPDF's text-selection and link handlers (bubble listeners on a
		// descendant) from ever seeing the gesture.
		event.preventDefault();
		event.stopPropagation();
		// Capture is a nicety, not a requirement: it keeps move/up arriving when the
		// pointer leaves the viewport, but the drag works without it because those
		// events still bubble from the page layers to this scroll container. WebKit
		// drops capture right after a default-prevented pointerdown and throws
		// NotFoundError for a pointer it no longer considers active, so never let it
		// abort the gesture.
		try {
			target.setPointerCapture(event.pointerId);
		} catch {
			// Ignored: see above.
		}
		rightPanPress = event.button === 2;
		drag = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			scrollLeft: target.scrollLeft,
			scrollTop: target.scrollTop,
		};
		onStateChange?.("panning");
	};

	// WebKit and Windows still dispatch a compatibility mousedown after a
	// default-prevented pointerdown; without suppressing it the middle button
	// falls back to native autoscroll, the right button opens the page's context
	// menu, and an armed left-drag starts a native selection instead of panning.
	const handleMouseDown = (event: MouseEvent) => {
		if (disposed || !isPanButton(event)) return;
		if (isExcludedTarget(event.target)) return;
		if (event.button === 2 && isRightDragExcluded(event.target)) return;
		event.preventDefault();
		event.stopPropagation();
	};

	/**
	 * Right-drag shares its button with the context menu, so the page keeps no
	 * native menu once it can pan. Chrome surfaces are excluded from the right
	 * drag above, and their menus reach them untouched.
	 */
	const handleContextMenu = (event: MouseEvent) => {
		if (disposed || !rightPanPress) return;
		rightPanPress = false;
		event.preventDefault();
		event.stopPropagation();
	};

	const handlePointerMove = (event: PointerEvent) => {
		if (!drag || event.pointerId !== drag.pointerId) return;
		target.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX);
		target.scrollTop = drag.scrollTop - (event.clientY - drag.startY);
	};

	const handlePointerEnd = (event: PointerEvent) => {
		if (!drag || event.pointerId !== drag.pointerId) return;
		endDrag();
	};

	target.addEventListener("pointerdown", handlePointerDown, true);
	target.addEventListener("mousedown", handleMouseDown, true);
	target.addEventListener("contextmenu", handleContextMenu, true);
	target.addEventListener("pointermove", handlePointerMove);
	target.addEventListener("pointerup", handlePointerEnd);
	// Not `lostpointercapture`: WebKit fires it immediately after a
	// default-prevented pointerdown, which would end the drag as it starts.
	target.addEventListener("pointercancel", handlePointerEnd);

	return {
		cancel: endDrag,
		dispose() {
			if (disposed) return;
			disposed = true;
			endDrag();
			rightPanPress = false;
			target.removeEventListener("pointerdown", handlePointerDown, true);
			target.removeEventListener("mousedown", handleMouseDown, true);
			target.removeEventListener("contextmenu", handleContextMenu, true);
			target.removeEventListener("pointermove", handlePointerMove);
			target.removeEventListener("pointerup", handlePointerEnd);
			target.removeEventListener("pointercancel", handlePointerEnd);
		},
	};
}
