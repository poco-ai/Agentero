/**
 * Color for a translated link token, taken from the original PDF ink.
 *
 * colorlinks paints the glyphs and leaves the annotation border at width 0.
 * The annotation `/C` can be a different hue from those glyphs (green border
 * metadata over a cyan-blue citation), so a visible border is only a fallback.
 * Translation glyphs sit outside the dark-paper raster filter and the sepia /
 * green multiply layer, so the stored hex is the raw PDF fill and the paper
 * tone is applied at paint time.
 */

import type { Rect } from "@embedpdf/models";
import { PDF_PAPER_TINT, type PdfPaperTone } from "@/lib/pdf/page-theme";

export type InkRun = {
	rect: Rect;
	color: { red: number; green: number; blue: number; alpha?: number };
};

export type LinkInkTarget = {
	key: string;
	rect: Rect;
	strokeColor?: string;
	strokeWidth?: number;
};

type Rgb = [number, number, number];

const DARK_INVERT = 0.84;
const DARK_CONTRAST = 0.9;

/** Same key `page-layers` uses for a plain-text URL hit target. */
export function translatedTextLinkKey(link: {
	url: string;
	rect: { origin: { x: number; y: number } };
}): string {
	return `text:${link.url}:${link.rect.origin.x}:${link.rect.origin.y}`;
}

function channel(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(255, Math.round(value)));
}

/** Near-black body ink and near-white paper are not a link highlight. */
export function isChromaticInk(
	red: number,
	green: number,
	blue: number,
): boolean {
	const max = Math.max(red, green, blue);
	const min = Math.min(red, green, blue);
	if (max < 48) return false;
	if (min > 220) return false;
	return max - min >= 28;
}

export function normalizeHex(value: string | undefined): string | null {
	if (!value) return null;
	const raw = value.trim().replace(/^#/, "");
	if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw)) return null;
	const hex =
		raw.length === 3
			? raw
					.split("")
					.map((part) => part + part)
					.join("")
			: raw;
	return `#${hex.toLowerCase()}`;
}

function hexOf(red: number, green: number, blue: number): string {
	const part = (value: number) => channel(value).toString(16).padStart(2, "0");
	return `#${part(red)}${part(green)}${part(blue)}`;
}

function parseHex(value: string): Rgb | null {
	const hex = normalizeHex(value);
	if (!hex) return null;
	return [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	];
}

function chromaticHex(color: InkRun["color"]): string | null {
	if (color.alpha != null && color.alpha < 16) return null;
	const red = channel(color.red);
	const green = channel(color.green);
	const blue = channel(color.blue);
	if (!isChromaticInk(red, green, blue)) return null;
	return hexOf(red, green, blue);
}

function intersectionArea(a: Rect, b: Rect): number {
	const width =
		Math.min(a.origin.x + a.size.width, b.origin.x + b.size.width) -
		Math.max(a.origin.x, b.origin.x);
	const height =
		Math.min(a.origin.y + a.size.height, b.origin.y + b.size.height) -
		Math.max(a.origin.y, b.origin.y);
	if (width <= 0 || height <= 0) return 0;
	return width * height;
}

function centerInside(inner: Rect, outer: Rect): boolean {
	const x = inner.origin.x + inner.size.width / 2;
	const y = inner.origin.y + inner.size.height / 2;
	return (
		x >= outer.origin.x &&
		x <= outer.origin.x + outer.size.width &&
		y >= outer.origin.y &&
		y <= outer.origin.y + outer.size.height
	);
}

function strokeInk(target: LinkInkTarget): string | null {
	if ((target.strokeWidth ?? 0) <= 0) return null;
	const hex = normalizeHex(target.strokeColor);
	if (!hex) return null;
	const rgb = parseHex(hex);
	if (!rgb || !isChromaticInk(rgb[0], rgb[1], rgb[2])) return null;
	return hex;
}

