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

/**
 * Width left for the page after the viewport's own padding. The right padding
 * includes the comment rail, so this is the reading box fit-width uses.
 */
export function zoomReadingWidth(
	clientWidth: number,
	paddingLeft: number,
	paddingRight: number,
): number {
	if (!(clientWidth > 0)) return 0;
	return Math.max(0, clientWidth - paddingLeft - paddingRight);
}

/**
 * Left margin that centers the gesture element inside the reading box.
 * Zero once the page fills that box, so a zoom commit does not collapse a
 * margin that was only there because the rail was left out of the box.
 */
export function zoomGestureCenteringMargin(
	elementWidth: number,
	readingWidth: number,
): number {
	if (!(elementWidth > 0) || !(readingWidth > elementWidth)) return 0;
	return (readingWidth - elementWidth) / 2;
}

/**
 * Follow the reader's centered-page geometry while the document is narrower
 * than its reading area, then blend to the gesture point as it overflows.
 */
export function zoomPreviewTranslateForViewport(
	localX: number,
	localY: number,
	scale: number,
	elementWidth: number,
	viewportWidth: number,
): { x: number; y: number } {
	const pointer = zoomPreviewTranslate(localX, localY, scale);
	if (!(elementWidth > 0) || !(viewportWidth > 0)) return pointer;

	const centeredX = (1 - scale) * (elementWidth / 2);
	const overflow = Math.max(0, elementWidth * scale - viewportWidth);
	const blend = Math.min(1, overflow / (viewportWidth * 0.3));
	return {
		x: centeredX + (pointer.x - centeredX) * blend,
		y: pointer.y,
	};
}

/** Step the viewer zoom by 10 percentage points, staying inside the range. */
export function stepPdfZoom(zoom: number, direction: -1 | 1): number {
	const next = Math.round((zoom + direction * 0.1) * 100) / 100;
	return Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, next));
}

/** Keep one decimal place when needed without showing a trailing `.0`. */
export function formatPdfZoomPercentage(zoom: number): string {
	const percentage = Math.round(zoom * 1000) / 10;
	return Number.isInteger(percentage)
		? String(percentage)
		: percentage.toFixed(1);
}
