/**
 * Viewport height usable as a scroll anchor, or null when it cannot be kept
 * without clamping to the document edge (the caret was scrolled out of view).
 */
export function visibleAnchorTop(
	top: number | null,
	clientHeight: number,
): number | null {
	if (top === null || clientHeight <= 0) return null;
	return top >= 0 && top <= clientHeight ? top : null;
}

/**
 * Scroll offset that keeps an anchor at the same visual height across two
 * editors with different line metrics. The result is clamped to the scroll
 * container so the caret stays visible near the document's start or end.
 */
export function scrollTopForViewportAnchor({
	anchorTop,
	anchorViewportTop,
	scrollHeight,
	clientHeight,
}: {
	/** Anchor top in the scroll content's coordinate space. */
	anchorTop: number;
	/** Where the anchor should appear, in px from the viewport top. */
	anchorViewportTop: number;
	scrollHeight: number;
	clientHeight: number;
}): number {
	const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
	return Math.min(maxScrollTop, Math.max(0, anchorTop - anchorViewportTop));
}
