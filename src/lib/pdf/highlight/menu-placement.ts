import { clamp } from "@/lib/core/math";

export type HighlightMenuBox = {
	left: number;
	top: number;
	right: number;
	bottom: number;
};

export type HighlightMenuPlacement = {
	left: number;
	top: number;
	side: "below" | "above";
};

/** Right edge sits this far past the selection center, matching the collapsed bar. */
export const HIGHLIGHT_MENU_RIGHT_PIN = 68;

const DEFAULT_GAP = 6;
const DEFAULT_EDGE = 8;

function verticalOverlap(
	top: number,
	height: number,
	selection: HighlightMenuBox,
): number {
	const overlapTop = Math.max(top, selection.top);
	const overlapBottom = Math.min(top + height, selection.bottom);
	return Math.max(0, overlapBottom - overlapTop);
}

function visibleHeight(
	top: number,
	height: number,
	viewportHeight: number,
	edge: number,
): number {
	const visibleTop = Math.max(top, edge);
	const visibleBottom = Math.min(top + height, viewportHeight - edge);
	return Math.max(0, visibleBottom - visibleTop);
}

/**
 * Saved-highlight toolbar. Prefer below the selection. Flip above when that
 * side does not fit. Never slide the bar onto the selection to stay on screen.
 */
export function placeHighlightToolbar(options: {
	selection: HighlightMenuBox;
	menu: { width: number; height: number };
	viewport: { width: number; height: number };
	gap?: number;
	edge?: number;
}): HighlightMenuPlacement {
	const gap = options.gap ?? DEFAULT_GAP;
	const edge = options.edge ?? DEFAULT_EDGE;
	const { selection, menu, viewport } = options;
	const candidates = (["below", "above"] as const).map((side) => {
		const top =
			side === "below"
				? selection.bottom + gap
				: selection.top - gap - menu.height;
		const overlap = verticalOverlap(top, menu.height, selection);
		const fullyFits =
			top >= edge &&
			top + menu.height <= viewport.height - edge &&
			overlap === 0;
		return {
			side,
			top,
			overlap,
			fullyFits,
			visible: visibleHeight(top, menu.height, viewport.height, edge),
		};
	});
	const below = candidates[0];
	const above = candidates[1];
	if (!below || !above) {
		return { left: edge, top: edge, side: "below" };
	}
	const chosen = below.fullyFits
		? below
		: above.fullyFits
			? above
			: below.overlap === 0 &&
					(above.overlap > 0 || below.visible >= above.visible)
				? below
				: above.overlap === 0
					? above
					: below.overlap <= above.overlap
						? below
						: above;
	const center = (selection.left + selection.right) / 2;
	const maxLeft = Math.max(edge, viewport.width - edge - menu.width);
	const left = clamp(
		center + HIGHLIGHT_MENU_RIGHT_PIN - menu.width,
		edge,
		maxLeft,
	);
	return { left, top: chosen.top, side: chosen.side };
}

/** Union of on-screen highlight boxes. Empty and inverted boxes are ignored. */
export function unionHighlightBoxes(
	boxes: readonly HighlightMenuBox[],
): HighlightMenuBox | null {
	let box: HighlightMenuBox | null = null;
	for (const next of boxes) {
		if (!(next.right > next.left) || !(next.bottom > next.top)) continue;
		if (!box) {
			box = { ...next };
			continue;
		}
		box = {
			left: Math.min(box.left, next.left),
			top: Math.min(box.top, next.top),
			right: Math.max(box.right, next.right),
			bottom: Math.max(box.bottom, next.bottom),
		};
	}
	return box;
}
