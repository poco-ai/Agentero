const MAX_PAGE_PIXELS = 4 * 1024 * 1024;
const MAX_PAGE_EDGE = 4096;

/** Bound whole-page RGBA before PDFium allocates the bitmap. Tiles are independent. */
export function capPdfRasterScale(
	{ width, height }: { width: number; height: number },
	scale: number,
	dpr: number,
): number {
	if (!(width > 0 && height > 0)) return scale;
	// PDFium may round each raster dimension up to a whole pixel.
	const pixelScale = Math.min(
		Math.sqrt((MAX_PAGE_PIXELS - 2 * MAX_PAGE_EDGE) / (width * height)),
		(MAX_PAGE_EDGE - 1) / Math.max(width, height),
	);
	return Math.min(scale, pixelScale / dpr);
}
