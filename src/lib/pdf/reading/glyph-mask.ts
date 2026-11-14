/** PDF transparency leaves any paper rectangles drawn by the publisher intact.
 * Recover dark glyph coverage relative to the lightest painted paper pixel.
 * Existing transparent ink and crops containing only a dark stroke stay intact.
 */
export function removeGlyphPaper(rgba: Uint8ClampedArray): void {
	const light = (i: number) =>
		rgba[i] * 0.2126 + rgba[i + 1] * 0.7152 + rgba[i + 2] * 0.0722;
	let paper = 0;
	for (let i = 0; i < rgba.length; i += 4)
		if (rgba[i + 3] >= 240) paper = Math.max(paper, light(i));
	if (paper < 160) return;
	for (let i = 0; i < rgba.length; i += 4)
		rgba[i + 3] *= Math.max(0, 1 - light(i) / paper);
}

/** Encode raw PDFium pixels directly, without a PNG encode/decode round trip. */
export async function glyphMaskImageBlob(image: {
	data: Uint8ClampedArray<ArrayBuffer>;
	width: number;
	height: number;
}): Promise<Blob> {
	const canvas = document.createElement("canvas");
	try {
		canvas.width = image.width;
		canvas.height = image.height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("PDF glyph mask canvas is unavailable");
		removeGlyphPaper(image.data);
		context.putImageData(
			new ImageData(image.data, image.width, image.height),
			0,
			0,
		);
		return await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob(
				(result) =>
					result
						? resolve(result)
						: reject(new Error("PDF glyph mask encoding failed")),
				"image/png",
			),
		);
	} finally {
		canvas.width = canvas.height = 0;
	}
}

export async function glyphMaskBlob(blob: Blob): Promise<Blob> {
	const bitmap = await createImageBitmap(blob);
	let canvas: HTMLCanvasElement | undefined;
	try {
		canvas = document.createElement("canvas");
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("PDF glyph mask canvas is unavailable");
		context.drawImage(bitmap, 0, 0);
		const image = context.getImageData(0, 0, canvas.width, canvas.height);
		removeGlyphPaper(image.data);
		context.putImageData(image, 0, 0);
		return await new Promise<Blob>((resolve, reject) =>
			canvas?.toBlob(
				(result) =>
					result
						? resolve(result)
						: reject(new Error("PDF glyph mask encoding failed")),
				"image/png",
			),
		);
	} finally {
		bitmap.close();
		// Release the backing surface now rather than waiting for canvas GC.
		if (canvas) canvas.width = canvas.height = 0;
	}
}
