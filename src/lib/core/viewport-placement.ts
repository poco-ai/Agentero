import { clamp } from "@/lib/core/math";

export type ViewportPoint = {
	x: number;
	y: number;
};

export type ViewportSize = {
	width: number;
	height: number;
};

export type FloatingSide = "top" | "bottom";

export type ViewportFloatingPlacement = {
	left: number;
	top: number;
	maxHeight: number;
	maxWidth: number;
	side: FloatingSide;
};

type PlaceViewportFloatingOptions = {
	point: ViewportPoint;
	element: ViewportSize;
	viewport: ViewportSize;
	side?: FloatingSide;
	offset?: number;
	edge?: number;
};

/**
 * Position a measured floating element inside the current viewport. When the
 * preferred side has insufficient room, use the opposite side before clamping.
 */
export function placeViewportFloating({
	point,
	element,
	viewport,
	side = "bottom",
	offset = 0,
	edge = 8,
}: PlaceViewportFloatingOptions): ViewportFloatingPlacement {
	const maxWidth = Math.max(0, viewport.width - edge * 2);
	const maxHeight = Math.max(0, viewport.height - edge * 2);
	const width = Math.min(element.width, maxWidth);
	const height = Math.min(element.height, maxHeight);
	const belowTop = point.y + offset;
	const aboveTop = point.y - offset - height;
	const belowFits = belowTop + height <= viewport.height - edge;
	const aboveFits = aboveTop >= edge;

	const resolvedSide =
		side === "bottom"
			? belowFits || !aboveFits
				? "bottom"
				: "top"
			: aboveFits || !belowFits
				? "top"
				: "bottom";
	const desiredTop = resolvedSide === "bottom" ? belowTop : aboveTop;

	return {
		left: clamp(point.x, edge, Math.max(edge, viewport.width - edge - width)),
		top: clamp(
			desiredTop,
			edge,
			Math.max(edge, viewport.height - edge - height),
		),
		maxHeight,
		maxWidth,
		side: resolvedSide,
	};
}
