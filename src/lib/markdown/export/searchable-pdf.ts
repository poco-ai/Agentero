/**
 * Build a multi-page A4 PDF that keeps the visual raster (embeds, KaTeX, …)
 * while adding:
 * - an invisible selectable text layer (DOM-measured runs + embedded CJK font)
 * - clickable URI link annotations
 * - optional per-page watermark (logo + muted label)
 *
 * Coordinate rule: slicing and drawing scale from **PNG pixel space**
 * (`html-to-image` may use pixelRatio > 1). DOM text-layer metrics are CSS px
 * and must be converted with the same ratio — mixing the two caused 2× zoom
 * and broken layout.
 */

import fontkit from "@pdf-lib/fontkit";
import {
	type PDFDocument,
	type PDFFont,
	type PDFImage,
	PDFDocument as PDFLibDocument,
	type PDFPage,
	PDFString,
	rgb,
	StandardFonts,
} from "pdf-lib";
import agenteroAppIconUrl from "@/assets/agentero-app-icon.svg";
import type { ExportTextLayer } from "@/lib/markdown/export/text-layer";

/** A4 in PDF points (1/72"). */
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const WATERMARK_FONT_SIZE_PT = 9;
const WATERMARK_BOTTOM_INSET_PT = 22;
const WATERMARK_RIGHT_INSET_PT = 28;
const WATERMARK_LOGO_PT = 11;
const WATERMARK_LOGO_GAP_PT = 3.5;

export type SearchablePdfOptions = {
	/** Full-height PNG data URL of the export surface. */
	pngDataUrl: string;
	textLayer: ExportTextLayer;
	/** Optional watermark label; empty = none. */
	watermarkText?: string | null;
	/** System CJK (or Unicode) font bytes from Host; optional. */
	fontBytes?: Uint8Array | null;
	/** Theme muted-foreground for watermark. */
	mutedRgb?: { r: number; g: number; b: number };
};

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
	const comma = dataUrl.indexOf(",");
	const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("export-image-load-failed"));
		img.src = src;
	});
}

async function loadWatermarkLogoPng(sizePx = 64): Promise<Uint8Array | null> {
	try {
		const logo = await loadImage(agenteroAppIconUrl);
		const canvas = document.createElement("canvas");
		canvas.width = sizePx;
		canvas.height = sizePx;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(logo, 0, 0, sizePx, sizePx);
		return dataUrlToUint8Array(canvas.toDataURL("image/png"));
	} catch {
		return null;
	}
}

function cropImageVertical(
	img: HTMLImageElement,
	yPx: number,
	heightPx: number,
	pageBg: { r: number; g: number; b: number },
): string {
	const canvas = document.createElement("canvas");
	const width = img.naturalWidth || img.width;
	const height = Math.max(1, Math.ceil(heightPx));
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("export-canvas-unavailable");
	ctx.fillStyle = `rgb(${pageBg.r},${pageBg.g},${pageBg.b})`;
	ctx.fillRect(0, 0, width, height);
	ctx.drawImage(img, 0, yPx, width, height, 0, 0, width, height);
	return canvas.toDataURL("image/png");
}

function sampleTopLeftRgb(img: HTMLImageElement): {
	r: number;
	g: number;
	b: number;
} {
	const c = document.createElement("canvas");
	c.width = 1;
	c.height = 1;
	const ctx = c.getContext("2d");
	if (!ctx) return { r: 255, g: 255, b: 255 };
	ctx.drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1);
	const px = ctx.getImageData(0, 0, 1, 1).data;
	return { r: px[0], g: px[1], b: px[2] };
}

function addLinkAnnotation(
	pdfDoc: PDFDocument,
	page: PDFPage,
	rect: { x: number; y: number; width: number; height: number },
	url: string,
): void {
	const annot = pdfDoc.context.register(
		pdfDoc.context.obj({
			Type: "Annot",
			Subtype: "Link",
			Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
			Border: [0, 0, 0],
			A: {
				Type: "Action",
				S: "URI",
				URI: PDFString.of(url),
			},
		}),
	);
	page.node.addAnnot(annot);
}

/**
 * Create searchable multi-page A4 PDF bytes from a full-height capture + DOM layer.
 */
