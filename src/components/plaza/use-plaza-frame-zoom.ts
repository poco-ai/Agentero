import { useEffect, useRef, useState } from "react";

const ZOOM_STEPS = [
	0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
];

/** Scale the frame element, without accessing a cross-origin document or reloading it. */
export function usePlazaFrameZoom(desktopWidth = 0) {
	const viewportRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [manualScale, setManualScale] = useState<number | null>(null);
	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		if (viewport.clientWidth > 0 && viewport.clientHeight > 0) {
			setSize({ width: viewport.clientWidth, height: viewport.clientHeight });
		}
		const observer = new ResizeObserver(([entry]) => {
			const { width, height } = entry.contentRect;
			// Dockview hides retained tabs. Keep their last useful viewport until shown.
			if (width > 0 && height > 0) setSize({ width, height });
		});
		observer.observe(viewport);
		return () => observer.disconnect();
	}, []);
	const fitScale =
		desktopWidth > 0 && size.width > 0
			? Math.min(1, size.width / desktopWidth)
			: 1;
	const scale = manualScale ?? fitScale;
	const smaller = [...ZOOM_STEPS]
		.reverse()
		.find((step) => step < scale - 0.001);
	const larger = ZOOM_STEPS.find((step) => step > scale + 0.001);
	return {
		viewportRef,
		scale,
		automatic: manualScale === null,
		zoomOut: () => smaller !== undefined && setManualScale(smaller),
		zoomIn: () => larger !== undefined && setManualScale(larger),
		canZoomOut: smaller !== undefined,
		canZoomIn: larger !== undefined,
		fit: () => {
			setManualScale(null);
			if (viewportRef.current) viewportRef.current.scrollLeft = 0;
		},
		// The clipping wrapper removes the unscaled iframe's layout overflow.
		pageWidth:
			size.width > 0 ? Math.max(desktopWidth, size.width / scale) : undefined,
		pageHeight: size.height > 0 ? size.height / scale : undefined,
	};
}
