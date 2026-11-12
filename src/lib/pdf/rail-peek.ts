/**
 * Geometry for revealing the page-outside comment rail by panning the reader.
 *
 * The reading surface reserves no space for comment cards: the card column
 * lives outside the page's right edge, so at fit-width it sits just beyond the
 * viewport. Hovering the right edge pans the viewport horizontally just far
 * enough to show that column, and pans back afterwards. Only a viewport scroll
 * changes; page width, fit-width zoom and the zoom anchor stay untouched.
 */

export type RailPeekDeltaInput = {
	/** Screen x of the page's right edge. */
	pageRight: number;
	/** Screen x of the viewport's right edge. */
	viewportRight: number;
	/** Outer width of the card column (card + gap + bleed). */
	railWidth: number;
	/** Clearance kept between the revealed rail and the viewport edge. */
	margin: number;
	/**
	 * Largest pan that still reads as a peek. A page wider than this has its
	 * right edge far outside the viewport (the reader is zoomed in and panning
	 * deliberately); hovering must not yank the view across it.
	 */
	maxPan: number;
};

/**
 * Horizontal scroll delta that brings the rail fully into view, or `null` when
 * no pan is needed (rail already visible) or when it would be a jump.
 */
export function railPeekScrollDelta({
	pageRight,
	viewportRight,
	railWidth,
	margin,
	maxPan,
}: RailPeekDeltaInput): number | null {
	if (!Number.isFinite(pageRight) || !Number.isFinite(viewportRight)) {
		return null;
	}
	const delta = pageRight + railWidth + margin - viewportRight;
	if (delta <= 1 || delta > maxPan) return null;
	return delta;
}

export type RailPeekKeepsOpenInput = {
	/** Pointer position in screen coordinates. */
	x: number;
	y: number;
	/** Scrollport bounds in screen coordinates. */
	viewport: { left: number; right: number; top: number; bottom: number };
	revealed: boolean;
	/** Strip along the viewport's right edge that also arms the peek. */
	edge: number;
	/** Width of the revealed card column, measured left from the viewport edge. */
	railColumn: number;
	/** Vertical span of the visible cards; null when none is on screen. */
	cards: { top: number; bottom: number } | null;
	/** Vertical slack so moving between stacked cards does not retract. */
	halo: number;
};

/**
 * Whether the pointer still belongs to the peeked comment column.
 *
 * Keep-open has an X and a Y component: the right-edge strip always qualifies
 * (that is how the rail is summoned), and the revealed card column qualifies
 * only within the vertical span of the cards on screen. Sliding up or down out
 * of that span counts as leaving even though the pointer is still over the
 * column's x-range, so the rail does not stay open for the whole panel height.
 */
export function railPeekKeepsOpen({
	x,
	y,
	viewport,
	revealed,
	edge,
	railColumn,
	cards,
	halo,
}: RailPeekKeepsOpenInput): boolean {
	if (x < viewport.left || x > viewport.right) return false;
	if (y < viewport.top || y > viewport.bottom) return false;
	if (x >= viewport.right - edge) return true;
	if (!revealed || !cards) return false;
	if (x < viewport.right - edge - railColumn) return false;
	return y >= cards.top - halo && y <= cards.bottom + halo;
}
