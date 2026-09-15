/**
 * Zoom gesture bindings for the PDF viewer: Ctrl/Cmd+wheel and trackpad pinch.
 *
 * Both report one cumulative magnification per gesture, so the caller can
 * preview the zoom with a CSS transform while the gesture runs and commit a
 * single real zoom when it ends. Committing once is not just cheaper: every real
 * zoom re-lays out the scroller and queues a viewport scroll request for the
 * next frame, and a stream of those (one per animation frame) supersedes its own
 * anchor and walks the viewport towards the start of the document.
 */

/** Wheel stream must be silent this long before a zoom gesture is over. */
const WHEEL_ZOOM_IDLE_MS = 150;

/**
 * Wheel deltaY units per unit of natural log magnification. A wheel notch of
 * 100 (or 120) therefore magnifies by ~10% (or ~13%).
 */
const WHEEL_SCALE_DELTA_GAIN = 1000;

/** Magnification equivalent to one wheel delta (negative delta zooms in). */
export function wheelDeltaToZoomRatio(delta: number): number {
	return Math.exp(-delta / WHEEL_SCALE_DELTA_GAIN);
}

/** Minimal shape of WebKit's non-standard GestureEvent. */
type WebKitGestureEvent = {
	scale: number;
	clientX?: number;
	clientY?: number;
	preventDefault(): void;
};

export type ZoomGesturePoint = { x: number; y: number };

export type ZoomGestureBindingOptions = {
	target: Pick<HTMLElement, "addEventListener" | "removeEventListener">;
	/** First event of the gesture; the point is in client coordinates. */
	onZoomStart: (point: ZoomGesturePoint) => void;
	/** Magnification relative to the gesture start (1 = unchanged). */
	onZoomChange: (ratio: number) => void;
	/** Gesture is over; the caller commits the previewed zoom. */
	onZoomEnd: () => void;
	/** Wheel-idle delay, shared by zoom gestures and plain scrolling. */
	idleMs?: number;
};

/**
 * Bind zoom gestures without keeping the container permanently non-passive.
 *
 * A non-passive wheel listener forces every tick through the main thread before
 * the container may scroll, which shows up as scroll jank whenever the viewer is
 * busy. Zoom still needs `preventDefault` (platform pinch zoom would otherwise
 * scale the whole app), so the non-passive listener stays attached until a plain
 * scroll gesture starts and comes back once the wheel stream goes idle. A pinch
 * that begins mid-scroll still zooms; only that first tick keeps its default.
 *
 * On WebKit (Safari / macOS WKWebView) trackpad pinch never arrives as
 * ctrl+wheel; it is delivered as gesturestart/gesturechange/gestureend
 * instead. Those are default-prevented so the platform magnify is suppressed
 * and reported through the same start/change/end callbacks, with the scale
 * ratio measured against the start of the gesture.
 */
export function bindZoomGesture({
	target,
	onZoomStart,
	onZoomChange,
	onZoomEnd,
	idleMs = WHEEL_ZOOM_IDLE_MS,
}: ZoomGestureBindingOptions): { dispose(): void } {
	let passive = false;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let wheelZooming = false;
	let wheelRatio = 1;
	let disposed = false;

	const clearIdleTimer = () => {
		if (idleTimer === null) return;
		clearTimeout(idleTimer);
		idleTimer = null;
	};

	const armIdleTimer = (callback: () => void) => {
		clearIdleTimer();
		idleTimer = setTimeout(() => {
			idleTimer = null;
			callback();
		}, idleMs);
	};

	const setPassive = (next: boolean) => {
		if (passive === next) return;
		target.removeEventListener(
			"wheel",
			passive ? passiveListener : activeListener,
		);
		passive = next;
		target.addEventListener("wheel", next ? passiveListener : activeListener, {
			passive: next,
		});
	};

	const handleWheel = (event: WheelEvent, canPreventDefault: boolean) => {
		if (disposed) return;
		if (event.ctrlKey || event.metaKey) {
			if (canPreventDefault && event.cancelable) event.preventDefault();
			setPassive(false);
			if (!wheelZooming) {
				wheelZooming = true;
				wheelRatio = 1;
				onZoomStart({ x: event.clientX, y: event.clientY });
			}
			wheelRatio *= wheelDeltaToZoomRatio(event.deltaY);
			onZoomChange(wheelRatio);
			armIdleTimer(() => {
				wheelZooming = false;
				onZoomEnd();
			});
			return;
		}
		setPassive(true);
		armIdleTimer(() => setPassive(false));
	};

	function activeListener(event: WheelEvent) {
		handleWheel(event, true);
	}
	function passiveListener(event: WheelEvent) {
		handleWheel(event, false);
	}

	let gestureScale = 1;
	const handleGestureStart = (raw: Event) => {
		if (disposed) return;
		const event = raw as unknown as WebKitGestureEvent;
		event.preventDefault();
		clearIdleTimer();
		gestureScale = event.scale || 1;
		onZoomStart({ x: event.clientX ?? NaN, y: event.clientY ?? NaN });
	};
	const handleGestureChange = (raw: Event) => {
		if (disposed) return;
		const event = raw as unknown as WebKitGestureEvent;
		event.preventDefault();
		const scale = event.scale || 1;
		if (!(gestureScale > 0) || !(scale > 0)) return;
		onZoomChange(scale / gestureScale);
	};
	const handleGestureEnd = (raw: Event) => {
		if (disposed) return;
		(raw as unknown as WebKitGestureEvent).preventDefault();
		gestureScale = 1;
		onZoomEnd();
	};

	target.addEventListener("wheel", activeListener, { passive: false });
	target.addEventListener("gesturestart", handleGestureStart);
	target.addEventListener("gesturechange", handleGestureChange);
	target.addEventListener("gestureend", handleGestureEnd);

	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			clearIdleTimer();
			target.removeEventListener(
				"wheel",
				passive ? passiveListener : activeListener,
			);
			target.removeEventListener("gesturestart", handleGestureStart);
			target.removeEventListener("gesturechange", handleGestureChange);
			target.removeEventListener("gestureend", handleGestureEnd);
		},
	};
}
