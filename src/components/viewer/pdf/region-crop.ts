import type {
	PdfDocumentObject,
	PdfEngine,
	PdfPageObject,
} from "@embedpdf/models";

import type { PromptImage } from "@/lib/agent";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
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

export async function renderPdfRegionPromptImage({
	engine,
	document,
	pageIndex,
	region,
	maxEdgePx = MAX_CROP_EDGE_PX,
}: {
	engine: PdfEngine;
	document: PdfDocumentObject;
	pageIndex: number;
	region: PdfAskNormalizedRect;
	/** Longest edge of the crop output in CSS pixels (default 1600). */
	maxEdgePx?: number;
}): Promise<PromptImage> {
	const page = document.pages[pageIndex];
	if (!page) throw new Error("PDF page is unavailable");
	const rect = normalizedRegionToPdfRect(region, page.size);
	if (!rect) throw new Error("PDF crop region is empty");
	const edge =
		Number.isFinite(maxEdgePx) && maxEdgePx > 0 ? maxEdgePx : MAX_CROP_EDGE_PX;
	const blob = await engine
		.renderPageRect(document, page, rect, {
			scaleFactor: cropScaleFactor(page, region, edge),
			imageType: "image/png",
			withAnnotations: false,
			withForms: false,
		})
		.toPromise();
	return blobToPromptImage(blob);
}
