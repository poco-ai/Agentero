import { describe, expect, it } from "vitest";

import {
	clampZoomPreviewScale,
	formatPdfZoomPercentage,
	parsePdfZoomPercentage,
	zoomPreviewTranslate,
} from "@/lib/pdf/zoom";

describe("parsePdfZoomPercentage", () => {
	it("accepts precise percentages with an optional percent sign", () => {
		expect(parsePdfZoomPercentage("112.5")).toBe(1.125);
		expect(parsePdfZoomPercentage(" 125% ")).toBe(1.25);
	});

	it("clamps percentages to the supported viewer range", () => {
		expect(parsePdfZoomPercentage("25")).toBe(0.5);
		expect(parsePdfZoomPercentage("450")).toBe(3);
	});

	it("rejects empty and non-numeric input", () => {
		expect(parsePdfZoomPercentage("")).toBeNull();
		expect(parsePdfZoomPercentage("%")).toBeNull();
		expect(parsePdfZoomPercentage("fit width")).toBeNull();
	});
});

describe("formatPdfZoomPercentage", () => {
	it("shows at most one decimal place without a trailing zero", () => {
		expect(formatPdfZoomPercentage(1.25)).toBe("125");
		expect(formatPdfZoomPercentage(1.125)).toBe("112.5");
	});
});

describe("clampZoomPreviewScale", () => {
	it("keeps the previewed zoom inside the viewer range", () => {
		// Pinching out of a 200% view cannot go below the 50% floor.
		expect(clampZoomPreviewScale(0.1, 2)).toBe(0.25);
		// Nor above the 300% ceiling.
		expect(clampZoomPreviewScale(4, 1)).toBe(3);
		expect(clampZoomPreviewScale(1.5, 1)).toBe(1.5);
	});
});

describe("zoomPreviewTranslate", () => {
	it("keeps the gesture point fixed and scales the rest around it", () => {
		// The point under the fingers does not move...
		expect(zoomPreviewTranslate(200, 100, 1)).toEqual({ x: 0, y: 0 });
		// ...while a point twice as far from it ends up twice as far from the origin.
		expect(zoomPreviewTranslate(200, 100, 2)).toEqual({ x: -200, y: -100 });
		expect(zoomPreviewTranslate(200, 100, 0.5)).toEqual({ x: 100, y: 50 });
	});
});
