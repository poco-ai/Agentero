export type SelectionSide = "above" | "below";

export function selectionFocusRect(
	selection: Selection | null | undefined,
): DOMRect | null {
	if (!selection?.focusNode) return null;
	return collapsedRect(selection.focusNode, selection.focusOffset);
}

function collapsedRect(node: Node, offset: number): DOMRect | null {
	if (typeof document === "undefined") return null;
	try {
		const range = document.createRange();
		range.setStart(node, offset);
		range.collapse(true);
		const rect = range.getBoundingClientRect();
		return rect.width > 0 || rect.height > 0 ? rect : null;
	} catch {
		return null;
	}
}

/**
 * Side of the selected lines where the gesture ended.
 *
 * DOM selection `anchor` is where the gesture started and `focus` is where it
 * ended. Their collapsed client rects keep the toolbar on the same side as the
 * last cursor for backward drags and keyboard extension. Falls back to document
 * order when one endpoint is not rendered.
 */
export function selectionSideFromSelection(
	selection: Selection | null | undefined,
): SelectionSide | undefined {
	if (!selection || selection.isCollapsed) return undefined;
	const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
	if (!anchorNode || !focusNode) return undefined;

	const anchorRect = collapsedRect(anchorNode, anchorOffset);
	const focusRect = selectionFocusRect(selection);
	if (anchorRect && focusRect) {
		if (focusRect.top > anchorRect.top) return "below";
		if (focusRect.top < anchorRect.top) return "above";
		if (focusRect.left > anchorRect.left) return "below";
		if (focusRect.left < anchorRect.left) return "above";
	}

	if (anchorNode === focusNode) {
		if (focusOffset === anchorOffset) return undefined;
		return focusOffset > anchorOffset ? "below" : "above";
	}
	const position = anchorNode.compareDocumentPosition(focusNode);
	if (position & Node.DOCUMENT_POSITION_FOLLOWING) return "below";
	if (position & Node.DOCUMENT_POSITION_PRECEDING) return "above";
	return undefined;
}
