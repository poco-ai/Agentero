import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";

export type PopoverScreenPoint = {
	x: number;
	y: number;
	/**
	 * Open the card on this side of the anchor. Matches the gutter pin so a
	 * left-side pin does not open a dialog on the far right of the selection.
	 */
	preferRight: boolean;
};

/**
 * Screen point next to the gutter pin for dialog placement.
 * Prefer the same side as the pin (right pin → open right; left → open left)
 * so the card sits close to the pin rather than the opposite edge of the rects.
 */
export function popoverScreenPoint(
	pageEl: HTMLElement | null,
	rects: PdfAskNormalizedRect[],
	pin?: { x: number; y: number; side?: "left" | "right" } | null,
): PopoverScreenPoint | null {
	if (!pageEl) return null;
	const box = pageEl.getBoundingClientRect();
	if (pin) {
		const preferRight = pin.side !== "left";
		// Small outward nudge so the card edge clears the pin pill.
		const nudge = preferRight ? 4 : -4;
		return {
			x: box.left + pin.x * box.width + nudge,
			y: box.top + pin.y * box.height - 8,
			preferRight,
		};
	}
	if (!rects.length) return null;
	let maxX = 0;
	let minY = 1;
	let maxY = 0;
	for (const r of rects) {
		maxX = Math.max(maxX, r.x + r.w);
		minY = Math.min(minY, r.y);
		maxY = Math.max(maxY, r.y + r.h);
	}
	return {
		x: box.left + Math.min(0.98, maxX + 0.008) * box.width + 4,
		y: box.top + ((minY + maxY) / 2) * box.height - 8,
		preferRight: true,
	};
}
