/** Shared pin geometry for ask / annotate / translate anchors. */

import type { PdfTextRectObject, Size } from "@embedpdf/models";

import { clamp01 } from "@/lib/core/math";

export type NormalizedRect = {
	x: number;
	y: number;
	w: number;
	h: number;
};

export type PinSide = "left" | "right";

export type PinPlacement = {
	x: number;
	y: number;
	/** Which side of the selection the pin sits on. */
	side: PinSide;
};

/** Gap between selection edge and pin anchor (page fraction). */
const PIN_GAP = 0.014;
/** Pill size in page-normalized units (~24px on ~700px page). */
const PIN_W = 0.04;
const PIN_H = 0.032;
/** Min fraction of the pin area that must cover glyphs to count as over text. */
const MIN_TEXT_COVERAGE = 0.12;

/**
 * Convert EmbedPDF page text rects (PDF points) into 0–1 page fractions.
 * Skips empty / whitespace-only runs.
 */
export function normalizePageTextRects(
	rects: readonly PdfTextRectObject[],
	pageSize: Size,
): NormalizedRect[] {
	const pw = pageSize.width || 1;
	const ph = pageSize.height || 1;
	const out: NormalizedRect[] = [];
	for (const tr of rects) {
		const content = tr.content?.replace(/\s+/g, "") ?? "";
		if (!content) continue;
		const w = tr.rect.size.width / pw;
		const h = tr.rect.size.height / ph;
		if (w <= 0 || h <= 0) continue;
		out.push({
			x: clamp01(tr.rect.origin.x / pw),
			y: clamp01(tr.rect.origin.y / ph),
			w: clamp01(w),
			h: clamp01(h),
		});
	}
	return out;
}

/** Visual footprint of a side-anchored pin (matches SelectionGutter transform). */
function pinFootprint(pin: {
	x: number;
	y: number;
	side?: PinSide;
}): NormalizedRect {
	const y = pin.y - PIN_H / 2;
	if (pin.side === "left") {
		return { x: pin.x - PIN_W - 0.003, y, w: PIN_W, h: PIN_H };
	}
	return { x: pin.x + 0.003, y, w: PIN_W, h: PIN_H };
}

function overlapArea(a: NormalizedRect, b: NormalizedRect): number {
	const ol = Math.max(a.x, b.x);
	const or_ = Math.min(a.x + a.w, b.x + b.w);
	const ot = Math.max(a.y, b.y);
	const ob = Math.min(a.y + a.h, b.y + b.h);
	const ow = or_ - ol;
	const oh = ob - ot;
	if (ow <= 0 || oh <= 0) return 0;
	return ow * oh;
}

/**
 * True when the pin's visual footprint covers real page glyphs
 * (from PDFium `getPageTextRects`). No page text → false (solid default).
 */
export function pinObscuresBodyText(
	pin: { x: number; y: number; side?: PinSide },
	pageText?: readonly NormalizedRect[],
): boolean {
	if (!pageText?.length) return false;
	const foot = pinFootprint(pin);
	const pinArea = Math.max(foot.w * foot.h, 1e-9);
	let covered = 0;
	for (const t of pageText) {
		covered += overlapArea(foot, t);
		if (covered / pinArea >= MIN_TEXT_COVERAGE) return true;
	}
	return false;
}

/**
 * Place a pin on the side of the selection.
 * Prefer right; if that side covers glyphs (and page text is known), try left.
 */
export function pinFromRects(
	rects: NormalizedRect[],
	pageText?: readonly NormalizedRect[],
): PinPlacement {
	if (!rects.length) return { x: 0.5, y: 0.12, side: "right" };

	let minX = 1;
	let maxX = 0;
	let last = rects[0];
	for (const r of rects) {
		minX = Math.min(minX, r.x);
		maxX = Math.max(maxX, r.x + r.w);
		if (r.y + r.h > last.y + last.h + 1e-6) {
			last = r;
		} else if (
			Math.abs(r.y + r.h - (last.y + last.h)) <= 1e-6 &&
			r.x + r.w > last.x + last.w
		) {
			last = r;
		}
	}

	const y = Math.min(0.98, Math.max(0.02, last.y + last.h / 2));
	const rightX = Math.min(0.98, Math.max(0.02, maxX + PIN_GAP));
	const leftX = Math.min(0.98, Math.max(0.02, minX - PIN_GAP));
	const rightPin: PinPlacement = { x: rightX, y, side: "right" };
	const leftPin: PinPlacement = { x: leftX, y, side: "left" };

	const canRight = rightX + PIN_W * 0.5 <= 0.99;
	const canLeft = leftX - PIN_W * 0.5 >= 0.01;

	if (!pageText?.length) {
		return canRight ? rightPin : leftPin;
	}
	if (canRight && !pinObscuresBodyText(rightPin, pageText)) return rightPin;
	if (canLeft && !pinObscuresBodyText(leftPin, pageText)) return leftPin;
	return canRight ? rightPin : leftPin;
}
