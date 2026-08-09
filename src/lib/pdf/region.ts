import type { Rect, Size } from "@embedpdf/models";

import { clamp01 } from "@/lib/core/math";

import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";

const MIN_REGION_SIZE = 0.005;
const DEFAULT_REGION_PADDING = 0.015;

export function normalizedRegionFromPoints(
	start: { x: number; y: number },
	end: { x: number; y: number },
): PdfAskNormalizedRect | null {
	const left = clamp01(Math.min(start.x, end.x));
	const top = clamp01(Math.min(start.y, end.y));
	const right = clamp01(Math.max(start.x, end.x));
	const bottom = clamp01(Math.max(start.y, end.y));
	const width = right - left;
	const height = bottom - top;
	if (width < MIN_REGION_SIZE || height < MIN_REGION_SIZE) return null;
	return { x: left, y: top, w: width, h: height };
}

export function unionNormalizedRegions(
	regions: PdfAskNormalizedRect[],
): PdfAskNormalizedRect | null {
	const valid = regions.filter(
		(region) =>
			Number.isFinite(region.x) &&
			Number.isFinite(region.y) &&
			Number.isFinite(region.w) &&
			Number.isFinite(region.h) &&
			region.w > 0 &&
			region.h > 0,
	);
	if (!valid.length) return null;
	const left = clamp01(Math.min(...valid.map((region) => region.x)));
	const top = clamp01(Math.min(...valid.map((region) => region.y)));
	const right = clamp01(
		Math.max(...valid.map((region) => region.x + region.w)),
	);
	const bottom = clamp01(
		Math.max(...valid.map((region) => region.y + region.h)),
	);
	return {
		x: left,
		y: top,
		w: Math.max(0, right - left),
		h: Math.max(0, bottom - top),
	};
}

export function expandNormalizedRegion(
	region: PdfAskNormalizedRect,
	padding = DEFAULT_REGION_PADDING,
): PdfAskNormalizedRect {
	const safePadding = Number.isFinite(padding) ? Math.max(0, padding) : 0;
	const left = clamp01(region.x - safePadding);
	const top = clamp01(region.y - safePadding);
	const right = clamp01(region.x + region.w + safePadding);
	const bottom = clamp01(region.y + region.h + safePadding);
	return {
		x: left,
		y: top,
		w: Math.max(0, right - left),
		h: Math.max(0, bottom - top),
	};
}

export function normalizedRegionToPdfRect(
	region: PdfAskNormalizedRect,
	pageSize: Size,
): Rect | null {
	if (pageSize.width <= 0 || pageSize.height <= 0) return null;
	const left = clamp01(region.x);
	const top = clamp01(region.y);
	const right = clamp01(region.x + region.w);
	const bottom = clamp01(region.y + region.h);
	const width = (right - left) * pageSize.width;
	const height = (bottom - top) * pageSize.height;
	if (width <= 0 || height <= 0) return null;
	return {
		origin: {
			x: left * pageSize.width,
			y: top * pageSize.height,
		},
		size: { width, height },
	};
}
