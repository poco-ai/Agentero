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

/** Pixel based touchpad streams need a longer gap to separate gestures. */
const WHEEL_ZOOM_PIXEL_IDLE_MS = 400;
/** Discrete mouse wheel ticks have an explicit end after a shorter gap. */
const WHEEL_ZOOM_TICK_IDLE_MS = 150;
/** WebKit emits an explicit gestureend, but closely spaced pinches can continue. */
const WEBKIT_GESTURE_CONTINUE_MS = 240;

/**
 * Wheel deltaY units per unit of natural log magnification. A wheel notch of
 * 100 (or 120) therefore magnifies by ~10% (or ~13%).
 */
const WHEEL_SCALE_DELTA_GAIN = 1000;

/** Magnification equivalent to one wheel delta (negative delta zooms in). */
export function wheelDeltaToZoomRatio(delta: number, pinch = false): number {
	// Chromium encodes native pinch magnification as -100 * ln(scale).
	return Math.exp(-delta / (pinch ? 100 : WHEEL_SCALE_DELTA_GAIN));
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
	/** Treat every wheel tick as zoom (used by dedicated fullscreen canvases). */
	zoomOnWheel?: boolean;
	/** First event of the gesture; the point is in client coordinates. */
	onZoomStart: (point: ZoomGesturePoint) => void;
	/** Magnification relative to the gesture start (1 = unchanged). */
	onZoomChange: (ratio: number) => void;
	/** Gesture is over; the caller commits the previewed zoom. */
	onZoomEnd: () => void;
	/** Pixel wheel idle delay; discrete ticks and WebKit pinches use their own. */
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
 * Delivery of a pinch differs per engine. On WebKit (Safari / macOS WKWebView)
 * it never arrives as ctrl+wheel — it comes as
 * gesturestart/gesturechange/gestureend instead. Those are default-prevented so
 * the platform magnify is suppressed and reported through the same
 * start/change/end callbacks, with the scale
 * ratio measured against the start of the gesture. On Windows, the host enables
 * WebView2 pinch recognition and cancels native page scaling in capture. Its
 * synthetic Ctrl+wheel reaches this binding, tagged for native pinch sensitivity.
 */
export function bindZoomGesture({
	target,
	zoomOnWheel = false,
	onZoomStart,
	onZoomChange,
	onZoomEnd,
	idleMs = WHEEL_ZOOM_PIXEL_IDLE_MS,
}: ZoomGestureBindingOptions): { dispose(): void } {
	let passive = false;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let wheelZooming = false;
	let wheelRatio = 1;
	let gestureZooming = false;
	let gestureRatio = 1;
	let gestureStartScale = 1;
	let gestureEndTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	const clearIdleTimer = () => {
		if (idleTimer === null) return;
		clearTimeout(idleTimer);
		idleTimer = null;
	};
	const clearGestureEndTimer = () => {
		if (gestureEndTimer === null) return;
		clearTimeout(gestureEndTimer);
		gestureEndTimer = null;
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
		if (zoomOnWheel || event.ctrlKey || event.metaKey) {
			if (gestureZooming) {
				clearGestureEndTimer();
				gestureZooming = false;
				gestureRatio = 1;
				onZoomEnd();
			}
			if (canPreventDefault && event.cancelable) event.preventDefault();
			setPassive(false);
			if (!wheelZooming) {
				wheelZooming = true;
				wheelRatio = 1;
				onZoomStart({ x: event.clientX, y: event.clientY });
			}
			wheelRatio *= wheelDeltaToZoomRatio(
				event.deltaY,
				(event as WheelEvent & { agenteroPinch?: boolean }).agenteroPinch,
			);
			onZoomChange(wheelRatio);
			const streamIdleMs =
				event.deltaMode === 0 ? idleMs : WHEEL_ZOOM_TICK_IDLE_MS;
			clearIdleTimer();
			idleTimer = setTimeout(() => {
				idleTimer = null;
				wheelZooming = false;
				onZoomEnd();
			}, streamIdleMs);
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
		clearGestureEndTimer();
		if (wheelZooming) {
			wheelZooming = false;
			wheelRatio = 1;
			onZoomEnd();
		}
		gestureScale = event.scale || 1;
		if (!gestureZooming) {
			gestureZooming = true;
			gestureRatio = 1;
			onZoomStart({ x: event.clientX ?? NaN, y: event.clientY ?? NaN });
		}
		gestureStartScale = gestureScale;
	};
	const handleGestureChange = (raw: Event) => {
		if (disposed) return;
		const event = raw as unknown as WebKitGestureEvent;
		event.preventDefault();
		const scale = event.scale || 1;
		if (!(gestureScale > 0) || !(scale > 0)) return;
		gestureRatio *= scale / gestureStartScale;
		gestureStartScale = scale;
		onZoomChange(gestureRatio);
	};
	const handleGestureEnd = (raw: Event) => {
		if (disposed) return;
		(raw as unknown as WebKitGestureEvent).preventDefault();
		if (!gestureZooming) return;
		gestureScale = 1;
		clearGestureEndTimer();
		gestureEndTimer = setTimeout(() => {
			gestureEndTimer = null;
			if (!gestureZooming) return;
			gestureZooming = false;
			gestureRatio = 1;
			gestureStartScale = 1;
			onZoomEnd();
		}, WEBKIT_GESTURE_CONTINUE_MS);
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
			clearGestureEndTimer();
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
