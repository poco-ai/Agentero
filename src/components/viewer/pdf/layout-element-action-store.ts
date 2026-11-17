/**
 * Open action view for one layout element.
 * Hover highlighting stays on the page DOM; this store only changes when
 * the user clicks or presses Enter, so pointer moves do not re-render pages.
 */

import { createStore } from "zustand/vanilla";
import type { LayoutSentenceHover } from "@/components/viewer/pdf/layout-sentence-hover";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import { layoutSentenceScope } from "@/lib/pdf/layout/store";
import type { PdfLayoutKind } from "@/lib/pdf/layout/types";

/** Menu anchor. `selectionBounds` lets the shared menu sit above the element. */
export type LayoutElementScreen = ScreenPoint & {
	selectionBounds?: {
		left: number;
		top: number;
		right: number;
		bottom: number;
	};
};

export type LayoutElementAction = {
	docId: string;
	regionId: string;
	pageIndex: number;
	kind: PdfLayoutKind;
	quote: string;
	/** Main bbox. Non-text elements are cropped from this box. */
	bbox: PdfAskNormalizedRect;
	/** Every box that belongs to the element, for the chat pin and translate anchor. */
	rects: PdfAskNormalizedRect[];
	screen: LayoutElementScreen;
	/** Clicked sentence stays painted until this action view is dismissed. */
	sentence?: LayoutSentenceHover;
};

type LayoutElementActionState = {
	action: LayoutElementAction | null;
	/** One inspection mode shared by a source PDF and its translation pane. */
	selectionDocumentId: string | null;
};

export const layoutElementActionStore = createStore<LayoutElementActionState>(
	() => ({ action: null, selectionDocumentId: null }),
);

export function setLayoutElementSelection(
	docId: string,
	enabled: boolean,
): void {
	const scope = layoutSentenceScope(docId);
	const current = layoutElementActionStore.getState();
	if (!enabled && current.selectionDocumentId !== scope) return;
	layoutElementActionStore.setState({
		selectionDocumentId: enabled ? scope : null,
		action: null,
	});
}

export function openLayoutElementAction(action: LayoutElementAction): void {
	layoutElementActionStore.setState({ action });
}

export function closeLayoutElementAction(): void {
	if (!layoutElementActionStore.getState().action) return;
	layoutElementActionStore.setState({ action: null });
}

export function moveLayoutElementAction(screen: LayoutElementScreen): void {
	const action = layoutElementActionStore.getState().action;
	if (!action) return;
	const prev = action.screen;
	if (
		prev.x === screen.x &&
		prev.y === screen.y &&
		prev.top === screen.top &&
		prev.bottom === screen.bottom
	) {
		return;
	}
	layoutElementActionStore.setState({ action: { ...action, screen } });
}
