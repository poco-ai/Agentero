import { type RefObject, useEffect } from "react";
import { type PdfReadingPose, readingPoseReady } from "@/lib/pdf/reading-pose";
import { cancelPendingViewportScroll } from "@/lib/pdf/scroll-sync";
import { uiStore } from "@/lib/shell/ui-store";

type ZoomController = {
	getState: () => { currentZoomLevel: number };
	requestZoom: (value: number) => void;
	onZoomChange: (callback: () => void) => () => void;
};

export function usePdfImmersivePosition(
	docId: string,
	hostRef: RefObject<HTMLDivElement | null>,
	zoomRef: RefObject<ZoomController | null>,
) {
	useEffect(() => {
		const viewport = () =>
			hostRef.current?.querySelector<HTMLElement>("[data-pdf-viewport]");
		let immersive = uiStore.getState().immersiveReading;
		let saved: PdfReadingPose | null = null;
		let stopRestore: (() => void) | undefined;
		const off = uiStore.subscribe((state) => {
			if (state.immersiveReading === immersive) return;
			immersive = state.immersiveReading;
			stopRestore?.();
			const node = viewport();
			const zoom = zoomRef.current;
			if (!node || !zoom) return;
			if (immersive) {
				saved = {
					zoom: zoom.getState().currentZoomLevel,
					top: node.scrollTop,
					left: node.scrollLeft,
					width: node.clientWidth,
					height: node.clientHeight,
					scrollWidth: node.scrollWidth,
					scrollHeight: node.scrollHeight,
				};
				return;
			}
			const pose = saved;
			saved = null;
			if (!pose) return;
			let frame = 0;
			let stopped = false;
			const restore = () => {
				frame = 0;
				if (stopped || !node.isConnected) return;
				if (
					Math.abs(pose.width - node.clientWidth) > 2 ||
					Math.abs(pose.height - node.clientHeight) > 2
				)
					return;
				if (Math.abs(zoom.getState().currentZoomLevel - pose.zoom) >= 0.001) {
					zoom.requestZoom(pose.zoom);
					return;
				}
				if (!readingPoseReady(pose, node, zoom.getState().currentZoomLevel))
					return;
				cancelPendingViewportScroll(docId);
				node.scrollTop = pose.top;
				node.scrollLeft = pose.left;
				stopRestore?.();
			};
			const schedule = () => {
				if (!stopped) frame ||= requestAnimationFrame(restore);
			};
			const observer = new ResizeObserver(schedule);
			observer.observe(node);
			if (node.firstElementChild) observer.observe(node.firstElementChild);
			const offZoom = zoom.onZoomChange(schedule);
			const cancel = () => stopRestore?.();
			stopRestore = () => {
				stopped = true;
				cancelAnimationFrame(frame);
				observer.disconnect();
				offZoom();
				node.removeEventListener("wheel", cancel);
				node.removeEventListener("pointerdown", cancel);
				window.removeEventListener("keydown", cancel);
				stopRestore = undefined;
			};
			node.addEventListener("wheel", cancel, { passive: true });
			node.addEventListener("pointerdown", cancel);
			window.addEventListener("keydown", cancel);
			schedule();
		});
		return () => {
			off();
			stopRestore?.();
		};
	}, [docId, hostRef, zoomRef]);
}
