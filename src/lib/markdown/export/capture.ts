/**
 * Raster capture + PNG watermark helpers for note export.
 * PDF assembly lives in `searchable-pdf.ts` (pdf-lib + text/link layers).
 */

import { toPng } from "html-to-image";
import agenteroAppIconUrl from "@/assets/agentero-app-icon.svg";

const PNG_PIXEL_RATIO = 2;

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
export function resolveMutedForegroundRgb(): Rgb {
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

/**
 * Paint a bottom-right watermark onto a full-height PNG (single long image).
 * Logo (when available) sits before the label; text uses theme muted-foreground.
 * Logo and label share one horizontal centerline.
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
	ctx.textBaseline = "middle";
	const textWidth = ctx.measureText(trimmed).width;
	const right = width - pad;
	const rowH = Math.max(logoSize, fontPx);
	const centerY = height - pad - rowH / 2;

	ctx.fillStyle = `rgba(${muted.r},${muted.g},${muted.b},0.92)`;
	ctx.fillText(trimmed, right, centerY);

	if (logo) {
		const logoX = right - textWidth - gap - logoSize;
		const logoY = centerY - logoSize / 2;
		ctx.globalAlpha = 0.92;
		ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
		ctx.globalAlpha = 1;
	}

	return canvas.toDataURL("image/png");
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("export-image-load-failed"));
		img.src = src;
	});
}