export async function buildSearchablePdf(
	opts: SearchablePdfOptions,
): Promise<Uint8Array> {
	const img = await loadImage(opts.pngDataUrl);
	const imgW = Math.max(1, img.naturalWidth || img.width);
	const imgH = Math.max(1, img.naturalHeight || img.height);
	const pageBg = sampleTopLeftRgb(img);

	// DOM metrics are CSS px; raster may be pixelRatio× larger.
	const surfaceW = Math.max(1, opts.textLayer.surfaceWidth || imgW);
	const surfaceH = Math.max(1, opts.textLayer.surfaceHeight || imgH);
	const cssToImgX = imgW / surfaceW;
	const cssToImgY = imgH / surfaceH;

	// All paging math is in **image pixel** space → PDF points.
	const imgPxToPt = A4_WIDTH_PT / imgW;
	const pageHeightImgPx = A4_HEIGHT_PT / imgPxToPt;

	const pdfDoc = await PDFLibDocument.create();
	pdfDoc.registerFontkit(fontkit);

	let font: PDFFont;
	if (opts.fontBytes && opts.fontBytes.byteLength > 0) {
		try {
			font = await pdfDoc.embedFont(opts.fontBytes, { subset: true });
		} catch {
			font = await pdfDoc.embedFont(StandardFonts.Helvetica);
		}
	} else {
		font = await pdfDoc.embedFont(StandardFonts.Helvetica);
	}

	const watermarkText = opts.watermarkText?.trim() || "";
	const muted = opts.mutedRgb ?? { r: 113, g: 113, b: 122 };
	const logoBytes = watermarkText ? await loadWatermarkLogoPng(64) : null;
	const logoImage: PDFImage | null = logoBytes
		? await pdfDoc.embedPng(logoBytes)
		: null;

	let yImg = 0;
	let pageIndex = 0;
	while (yImg < imgH - 0.5) {
		const sliceHImg = Math.min(pageHeightImgPx, imgH - yImg);
		const sliceDataUrl = cropImageVertical(img, yImg, sliceHImg, pageBg);
		const sliceHeightPt = sliceHImg * imgPxToPt;
		const pageTopImg = yImg;
		const pageBottomImg = yImg + sliceHImg;

		const page = pdfDoc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);

		page.drawRectangle({
			x: 0,
			y: 0,
			width: A4_WIDTH_PT,
			height: A4_HEIGHT_PT,
			color: rgb(pageBg.r / 255, pageBg.g / 255, pageBg.b / 255),
		});

		const png = await pdfDoc.embedPng(dataUrlToUint8Array(sliceDataUrl));
		// 1:1 letterbox-free: full width, proportional height (no extra vertical zoom).
		page.drawImage(png, {
			x: 0,
			y: A4_HEIGHT_PT - sliceHeightPt,
			width: A4_WIDTH_PT,
			height: sliceHeightPt,
		});

		for (const run of opts.textLayer.runs) {
			const text = run.text;
			if (!text.trim()) continue;

			const xImg = run.x * cssToImgX;
			const yImgRun = run.y * cssToImgY;
			const hImg = run.height * cssToImgY;
			const wImg = run.width * cssToImgX;
			const fontImg = run.fontSize * cssToImgY;
			const midY = yImgRun + hImg / 2;
			if (midY < pageTopImg || midY >= pageBottomImg) continue;

			const sizePt = Math.max(5, fontImg * imgPxToPt);
			const xPt = xImg * imgPxToPt;
			// Baseline near the visual bottom of the line box (CSS top → PDF bottom-up).
			const yFromTopOnPage = yImgRun + fontImg * 0.82 - pageTopImg;
			const yPt = A4_HEIGHT_PT - yFromTopOnPage * imgPxToPt;

			try {
				// No maxWidth: never reflow — one glyph string at DOM-measured position.
				// opacity 0 keeps the raster as the only visible layer.
				page.drawText(text.replace(/\s+/g, " "), {
					x: xPt,
					y: yPt,
					size: sizePt,
					font,
					color: rgb(0, 0, 0),
					opacity: 0,
				});
			} catch {
				// Missing glyphs / embed limits — skip run.
			}
			void wImg;
		}

		for (const link of opts.textLayer.links) {
			const xImg = link.x * cssToImgX;
			const yImgLink = link.y * cssToImgY;
			const wImg = link.width * cssToImgX;
			const hImg = link.height * cssToImgY;
			const midY = yImgLink + hImg / 2;
			if (midY < pageTopImg || midY >= pageBottomImg) continue;

			let href = link.href;
			if (!/^(https?:|mailto:)/i.test(href) && !href.startsWith("//")) {
				if (/^www\./i.test(href)) href = `https://${href}`;
				else continue;
			}
			if (href.startsWith("//")) href = `https:${href}`;

			const xPt = xImg * imgPxToPt;
			const wPt = Math.max(4, wImg * imgPxToPt);
			const hPt = Math.max(4, hImg * imgPxToPt);
			const yFromTopOnPage = yImgLink - pageTopImg;
			const yPt = A4_HEIGHT_PT - (yFromTopOnPage + hImg) * imgPxToPt;

			addLinkAnnotation(
				pdfDoc,
				page,
				{ x: xPt, y: yPt, width: wPt, height: hPt },
				href,
			);
		}

		if (watermarkText) {
			drawWatermark(page, font, watermarkText, logoImage, muted);
		}

		yImg += sliceHImg;
		pageIndex += 1;
		if (sliceHImg < 1 || pageIndex > 500) break;
	}

	return pdfDoc.save();
}

function drawWatermark(
	page: PDFPage,
	font: PDFFont,
	text: string,
	logoImage: PDFImage | null,
	muted: { r: number; g: number; b: number },
): void {
	const color = rgb(muted.r / 255, muted.g / 255, muted.b / 255);
	const textWidth = font.widthOfTextAtSize(text, WATERMARK_FONT_SIZE_PT);
	const xRight = A4_WIDTH_PT - WATERMARK_RIGHT_INSET_PT;
	// pdf-lib y is baseline (bottom-up). Align logo + label on one horizontal centerline.
	const textVisualH = WATERMARK_FONT_SIZE_PT * 0.72;
	const rowH = Math.max(WATERMARK_LOGO_PT, textVisualH);
	const centerY = WATERMARK_BOTTOM_INSET_PT + rowH / 2;
	// Latin metrics: visual center sits ~0.35×size above the baseline.
	const textBaselineY = centerY - WATERMARK_FONT_SIZE_PT * 0.35;
	const logoY = centerY - WATERMARK_LOGO_PT / 2;

	page.drawText(text, {
		x: xRight - textWidth,
		y: textBaselineY,
		size: WATERMARK_FONT_SIZE_PT,
		font,
		color,
		opacity: 0.92,
	});

	if (logoImage) {
		const logoX =
			xRight - textWidth - WATERMARK_LOGO_GAP_PT - WATERMARK_LOGO_PT;
		page.drawImage(logoImage, {
			x: logoX,
			y: logoY,
			width: WATERMARK_LOGO_PT,
			height: WATERMARK_LOGO_PT,
			opacity: 0.92,
		});
	}
}
