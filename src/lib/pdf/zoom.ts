export const PDF_ZOOM_MIN = 0.5;
export const PDF_ZOOM_MAX = 3;

/** Parse a user-entered percentage and clamp it to the viewer's zoom range. */
export function parsePdfZoomPercentage(value: string): number | null {
	const normalized = value.trim().replace(/%$/, "").trim();
	if (!normalized) return null;

	const percentage = Number(normalized);
	if (!Number.isFinite(percentage)) return null;

	return (
		Math.min(PDF_ZOOM_MAX * 100, Math.max(PDF_ZOOM_MIN * 100, percentage)) / 100
	);
}

/**
 * Preview scale for a zoom gesture (magnification relative to the zoom it
 * started from), kept inside the viewer range so the preview matches the zoom
 * that gets committed on release.
 */
export function clampZoomPreviewScale(scale: number, baseZoom: number): number {
	return Math.min(
		Math.max(scale, PDF_ZOOM_MIN / baseZoom),
		PDF_ZOOM_MAX / baseZoom,
	);
}

/**
 * Translate that keeps a point of the transformed element under the pointer.
 * Used with `transform-origin: 0 0` so a pinch scales around the fingers
 * instead of the viewport center; `localX` / `localY` are the pointer position
 * in the element's coordinate space before the transform is applied.
 */
export function zoomPreviewTranslate(
	localX: number,
	localY: number,
	scale: number,
): { x: number; y: number } {
	return { x: (1 - scale) * localX, y: (1 - scale) * localY };
}

/** Keep one decimal place when needed without showing a trailing `.0`. */
export function formatPdfZoomPercentage(zoom: number): string {
	const percentage = Math.round(zoom * 1000) / 10;
	return Number.isInteger(percentage)
		? String(percentage)
		: percentage.toFixed(1);
}
