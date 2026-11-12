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

export type RailPeekBandInput = {
	revealed: boolean;
	/** Strip along the viewport's right edge that arms the peek. */
	edge: number;
	railWidth: number;
	margin: number;
};

/**
 * Pointer band that keeps the peek open. Before the reveal it is the edge
 * strip; once revealed it grows to cover the card column, so moving onto a
 * card (or typing into it) does not retract the rail from under the pointer.
 */
export function railPeekBandWidth({
	revealed,
	edge,
	railWidth,
	margin,
}: RailPeekBandInput): number {
	return revealed ? edge + railWidth + margin : edge;
}
