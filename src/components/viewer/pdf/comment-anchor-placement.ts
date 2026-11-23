import { clamp } from "@/lib/core/math";
import type { PinPlacement } from "@/lib/pdf/selection/pin";

/**
 * Placement for note cards that open from a mark instead of stacking in the
 * page-outside rail: the in-place draft editor and the hover / editing card of
 * the gutter display mode.
 *
 * The card hangs from the mark's gutter pin, the way the ask / translate cards
 * open from theirs, so the pointer only travels a few pixels from the icon to
 * the note. It opens downward; when the reading area has no room below the pin
 * it grows upward from the pin, and in a reading area shorter than either it
 * overlays the pin's line. Either way the card stays inside the visible reading
 * area and scrolls its body instead of clipping.
 */

/** Card width in CSS px. */
export const ANCHORED_CARD_WIDTH_PX = 224;
/** SelectionGutter pill, edge to edge. */
const PIN_PILL_PX = 24;
/** Gap between the pill and the card. */
const PIN_CARD_GAP_PX = 6;
/**
 * Room for the three-line editor plus its padding. A side with less room than
 * this loses to the other side.
 */
const ANCHORED_CARD_MIN_HEIGHT_PX = 96;

export type AnchoredCardPlacement = {
	leftPx: number;
	widthPx: number;
	/** Distance from the page top; the card grows downward. */
	topPx?: number;
	/** Distance from the page bottom; the card grows upward. */
	bottomPx?: number;
	/** Tallest the card may get inside the visible reading area. */
	maxHeightPx: number;
};

type AnchoredCardInput = {
	pin: PinPlacement;
	pageWidthPx: number;
	pageHeightPx: number;
	/** Tallest the card may get regardless of room. */
	maxHeightPx: number;
	/** Visible reading area over this page, in page px; null while unknown. */
	viewport?: { top: number; bottom: number } | null;
	/**
	 * Space kept free on the card's far side from the pin, e.g. for the hover
	 * action bar. It comes out of the card's own height.
	 */
	reservePx?: number;
};

/** Inline styles carry these far; drop the float noise but keep sub-pixels. */
function px(value: number): number {
	return Math.round(value * 100) / 100;
}

export function placeAnchoredCard({
	pin,
	pageWidthPx,
	pageHeightPx,
	maxHeightPx,
	viewport = null,
	reservePx = 0,
}: AnchoredCardInput): AnchoredCardPlacement {
	const widthPx = Math.min(ANCHORED_CARD_WIDTH_PX, pageWidthPx);
	const pinX = pin.x * pageWidthPx;
	const pinY = pin.y * pageHeightPx;
	// A left-side pill hangs left of its anchor, so the card starts at it.
	const wantedLeft = pin.side === "left" ? pinX : pinX + PIN_PILL_PX - widthPx;
	const leftPx = px(clamp(wantedLeft, 0, pageWidthPx - widthPx));
	const top = Math.max(0, viewport?.top ?? 0);
	const bottom = Math.min(pageHeightPx, viewport?.bottom ?? pageHeightPx);
	const cap = Math.max(0, Math.min(maxHeightPx, bottom - top - reservePx));
	const minH = Math.min(ANCHORED_CARD_MIN_HEIGHT_PX, cap);
	const edge = PIN_PILL_PX / 2 + PIN_CARD_GAP_PX;
	const roomBelow = bottom - reservePx - (pinY + edge);
	const roomAbove = pinY - edge - (top + reservePx);
	if (roomBelow >= minH || roomBelow >= roomAbove) {
		const topPx = clamp(pinY + edge, top, bottom - reservePx - minH);
		return {
			leftPx,
			widthPx,
			topPx: px(topPx),
			maxHeightPx: px(clamp(bottom - reservePx - topPx, minH, cap)),
		};
	}
	const cardBottom = clamp(pinY - edge, top + reservePx + minH, bottom);
	return {
		leftPx,
		widthPx,
		bottomPx: px(pageHeightPx - cardBottom),
		maxHeightPx: px(clamp(cardBottom - top - reservePx, minH, cap)),
	};
}
