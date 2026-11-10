import { useScrollCapability } from "@embedpdf/plugin-scroll/react";
import { useViewportElement } from "@embedpdf/plugin-viewport/react";
import { type RefObject, useEffect, useRef } from "react";
import { useSettings } from "@/hooks/use-app-stores";
import { ownsPdfKeyboard } from "@/lib/pdf/keyboard-ownership";
import { handleScrollSyncIntent } from "@/lib/pdf/scroll-sync";

/** One arrow press moves roughly one block of body text, like a browser scroll. */
const ARROW_SCROLL_STEP_PX = 72;

/**
 * Widgets whose own arrow-key behaviour must win. Buttons, links and dockview
 * tabs are deliberately absent: while reading, focus often sits on a tab or a
 * toolbar button, where the arrow keys do nothing on their own.
 */
type KeyboardScrollHandlerProps = {
	documentId: string;
	/** Gates the focus fallback; hover claims without it. */
	active: boolean;
	/** PDF host; arrow keys use the same ownership rule as the bare Space pan. */
	hostRef: RefObject<HTMLDivElement | null>;
};

/**
 * Arrow-key reading: ↑/↓ move through a continuous document and turn pages in
 * the paginated and horizontal layouts.
 *
 * Must render inside `DockviewViewport` (ViewportElementContext). Ownership
 * mirrors `PanDragHandler`: the hovered viewer wins because focus usually sits
 * on a tab, the sidebar or the notes pane while reading; the active viewer is
 * the fallback when focus is inside its host or still neutral after a click.
 * Form fields, menus, trees and PDF chrome always keep their native keys.
 */
export function KeyboardScrollHandler({
	documentId,
	active,
	hostRef,
}: KeyboardScrollHandlerProps) {
	const viewportRef = useViewportElement();
	const strategy = useSettings((s) => s.pdfScrollStrategy);
	const { provides: scrollCapability } = useScrollCapability();
	const activeRef = useRef(active);
	activeRef.current = active;
	const strategyRef = useRef(strategy);
	strategyRef.current = strategy;
	const scrollCapabilityRef = useRef(scrollCapability);
	scrollCapabilityRef.current = scrollCapability;

	useEffect(() => {
		const viewport = viewportRef?.current;
		if (!viewport) return;

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
				return;
			}
			const forward =
				event.key === "ArrowDown"
					? true
					: event.key === "ArrowUp"
						? false
						: null;
			if (forward === null) return;
			if (
				!ownsPdfKeyboard({
					target: event.target,
					host: hostRef.current,
					active: activeRef.current,
				})
			)
				return;

			event.preventDefault();
			handleScrollSyncIntent(documentId);
			if (strategyRef.current !== "vertical") {
				const scroll = scrollCapabilityRef.current?.forDocument(documentId);
				if (!scroll) return;
				if (forward) scroll.scrollToNextPage("instant");
				else scroll.scrollToPreviousPage("instant");
				return;
			}
			viewport.scrollTop += forward
				? ARROW_SCROLL_STEP_PX
				: -ARROW_SCROLL_STEP_PX;
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [documentId, hostRef, viewportRef]);

	return null;
}
