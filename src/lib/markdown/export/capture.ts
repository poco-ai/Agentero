import { toPng } from "html-to-image";
import { jsPDF } from "jspdf";
import agenteroAppIconUrl from "@/assets/agentero-app-icon.svg";

const PNG_PIXEL_RATIO = 2;
/** A4 width in mm */
const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
/**
 * Bleed-to-edge layout: no page margins. White letterbox around dark notes was
 * caused by inset + jsPDF's default white page fill.
 */
const PAGE_MARGIN_MM = 0;
const WATERMARK_FONT_SIZE_PT = 9;
const WATERMARK_BOTTOM_INSET_MM = 8;
const WATERMARK_RIGHT_INSET_MM = 10;
/** Logo box height on PDF pages (mm). */
const WATERMARK_LOGO_MM = 4;
const WATERMARK_LOGO_GAP_MM = 1.2;

export type PdfExportOptions = {
	/** Drawn on every page, bottom-right. Empty/undefined = no watermark. */
	watermarkText?: string | null;
};

export async function captureElementPng(element: HTMLElement): Promise<string> {
	// Clone-free capture: node is already offscreen / opacity-0 but painted.
	return toPng(element, {
		cacheBust: true,
		pixelRatio: PNG_PIXEL_RATIO,
		backgroundColor: getComputedBackground(element),
		// Skip zero-size nodes that confuse the library.
		filter: (node) => {
			if (!(node instanceof HTMLElement)) return true;
			if (node.dataset.exportIgnore === "true") return false;
			return true;
		},
	});
}

function getComputedBackground(element: HTMLElement): string {
	const fromSelf = getComputedStyle(element).backgroundColor;
	if (
		fromSelf &&
		fromSelf !== "rgba(0, 0, 0, 0)" &&
		fromSelf !== "transparent"
	) {
		return fromSelf;
	}
	const body = getComputedStyle(document.body).backgroundColor;
	if (body && body !== "rgba(0, 0, 0, 0)" && body !== "transparent") {
		return body;
	}
	// Fallback for dark theme tokens that resolve late.
	const isDark = document.documentElement.classList.contains("dark");
	return isDark ? "#0a0a0a" : "#ffffff";
}

