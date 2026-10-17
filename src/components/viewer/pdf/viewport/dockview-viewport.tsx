import {
	useIsViewportGated,
	useViewportCapability,
	useViewportPlugin,
	ViewportElementContext,
} from "@embedpdf/plugin-viewport/react";
import {
	type HTMLAttributes,
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPdfViewportResizeGate } from "@/lib/pdf/dockview-resize";
import {
	getScrollSyncPartner,
	handleScrollSyncIntent,
	handleScrollSyncScroll,
	handleScrollSyncScrollEnd,
	registerScrollSyncElement,
} from "@/lib/pdf/scroll-sync";
import { createPdfViewportScrollScheduler } from "@/lib/pdf/viewport-scroll";
import { subscribeResizeGesture } from "@/lib/workspace/resize-gesture";

type DockviewViewportProps = HTMLAttributes<HTMLDivElement> & {
	children: ReactNode;
	documentId: string;
	hostRef: RefObject<HTMLDivElement | null>;
	/**
	 * Extra right padding (px) beyond the viewport gap, reserving room for
	 * overlays pinned outside the page's right edge (comment rail) so they do
	 * not grow scrollWidth into a horizontal scrollbar.
	 */
	rightGutter?: number;
};

/**
 * Dockview updates panel geometry on every sash pointermove. EmbedPDF's
 * ResizeObserver otherwise turns each of those moves into viewport + scroll
 * state updates. Keep the DOM viewport following the panel while resize
 * metrics are gated; releasing the sash lets EmbedPDF observe the final size
 * once.
 */
