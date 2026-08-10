import { useViewportElement } from "@embedpdf/plugin-viewport/react";
import { useZoom } from "@embedpdf/plugin-zoom/react";
import { useEffect, useRef } from "react";
import {
	bindWheelZoomGesture,
	createWheelZoomCoalescer,
} from "@/lib/pdf/wheel-zoom";

/** Wheel gesture idle window before pending zoom deltas are dropped. */
const WHEEL_ZOOM_RESET_MS = 150;

/**
 * Custom Ctrl/Cmd+wheel zoom handler.
 *
 * EmbedPDF's ZoomGestureWrapper multiplies the current scale by a factor
 * derived from `deltaY`, which makes a single mouse-wheel tick double or
 * halve the zoom. We disable that built-in behavior and instead step the zoom
 * with the same fixed increments used by the toolbar +/- buttons.
 *
 * Steps are coalesced per animation frame (createWheelZoomCoalescer): a
 * trackpad pinch fires many wheel events per second, and each applied step
 * re-rasterizes all visible pages on the main thread — batching keeps that to
 * once per frame. bindWheelZoomGesture keeps the listener passive while the user
 * is merely scrolling, so plain scrolls stay off the main thread.
 */
export function WheelZoomHandler({ docId }: { docId: string }) {
	const viewportRef = useViewportElement();
	const { provides: zoom } = useZoom(docId);
	const zoomRef = useRef(zoom);
	zoomRef.current = zoom;

	useEffect(() => {
		const container = viewportRef?.current;
		if (!container) return;

		const coalescer = createWheelZoomCoalescer({
			onZoomIn: () => zoomRef.current?.zoomIn(),
			onZoomOut: () => zoomRef.current?.zoomOut(),
		});

		let resetTimeout: ReturnType<typeof setTimeout> | null = null;
		const scheduleReset = () => {
			if (resetTimeout) clearTimeout(resetTimeout);
			resetTimeout = setTimeout(() => {
				resetTimeout = null;
				coalescer.reset();
			}, WHEEL_ZOOM_RESET_MS);
		};

		const binding = bindWheelZoomGesture({
			target: container,
			onZoomWheel: (e) => {
				if (!zoomRef.current) return;
				coalescer.addDelta(e.deltaY);
				scheduleReset();
			},
		});

		return () => {
			binding.dispose();
			if (resetTimeout) clearTimeout(resetTimeout);
			coalescer.dispose();
		};
	}, [viewportRef]);

	return null;
}
