import { describe, expect, it } from "vitest";
import {
	assessLayoutReadiness,
	buildLayoutCompleteness,
	buildLayoutPageStats,
	formatLayoutPageRanges,
	parseLayoutCompleteness,
} from "@/lib/pdf/layout/completeness";
import { validateRemoteLayoutPageCount } from "@/lib/pdf/layout/run-analysis";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

function region(patch: Partial<PdfLayoutRegion> = {}): PdfLayoutRegion {
	return {
		id: "body",
		pageIndex: 0,
		kind: "text",
		label: "text",
		score: 0.9,
		readingOrder: 1,
		rect: { x: 10, y: 20, w: 100, h: 200 },
		bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.4 },
		...patch,
	};
}

describe("layout completeness", () => {
	it("warns when a page has body text but no translatable region", () => {
		const regions = [region({ text: "" })];
		const pageStats = buildLayoutPageStats({
			regions,
			pageCount: 1,
			textCharsByPage: new Map([[0, 420]]),
		});
		const completeness = buildLayoutCompleteness({
			pageCount: 1,
			pageStats,
			textLayerComplete: true,
			contentRepairAttempted: false,
		});
		expect(completeness.warnings).toEqual([
			{ code: "content-gap", pages: [0] },
		]);
		expect(assessLayoutReadiness(completeness)).toMatchObject({
			status: "warning",
			warningPages: [0],
			needsContentRepair: true,
		});
	});

	it("does not report reference-only, image-only, or blank pages", () => {
		const regions = [
			region({
				id: "refs",
				label: "reference",
				text: "References ".repeat(80),
			}),
			region({
				id: "figure",
				pageIndex: 1,
				kind: "image",
				label: "image",
				bbox: { x: 0, y: 0, w: 1, h: 0.8 },
			}),
		];
		const pageStats = buildLayoutPageStats({
			regions,
			pageCount: 3,
			textCharsByPage: new Map([
				[0, 800],
				[1, 500],
				[2, 0],
			]),
		});
		const completeness = buildLayoutCompleteness({
			pageCount: 3,
			pageStats,
			textLayerComplete: true,
			contentRepairAttempted: true,
		});
		expect(completeness.warnings).toEqual([]);
		expect(assessLayoutReadiness(completeness).status).toBe("ready");
	});

	it("does not report text detected inside an algorithm box", () => {
		const regions = [
			region({
				id: "algorithm",
				kind: "algorithm",
				label: "algorithm",
				bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.7 },
			}),
			region({
				id: "algorithm-text",
				kind: "text",
				label: "text",
				bbox: { x: 0.12, y: 0.15, w: 0.7, h: 0.5 },
				text: "Procedure ".repeat(80),
			}),
		];
		const completeness = buildLayoutCompleteness({
			pageCount: 1,
			pageStats: buildLayoutPageStats({
				regions,
				pageCount: 1,
				textCharsByPage: new Map([[0, 720]]),
			}),
			textLayerComplete: true,
			contentRepairAttempted: true,
		});
		expect(completeness.warnings).toEqual([]);
		expect(assessLayoutReadiness(completeness).status).toBe("ready");
	});

	it("treats missing processed pages and text-layer failure as incomplete", () => {
		const pageStats = buildLayoutPageStats({
			regions: [region()],
			pageCount: 2,
			textCharsByPage: new Map([[0, 100]]),
		}).slice(0, 1);
		const completeness = buildLayoutCompleteness({
			pageCount: 2,
			pageStats,
			textLayerComplete: false,
			contentRepairAttempted: false,
		});
		expect(assessLayoutReadiness(completeness)).toMatchObject({
			status: "incomplete",
			missingPages: [1],
		});
	});

	it("round-trips metadata and formats compact page ranges", () => {
		const completeness = buildLayoutCompleteness({
			pageCount: 2,
			pageStats: buildLayoutPageStats({
				regions: [region()],
				pageCount: 2,
				textCharsByPage: new Map([
					[0, 100],
					[1, 200],
				]),
			}),
			textLayerComplete: true,
			contentRepairAttempted: true,
		});
		expect(
			parseLayoutCompleteness(JSON.parse(JSON.stringify(completeness))),
		).toEqual(completeness);
		expect(formatLayoutPageRanges([2, 6, 7, 8, 10])).toBe("3, 7–9, 11");
	});

	it("rejects a remote layout result with missing pages", () => {
		expect(() => validateRemoteLayoutPageCount(14, 15)).toThrow(
			"Layout provider returned 14/15 pages",
		);
		expect(() => validateRemoteLayoutPageCount(15, 15)).not.toThrow();
	});
});
