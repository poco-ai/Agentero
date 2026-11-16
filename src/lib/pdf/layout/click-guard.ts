/**
 * A click on a layout element opens its action view, so a gesture that merely
 * *started* inside the region — a text-selection drag, a pan, a slip of the
 * hand — must not activate it. Browsers fire `click` whenever pointerdown and
 * pointerup land on the same element, no matter how far the pointer travelled
 * in between, so the travel has to be checked explicitly.
 */

/** Maximum pointer travel (px) that still counts as a click, not a drag. */
export const LAYOUT_REGION_CLICK_MOVE_TOLERANCE_PX = 6;

export type PointerOrigin = { x: number; y: number };

export type LayoutRegionActivation = {
	/** `MouseEvent.detail`; 0 means keyboard (Enter / Space) — no travel to check. */
	detail: number;
	/** Position recorded on pointerdown; null when no pointer gesture preceded. */
	origin: PointerOrigin | null;
	/** Position at click time. */
	end: PointerOrigin;
};

/** True when the activation should crop the region. */
export function isLayoutRegionActivation(
	activation: LayoutRegionActivation,
	tolerance: number = LAYOUT_REGION_CLICK_MOVE_TOLERANCE_PX,
): boolean {
	// Keyboard activation must always pass: it has no pointer origin.
	if (activation.detail === 0) return true;
	if (!activation.origin) return false;
	const dx = activation.end.x - activation.origin.x;
	const dy = activation.end.y - activation.origin.y;
	return Math.hypot(dx, dy) <= tolerance;
}
