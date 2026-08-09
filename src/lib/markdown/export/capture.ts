import { toPng } from "html-to-image";
import { jsPDF } from "jspdf";

const PNG_PIXEL_RATIO = 2;
/** A4 width in mm */
const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
const PAGE_MARGIN_MM = 12;

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

/**
 * Slice a full-height PNG data URL into multi-page A4 PDF bytes.
 * Image is scaled to content width (page width minus margins).
 */
export async function pngDataUrlToPdfBytes(
	pngDataUrl: string,
): Promise<Uint8Array> {
	const img = await loadImage(pngDataUrl);
	const contentWidthMm = A4_WIDTH_MM - PAGE_MARGIN_MM * 2;
	const contentHeightMm = A4_HEIGHT_MM - PAGE_MARGIN_MM * 2;
	const pxPerMm = img.width / contentWidthMm;
	const pageHeightPx = contentHeightMm * pxPerMm;

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
		const sliceDataUrl = cropImageVertical(img, yPx, sliceHeightPx);
		const sliceHeightMm = sliceHeightPx / pxPerMm;

		if (pageIndex > 0) pdf.addPage();
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

		yPx += sliceHeightPx;
		pageIndex += 1;
		// Safety: avoid infinite loop on zero-height slices.
		if (sliceHeightPx < 1) break;
	}

	const arrayBuffer = pdf.output("arraybuffer");
	return new Uint8Array(arrayBuffer);
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("export-image-load-failed"));
		img.src = src;
	});
}

function cropImageVertical(
	img: HTMLImageElement,
	yPx: number,
	heightPx: number,
): string {
	const canvas = document.createElement("canvas");
	const width = img.naturalWidth || img.width;
	const height = Math.max(1, Math.ceil(heightPx));
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("export-canvas-unavailable");
	ctx.drawImage(img, 0, yPx, width, height, 0, 0, width, height);
	return canvas.toDataURL("image/png");
}
