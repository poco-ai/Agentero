import type { ScreenPoint } from "@/components/viewer/pdf/types";
/** Anchor native PDF previews to their reflowed link. */
export function textLinkHoverPoint(element: HTMLElement): ScreenPoint {
	const box = element.getBoundingClientRect();
	return {
		x: box.left + box.width / 2,
		y: box.bottom,
		top: box.top,
		bottom: box.bottom,
	};
}