export function DockviewViewport({
	children,
	documentId,
	hostRef,
	rightGutter = 0,
	...props
}: DockviewViewportProps) {
	const [viewportGap, setViewportGap] = useState(0);
	const viewportRef = useRef<HTMLDivElement>(null);
	const { plugin: viewportPlugin } = useViewportPlugin();
	const { provides: viewportCapability } = useViewportCapability();
	const isGated = useIsViewportGated(documentId);

	useEffect(() => {
		if (viewportCapability) {
			setViewportGap(viewportCapability.getViewportGap());
		}
	}, [viewportCapability]);

	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		if (!viewportPlugin || !viewport) return;

		try {
			viewportPlugin.registerViewport(documentId);
		} catch {
			return;
		}

		const ownerDocument = viewport.ownerDocument;
		const ownerWindow = ownerDocument.defaultView;
		const requestFrame = (callback: FrameRequestCallback) =>
			ownerWindow
				? ownerWindow.requestAnimationFrame(callback)
				: requestAnimationFrame(callback);
		const cancelFrame = (handle: number) => {
			if (ownerWindow) ownerWindow.cancelAnimationFrame(handle);
			else cancelAnimationFrame(handle);
		};
		const scrollScheduler = createPdfViewportScrollScheduler({
			requestFrame,
			cancelFrame,
			apply: (request) => {
				viewport.scrollTo({
					left: request.x,
					top: request.y,
					behavior: request.behavior,
				});
			},
		});
		// Dual-pane scroll sync writes this element inside the scroll event.
		// A scrollTo still waiting on the next frame is dropped so it cannot
		// pull the follower back; plugin metrics stay on the frame below.
		const unregisterScrollSyncElement = registerScrollSyncElement(
			documentId,
			viewport,
			{
				cancelPendingScroll: () => scrollScheduler.cancelPending(),
			},
		);
		const commitResize = () => {
			// Report a reduced width so EmbedPDF's fitWidth zoom leaves room for the
			// comment rail that overflows into the reserved right gutter.
			const width = Math.max(1, viewport.offsetWidth - rightGutter);
			const clientWidth = Math.max(1, viewport.clientWidth - rightGutter);
			viewportPlugin.setViewportResizeMetrics(documentId, {
				width,
				height: viewport.offsetHeight,
				clientWidth,
				clientHeight: viewport.clientHeight,
				scrollTop: viewport.scrollTop,
				scrollLeft: viewport.scrollLeft,
				scrollWidth: viewport.scrollWidth,
				scrollHeight: viewport.scrollHeight,
				clientLeft: viewport.clientLeft,
				clientTop: viewport.clientTop,
			});
		};
		const resizeGate = createPdfViewportResizeGate({
			commitResize,
			requestFrame,
			cancelFrame,
		});

		// Gate on the shared gesture rather than on `.dv-sash` pointerdown: rail
		// drags and native window resizes resize this viewport too, and they never
		// produce a sash event (see `lib/workspace/resize-gesture.ts`). Subscribing
		// by element would race the workspace's own effect — a child layout effect
		// runs first — so this uses the order-independent fan-out.
		const unsubscribeGesture = subscribeResizeGesture((active) => {
			if (active) resizeGate.beginDockResize();
			else resizeGate.endDockResize();
		});

		let scrollFrame: number | null = null;
		const handleScroll = () => {
			// Scrollbar, keyboard, drag, and the browser's wheel. The partner is
			// not moved here; it jumps once the gesture settles. A programmatic
			// write also arrives here. This handler still must not cancel pending
			// jumps: virtual-page reordering, zoom, and the jump itself all scroll
			// programmatically. The wheel listener only claims the leader.
			handleScrollSyncScroll(documentId);
			if (scrollFrame != null) return;
			scrollFrame = requestFrame(() => {
				scrollFrame = null;
				viewportPlugin.setViewportScrollMetrics(documentId, {
					scrollTop: viewport.scrollTop,
					scrollLeft: viewport.scrollLeft,
				});
			});
		};
		const handleScrollEnd = () => handleScrollSyncScrollEnd(documentId);
		viewport.addEventListener("scroll", handleScroll, { passive: true });
		viewport.addEventListener("scrollend", handleScrollEnd);
		// Passive on purpose. Canceling the wheel forces this pane off the
		// compositor. The partner is not moved until the gesture settles.
		// Ctrl/Cmd+wheel and pinches belong to zoom. A wheel over PDF chrome,
		// a dialog, or a field scrolls that surface.
		const handleWheel = (event: WheelEvent) => {
			if (event.ctrlKey || event.metaKey) return;
			const target = event.target;
			if (
				target instanceof Element &&
				target.closest(
					"[data-pdf-chrome], [role='dialog'], textarea, input, select",
				)
			) {
				return;
			}
			if (!getScrollSyncPartner(documentId)) return;
			handleScrollSyncIntent(documentId);
			scrollScheduler.cancelPending();
		};
		viewport.addEventListener("wheel", handleWheel, {
			capture: true,
			passive: true,
		});

		const ResizeObserverCtor = ownerWindow?.ResizeObserver ?? ResizeObserver;
		const resizeObserver = new ResizeObserverCtor(() => {
			resizeGate.notifyResize();
		});
		resizeObserver.observe(viewport);

		const unsubscribeScrollRequest = viewportPlugin.onScrollRequest(
			documentId,
			({ x, y, behavior = "auto" }) =>
				scrollScheduler.schedule({ x, y, behavior }),
		);

		return () => {
			unsubscribeGesture();
			resizeGate.dispose();
			resizeObserver.disconnect();
			if (scrollFrame != null) cancelFrame(scrollFrame);
			scrollScheduler.dispose();
			viewport.removeEventListener("scroll", handleScroll);
			viewport.removeEventListener("scrollend", handleScrollEnd);
			viewport.removeEventListener("wheel", handleWheel, true);
			unsubscribeScrollRequest();
			unregisterScrollSyncElement();
			viewportPlugin.unregisterViewport(documentId);
		};
	}, [documentId, viewportPlugin, rightGutter]);

	const { style, ...restProps } = props;

	return (
		<ViewportElementContext.Provider
			value={viewportRef as RefObject<HTMLDivElement>}
		>
			<div
				{...restProps}
				ref={viewportRef}
				style={{
					width: "100%",
					height: "100%",
					overflow: "auto",
					...style,
					// Scroller swaps virtualized page nodes while scrolling. Letting
					// Chromium's scroll anchoring adjust this custom virtual viewport can
					// move it to an endpoint when the rendered range changes.
					overflowAnchor: "none",
					padding: `${viewportGap}px`,
					// The shorthand above would clobber a caller's paddingRight; merge
					// the reserved rail gutter explicitly.
					paddingRight: `${viewportGap + rightGutter}px`,
				}}
			>
				{!isGated && children}
			</div>
		</ViewportElementContext.Provider>
	);
}
