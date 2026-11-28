/** Selected elements and their action menu. Pointer hover lives separately. */

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

/** One selected layout element, or one explicit crop rectangle. */
export type LayoutElementActionMember = {
	/** Identity of this selection, including the sentence when one was hit. */
	id: string;
	source: "element" | "region";
	/** Layout region that supplies the element kind and surrounding text. */
	regionId?: string;
	pageIndex: number;
	kind: PdfLayoutKind | "region";
	quote: string;
	/** Main bbox. Visual members are cropped from this box. */
	bbox: PdfAskNormalizedRect;
	/** Every box that belongs to the member, for frames and anchors. */
	rects: PdfAskNormalizedRect[];
	/** Rendered sentence geometry for placing the menu on the translation. */
	visibleRects?: PdfAskNormalizedRect[];
	/** Sentence geometry for selection highlights in either pane. */
	sentence?: LayoutSentenceHover;
};

export type LayoutElementAction = {
	docId: string;
	/** Page of the action menu anchor. All members share this page. */
	pageIndex: number;
	/** Member the menu is anchored to. */
	anchorId: string;
	members: LayoutElementActionMember[];
	screen: LayoutElementScreen;
};

type LayoutElementActionState = {
	action: LayoutElementAction | null;
	/** One inspection mode shared by a source PDF and its translation pane. */
	selectionDocumentId: string | null;
	/** A modifier-drag crop is in progress; PDF text selection stays off. */
	cropGestureDocumentId: string | null;
};

export const layoutElementActionStore = createStore<LayoutElementActionState>(
	() => ({
		action: null,
		selectionDocumentId: null,
		cropGestureDocumentId: null,
	}),
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
		cropGestureDocumentId: null,
	});
}

export function openLayoutElementAction(action: LayoutElementAction): void {
	layoutElementActionStore.setState({ action });
}

export function anchorLayoutElementAction(
	action: LayoutElementAction,
): LayoutElementActionMember {
	const anchor =
		action.members.find((member) => member.id === action.anchorId) ??
		action.members.at(0);
	if (!anchor) throw new Error("Layout element action has no members");
	return anchor;
}

export function closeLayoutElementAction(): void {
	if (!layoutElementActionStore.getState().action) return;
	layoutElementActionStore.setState({ action: null });
}

export function beginLayoutElementCropGesture(docId: string): void {
	if (layoutElementActionStore.getState().cropGestureDocumentId === docId) {
		return;
	}
	layoutElementActionStore.setState({ cropGestureDocumentId: docId });
}

export function endLayoutElementCropGesture(docId: string): void {
	if (layoutElementActionStore.getState().cropGestureDocumentId !== docId) {
		return;
	}
	layoutElementActionStore.setState({ cropGestureDocumentId: null });
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
