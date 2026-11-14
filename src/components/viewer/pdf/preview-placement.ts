/**
 * Shared positioning and layout calculation for PDF preview hover cards
 * (cross-reference figures/tables/equations/references and in-text citations).
 *
 * Positioning rules:
 * - Horizontally centered relative to the triggering link (screen.x - cardWidth / 2).
 * - Arrow pointer points directly at the bottom-center of the triggering number/link.
 * - Placed below the triggering link's bottom edge by default (anchorBottom + gap).
 * - Auto-flip to above the triggering link's top edge (anchorTop - gap) with
 *   downward-pointing arrow when available space below is insufficient.
 * - Clamped within viewport boundaries, with the arrow smoothly sliding along
 *   the card edge to stay pointing at the triggering link.
 * - When the chosen side is short, the content shrinks (`maxContentHeight`)
 *   instead of the card sliding over the link; only a side too small even for
 *   the minimum content height lets the card overlap the anchor.
 */

export const PREVIEW_GAP = 10;
export const PREVIEW_VIEWPORT_PADDING = 12;
export const PREVIEW_ARROW_MARGIN = 16;
/** Card height outside the scrollable / image content (header + padding). */
export const PREVIEW_CHROME_HEIGHT = 44;
/** Content height bounds, whatever the space around the link. */
export const PREVIEW_MIN_CONTENT_HEIGHT = 100;
export const PREVIEW_MAX_CONTENT_HEIGHT = 500;

export type PreviewPlacementParams = {
	screen: { x: number; y: number; top?: number; bottom?: number };
	cardWidth: number;
	cardEstimatedHeight: number;
	/** Height the card adds around its content (default {@link PREVIEW_CHROME_HEIGHT}). */
	cardChromeHeight?: number;
	viewportWidth?: number;
	viewportHeight?: number;
	gap?: number;
	viewportPadding?: number;
	arrowMargin?: number;
};

export type PreviewPlacementResult = {
	placement: "bottom" | "top";
	left: number;
	top?: number;
	bottom?: number;
	arrowLeft: number;
	maxContentHeight: number;
};

export function computePreviewPlacement({
	screen,
	cardWidth,
	cardEstimatedHeight,
	cardChromeHeight = PREVIEW_CHROME_HEIGHT,
	viewportWidth = typeof window === "undefined" ? 1200 : window.innerWidth,
	viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight,
	gap = PREVIEW_GAP,
	viewportPadding = PREVIEW_VIEWPORT_PADDING,
	arrowMargin = PREVIEW_ARROW_MARGIN,
}: PreviewPlacementParams): PreviewPlacementResult {
	// Center horizontally relative to the triggering link, clamped within viewport bounds
	const rawLeft = screen.x - cardWidth / 2;
	const left = Math.round(
		Math.max(
			viewportPadding,
			Math.min(rawLeft, viewportWidth - cardWidth - viewportPadding),
		),
	);
	const arrowLeft = Math.round(
		Math.max(arrowMargin, Math.min(cardWidth - arrowMargin, screen.x - left)),
	);

	// Vertical placement: below link bottom by default, flip above link top if insufficient space
	const anchorBottom = screen.bottom ?? screen.y;
	const anchorTop = screen.top ?? screen.y;
	const spaceBelow = viewportHeight - anchorBottom - viewportPadding;
	const spaceAbove = anchorTop - viewportPadding;
	const neededHeight = cardEstimatedHeight + gap;
	const placeBelow = spaceBelow >= neededHeight || spaceBelow >= spaceAbove;
	const placement: "bottom" | "top" = placeBelow ? "bottom" : "top";

	const maxContentHeight = Math.max(
		PREVIEW_MIN_CONTENT_HEIGHT,
		Math.min(
			PREVIEW_MAX_CONTENT_HEIGHT,
			(placement === "bottom" ? spaceBelow : spaceAbove) -
				gap -
				cardChromeHeight,
		),
	);
	// The rendered card never exceeds its content cap plus chrome.
	const cardHeight = Math.min(
		cardEstimatedHeight,
		maxContentHeight + cardChromeHeight,
	);

	const top =
		placement === "bottom"
			? Math.round(
					Math.min(
						anchorBottom + gap,
						viewportHeight - cardHeight - viewportPadding,
					),
				)
			: undefined;
	const bottom =
		placement === "top"
			? Math.round(
					Math.min(
						viewportHeight - (anchorTop - gap),
						viewportHeight - cardHeight - viewportPadding,
					),
				)
			: undefined;

	return {
		placement,
		left,
		top,
		bottom,
		arrowLeft,
		maxContentHeight,
	};
}