/**
 * Chromatic glyph fill that actually sits on the link. A zero-width border
 * does not contribute: its `/C` is often not the color on screen.
 */
export function inkForRect(
	runs: readonly InkRun[],
	target: LinkInkTarget,
): string | null {
	const link = target.rect;
	const linkArea = Math.max(0, link.size.width) * Math.max(0, link.size.height);
	const totals = new Map<string, number>();
	if (linkArea > 0) {
		for (const run of runs) {
			const hex = chromaticHex(run.color);
			if (!hex) continue;
			const overlap = intersectionArea(run.rect, link);
			if (overlap <= 0) continue;
			const onLink = centerInside(run.rect, link) || overlap >= linkArea * 0.15;
			if (!onLink) continue;
			totals.set(hex, (totals.get(hex) ?? 0) + overlap);
		}
	}
	let best: string | null = null;
	let bestArea = 0;
	for (const [hex, area] of totals) {
		if (area > bestArea) {
			best = hex;
			bestArea = area;
		}
	}
	return best ?? strokeInk(target);
}

export function inkForTargets(
	runs: readonly InkRun[],
	targets: readonly LinkInkTarget[],
): Map<string, string> {
	const ink = new Map<string, string>();
	for (const target of targets) {
		const color = inkForRect(runs, target);
		if (color) ink.set(target.key, color);
	}
	return ink;
}

function hueRotate180(red: number, green: number, blue: number): Rgb {
	const rad = Math.PI;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const matrix = [
		0.213 + cos * 0.787 - sin * 0.213,
		0.715 - cos * 0.715 - sin * 0.715,
		0.072 - cos * 0.072 + sin * 0.928,
		0.213 - cos * 0.213 + sin * 0.143,
		0.715 + cos * 0.285 + sin * 0.14,
		0.072 - cos * 0.072 - sin * 0.283,
		0.213 - cos * 0.213 - sin * 0.787,
		0.715 - cos * 0.715 + sin * 0.715,
		0.072 + cos * 0.928 + sin * 0.072,
	];
	return [
		matrix[0] * red + matrix[1] * green + matrix[2] * blue,
		matrix[3] * red + matrix[4] * green + matrix[5] * blue,
		matrix[6] * red + matrix[7] * green + matrix[8] * blue,
	];
}

/** Match `PDF_PAGE_RASTER_DARK_CLASS`: invert 0.84, hue-rotate 180, contrast 0.9. */
function darkPaperRgb(red: number, green: number, blue: number): Rgb {
	const inverted = [red, green, blue].map(
		(value) => value * (1 - DARK_INVERT) + (255 - value) * DARK_INVERT,
	) as Rgb;
	const rotated = hueRotate180(inverted[0], inverted[1], inverted[2]);
	return rotated.map((value) => {
		const contrasted = (value / 255 - 0.5) * DARK_CONTRAST * 255 + 127.5;
		return channel(contrasted);
	}) as Rgb;
}

function multiplyTint(rgb: Rgb, tint: string): Rgb {
	const parsed = parseHex(tint);
	if (!parsed) return rgb;
	return rgb.map((value, index) =>
		channel((value * (parsed[index] ?? 255)) / 255),
	) as Rgb;
}

/** Raw PDF hex as it should be painted on the translation glyphs for `tone`. */
export function linkColorOnPaper(hex: string, tone: PdfPaperTone): string {
	const rgb = parseHex(hex);
	if (!rgb) return hex;
	if (tone === "white") return hexOf(rgb[0], rgb[1], rgb[2]);
	if (tone === "dark") {
		const filtered = darkPaperRgb(rgb[0], rgb[1], rgb[2]);
		return hexOf(filtered[0], filtered[1], filtered[2]);
	}
	const tint = PDF_PAPER_TINT[tone];
	if (!tint) return hexOf(rgb[0], rgb[1], rgb[2]);
	const multiplied = multiplyTint(rgb, tint);
	return hexOf(multiplied[0], multiplied[1], multiplied[2]);
}