export function dataUrlToUint8Array(dataUrl: string): Uint8Array {
	const comma = dataUrl.indexOf(",");
	const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

type Rgb = { r: number; g: number; b: number };

/**
 * Resolve theme `muted-foreground` (secondary text) via a live probe so export
 * follows light/dark and tweakcn presets instead of hard-coded grays.
 */
function resolveMutedForegroundRgb(): Rgb {
	if (typeof document === "undefined") {
		return { r: 113, g: 113, b: 122 };
	}
	const probe = document.createElement("span");
	probe.className = "text-muted-foreground";
	probe.style.cssText =
		"position:fixed;left:-9999px;top:0;pointer-events:none;opacity:0";
	document.body.appendChild(probe);
	try {
		const color = getComputedStyle(probe).color;
		const m = color.match(
			/(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/,
		);
		if (m) {
			return {
				r: Math.round(Number(m[1])),
				g: Math.round(Number(m[2])),
				b: Math.round(Number(m[3])),
			};
		}
	} finally {
		probe.remove();
	}
	const dark = document.documentElement.classList.contains("dark");
	// Fallback approximates default shadcn muted-foreground.
	return dark ? { r: 161, g: 161, b: 170 } : { r: 113, g: 113, b: 122 };
}

let watermarkLogoPromise: Promise<HTMLImageElement | null> | null = null;

function loadWatermarkLogo(): Promise<HTMLImageElement | null> {
	if (!watermarkLogoPromise) {
		watermarkLogoPromise = loadImage(agenteroAppIconUrl).catch(() => null);
	}
	return watermarkLogoPromise;
}

/** Rasterize logo once for jsPDF (SVG is not a reliable addImage format). */
async function watermarkLogoPngDataUrl(sizePx = 64): Promise<string | null> {
	const logo = await loadWatermarkLogo();
	if (!logo) return null;
	const canvas = document.createElement("canvas");
	canvas.width = sizePx;
	canvas.height = sizePx;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.drawImage(logo, 0, 0, sizePx, sizePx);
	return canvas.toDataURL("image/png");
}

/**
 * Paint a bottom-right watermark onto a full-height PNG (single long image).
 * Logo (when available) sits before the label; text uses theme muted-foreground.
 */
export async function applyPngWatermark(
	pngDataUrl: string,
	text: string,
): Promise<string> {
	const trimmed = text.trim();
	if (!trimmed) return pngDataUrl;

	const img = await loadImage(pngDataUrl);
	const logo = await loadWatermarkLogo();
	const muted = resolveMutedForegroundRgb();
	const width = img.naturalWidth || img.width;
	const height = img.naturalHeight || img.height;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("export-canvas-unavailable");
	ctx.drawImage(img, 0, 0);

	const fontPx = Math.max(12, Math.round(11 * PNG_PIXEL_RATIO));
	const logoSize = Math.round(fontPx * 1.2);
	const gap = Math.round(fontPx * 0.35);
	const pad = Math.round(14 * PNG_PIXEL_RATIO);

	ctx.font = `500 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
	ctx.textAlign = "right";
	ctx.textBaseline = "bottom";
	const textWidth = ctx.measureText(trimmed).width;
	const right = width - pad;
	const bottom = height - pad;

	// Slightly soft secondary (not pure solid) for a quieter mark.
	ctx.fillStyle = `rgba(${muted.r},${muted.g},${muted.b},0.92)`;
	ctx.fillText(trimmed, right, bottom);

	if (logo) {
		const logoX = right - textWidth - gap - logoSize;
		const logoY = bottom - logoSize + Math.round(fontPx * 0.12);
		ctx.globalAlpha = 0.92;
		ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
		ctx.globalAlpha = 1;
	}

	return canvas.toDataURL("image/png");
}

function sampleImageTopLeftRgb(img: HTMLImageElement): Rgb {
	const sampleCanvas = document.createElement("canvas");
	sampleCanvas.width = 1;
	sampleCanvas.height = 1;
	const sampleCtx = sampleCanvas.getContext("2d");
	if (!sampleCtx) {
		const dark = document.documentElement.classList.contains("dark");
		return dark ? { r: 10, g: 10, b: 10 } : { r: 255, g: 255, b: 255 };
	}
	sampleCtx.drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1);
	const px = sampleCtx.getImageData(0, 0, 1, 1).data;
	return { r: px[0], g: px[1], b: px[2] };
}

/**
 * Slice a full-height PNG data URL into multi-page A4 PDF bytes.
 * Content is scaled to full page width (no side margins). Each page is filled
 * with the note background first so short last pages stay dark/light, not white.
 * Optional watermark is drawn on **every** page bottom-right.
 */
export async function pngDataUrlToPdfBytes(
	pngDataUrl: string,
	opts: PdfExportOptions = {},
): Promise<Uint8Array> {
	const img = await loadImage(pngDataUrl);
	const contentWidthMm = A4_WIDTH_MM - PAGE_MARGIN_MM * 2;
	const contentHeightMm = A4_HEIGHT_MM - PAGE_MARGIN_MM * 2;
	const pxPerMm = img.width / contentWidthMm;
	const pageHeightPx = contentHeightMm * pxPerMm;
	const watermarkText = opts.watermarkText?.trim() || "";
	const pageBg = sampleImageTopLeftRgb(img);
	const muted = resolveMutedForegroundRgb();
	const logoPng = watermarkText ? await watermarkLogoPngDataUrl(64) : null;

	const pdf = new jsPDF({
		orientation: "portrait",
		unit: "mm",
		format: "a4",
		compress: true,
	});

	let yPx = 0;
	let pageIndex = 0;
	while (yPx < img.height - 0.5) {
		const sliceHeightPx = Math.min(pageHeightPx, img.height - yPx);
		const sliceDataUrl = cropImageVertical(img, yPx, sliceHeightPx, pageBg);
		const sliceHeightMm = sliceHeightPx / pxPerMm;

		if (pageIndex > 0) pdf.addPage();

		// Paint full page with note background (kills white letterboxing).
		pdf.setFillColor(pageBg.r, pageBg.g, pageBg.b);
		pdf.rect(0, 0, A4_WIDTH_MM, A4_HEIGHT_MM, "F");

		pdf.addImage(
			sliceDataUrl,
			"PNG",
			PAGE_MARGIN_MM,
			PAGE_MARGIN_MM,
			contentWidthMm,
			sliceHeightMm,
			undefined,
			"FAST",
		);

		if (watermarkText) {
			drawPdfPageWatermark(pdf, watermarkText, logoPng, muted);
		}

		yPx += sliceHeightPx;
		pageIndex += 1;
		// Safety: avoid infinite loop on zero-height slices.
		if (sliceHeightPx < 1) break;
	}

	const arrayBuffer = pdf.output("arraybuffer");
	return new Uint8Array(arrayBuffer);
}

function drawPdfPageWatermark(
	pdf: jsPDF,
	text: string,
	logoPngDataUrl: string | null,
	muted: Rgb,
): void {
	pdf.setFont("helvetica", "normal");
	pdf.setFontSize(WATERMARK_FONT_SIZE_PT);
	// Theme muted-foreground as secondary color.
	pdf.setTextColor(muted.r, muted.g, muted.b);

	const xRight = A4_WIDTH_MM - WATERMARK_RIGHT_INSET_MM;
	const yBottom = A4_HEIGHT_MM - WATERMARK_BOTTOM_INSET_MM;
	const textWidth = pdf.getTextWidth(text);

	pdf.text(text, xRight, yBottom, {
		align: "right",
		baseline: "bottom",
	});

	if (logoPngDataUrl) {
		const logoX =
			xRight - textWidth - WATERMARK_LOGO_GAP_MM - WATERMARK_LOGO_MM;
		const logoY = yBottom - WATERMARK_LOGO_MM;
		pdf.addImage(
			logoPngDataUrl,
			"PNG",
			logoX,
			logoY,
			WATERMARK_LOGO_MM,
			WATERMARK_LOGO_MM,
		);
	}
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("export-image-load-failed"));
		img.src = src;
	});
}

/**
 * Vertical crop. Fills the canvas with `pageBg` first so any subpixel gaps
 * match the note theme instead of transparent/white.
 */
function cropImageVertical(
	img: HTMLImageElement,
	yPx: number,
	heightPx: number,
	pageBg: Rgb,
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
