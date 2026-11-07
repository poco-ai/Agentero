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
