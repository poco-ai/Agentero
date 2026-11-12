import { describe, expect, it } from "vitest";

import {
	clampZoomPreviewScale,
	formatPdfZoomPercentage,
	parsePdfZoomPercentage,
	zoomCommitPreviewTransform,
	zoomGestureCenteringMargin,
	zoomPreviewTranslate,
	zoomPreviewTranslateForViewport,
	zoomReadingWidth,
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

describe("zoomCommitPreviewTransform", () => {
	it("keeps the same page point fixed across old and new layout sizes", () => {
		const anchor = { x: 0.5, y: 0.5 };
		// Narrow-page centering puts the point away from the gesture pointer.
		const previewPosition = { x: 350, y: 400 };
		const element = { left: 50, top: 100 };
		for (const page of [
			{ left: 100, top: 200, width: 200, height: 400 },
			{ left: 125, top: 150, width: 400, height: 800 },
		]) {
			const { x, y, scale } = zoomCommitPreviewTransform(
				page,
				element,
				anchor,
				previewPosition,
				400,
			);
			expect(scale * page.width).toBe(400);
			expect(
				element.left + x + scale * (page.left + page.width / 2 - element.left),
			).toBe(previewPosition.x);
			expect(
				element.top + y + scale * (page.top + page.height / 2 - element.top),
			).toBe(previewPosition.y);
		}
	});
});

describe("zoom gesture reading box", () => {
	it("centers a narrow page within symmetric viewport padding", () => {
		// The comment rail is outside the reading box and contributes no padding.
		const readingWidth = zoomReadingWidth(900, 20, 20);
		expect(readingWidth).toBe(860);
		expect(zoomGestureCenteringMargin(860, readingWidth)).toBe(0);
		expect(zoomGestureCenteringMargin(400, readingWidth)).toBe(230);
	});
});

describe("zoomPreviewTranslateForViewport", () => {
	it("keeps a narrow document centered", () => {
		expect(zoomPreviewTranslateForViewport(50, 100, 2, 200, 500)).toEqual({
			x: -100,
			y: -100,
		});
	});

	it("smoothly hands the horizontal anchor to the pointer on overflow", () => {
		const blended = zoomPreviewTranslateForViewport(50, 100, 3, 200, 500);
		expect(blended.x).toBeCloseTo(-133.333, 3);
		expect(blended.y).toBe(-200);
		expect(zoomPreviewTranslateForViewport(50, 100, 4, 200, 500)).toEqual({
			x: -150,
			y: -300,
		});
	});
});
