import type {
	PdfDocumentObject,
	PdfEngine,
	PdfPageObject,
} from "@embedpdf/models";

import type { PromptImage } from "@/lib/agent";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import {
	glyphMaskBlob,
	glyphMaskImageBlob,
} from "@/lib/pdf/reading/glyph-mask";
import { normalizedRegionToPdfRect } from "@/lib/pdf/region";

const MAX_CROP_EDGE_PX = 1600;

async function blobToPromptImage(blob: Blob): Promise<PromptImage> {
	const buffer = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < buffer.length; offset += chunkSize) {
		binary += String.fromCharCode(
			...buffer.subarray(offset, offset + chunkSize),
		);
	}
	return {
		data: btoa(binary),
		mimeType: blob.type || "image/png",
	};
}

function cropScaleFactor(
	page: PdfPageObject,
	region: PdfAskNormalizedRect,
	maxEdgePx: number,
) {
	const cropWidth = page.size.width * region.w;
	const cropHeight = page.size.height * region.h;
	const longestEdge = Math.max(cropWidth, cropHeight, 1);
	return Math.max(0.25, Math.min(2, maxEdgePx / longestEdge));
}

export async function renderPdfRegionImageBlob({
	engine,
	document,
	pageIndex,
	region,
	maxEdgePx = MAX_CROP_EDGE_PX,
	scaleFactor,
	transparentBackground,
}: {
	engine: PdfEngine;
	document: PdfDocumentObject;
	pageIndex: number;
	region: PdfAskNormalizedRect;
	/** Longest edge of the crop output in CSS pixels (default 1600). */
	maxEdgePx?: number;
	/**
	 * Preferred render scale (e.g. zoom × devicePixelRatio for a 1:1 preview).
	 * Still capped so the longest edge stays within `maxEdgePx`.
	 */
	scaleFactor?: number;
	/** Remove paper after compositing for inline mathematical glyph masks. */
	transparentBackground?: boolean;
}): Promise<Blob> {
	const page = document.pages[pageIndex];
	if (!page) throw new Error("PDF page is unavailable");
	const rect = normalizedRegionToPdfRect(region, page.size);
	if (!rect) throw new Error("PDF crop region is empty");
	const edge =
		Number.isFinite(maxEdgePx) && maxEdgePx > 0 ? maxEdgePx : MAX_CROP_EDGE_PX;
	const computedScale =
		scaleFactor != null && Number.isFinite(scaleFactor) && scaleFactor > 0
			? Math.min(
					scaleFactor,
					edge /
						Math.max(
							page.size.width * region.w,
							page.size.height * region.h,
							1,
						),
				)
			: cropScaleFactor(page, region, edge);
	const blob = await engine
		.renderPageRect(document, page, rect, {
			scaleFactor: computedScale,
			imageType: "image/png",
			withAnnotations: false,
			withForms: false,
			// Some PDFs lose dark glyphs on a transparent
			// PDFium surface. Composite normally, then remove paper below.
		})
		.toPromise();
	return transparentBackground ? glyphMaskBlob(blob) : blob;
}

export async function renderPdfRegionPromptImage(
	options: Parameters<typeof renderPdfRegionImageBlob>[0],
): Promise<PromptImage> {
	return blobToPromptImage(await renderPdfRegionImageBlob(options));
}

type CropOptions = Parameters<typeof renderPdfRegionImageBlob>[0];
// Shared surfaces are transient. Compressed crops, rather than page rasters,
// are retained by the reader cache. Do not grow a full-page zoom cache.
const MAX_BATCH_PIXELS = 4 * 1024 * 1024;

/** Neighboring glyph crops share PDF interpretation, then encode independently. */
export async function renderPdfGlyphBatch(
	options: CropOptions[],
): Promise<Blob[]> {
	if (!options.length) return [];
	const first = options[0];
	const page = first.document.pages[first.pageIndex];
	const scale = first.scaleFactor;
	if (
		!page ||
		!scale ||
		options.some(
			(o) =>
				o.engine !== first.engine ||
				o.document !== first.document ||
				o.pageIndex !== first.pageIndex ||
				o.scaleFactor !== scale ||
				!o.transparentBackground ||
				Math.max(
					o.region.w * page.size.width,
					o.region.h * page.size.height,
					1,
				) *
					scale >
					(o.maxEdgePx ?? MAX_CROP_EDGE_PX),
		)
	)
		return Promise.all(options.map(renderPdfRegionImageBlob));
	const rects = options.map((o) =>
		normalizedRegionToPdfRect(o.region, page.size),
	);
	if (rects.some((r) => !r)) throw new Error("PDF crop region is empty");
	const valid = rects.filter((r) => r !== null);
	const x = Math.min(...valid.map((r) => r.origin.x));
	const y = Math.min(...valid.map((r) => r.origin.y));
	const right = Math.max(...valid.map((r) => r.origin.x + r.size.width));
	const bottom = Math.max(...valid.map((r) => r.origin.y + r.size.height));
	const rect = {
		origin: { x, y },
		size: { width: right - x, height: bottom - y },
	};
	if (
		Math.ceil(rect.size.width * scale) * Math.ceil(rect.size.height * scale) >
		MAX_BATCH_PIXELS
	) {
		if (options.length === 1) return [await renderPdfRegionImageBlob(first)];
		const middle = Math.ceil(options.length / 2);
		// Sequential groups bound live raw surfaces even for a fast scroll.
		return [
			...(await renderPdfGlyphBatch(options.slice(0, middle))),
			...(await renderPdfGlyphBatch(options.slice(middle))),
		];
	}
	const pixels = await first.engine
		.renderPageRectRaw(first.document, page, rect, {
			scaleFactor: scale,
			withAnnotations: false,
			withForms: false,
		})
		.toPromise();
	const sx = pixels.width / rect.size.width;
	const sy = pixels.height / rect.size.height;
	return Promise.all(
		valid.map((r) => {
			const left = Math.max(0, Math.floor((r.origin.x - x) * sx));
			const top = Math.max(0, Math.floor((r.origin.y - y) * sy));
			const width = Math.min(
				pixels.width - left,
				Math.max(1, Math.ceil((r.origin.x + r.size.width - x) * sx) - left),
			);
			const height = Math.min(
				pixels.height - top,
				Math.max(1, Math.ceil((r.origin.y + r.size.height - y) * sy) - top),
			);
			const data = new Uint8ClampedArray(width * height * 4);
			for (let row = 0; row < height; row++) {
				const offset = ((top + row) * pixels.width + left) * 4;
				data.set(
					pixels.data.subarray(offset, offset + width * 4),
					row * width * 4,
				);
			}
			return glyphMaskImageBlob({ data, width, height });
		}),
	);
}
