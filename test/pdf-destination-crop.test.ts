// Synthetic text only; labels and geometry exercise the crop boundaries.
import { describe, expect, it } from "vitest";
import { pickDestinationRegion } from "@/lib/pdf/destination-crop";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

function region(
	pageIndex: number,
	kind: PdfLayoutRegion["kind"],
	bbox: PdfLayoutRegion["bbox"],
	title?: string,
	id = "r",
): PdfLayoutRegion {
	return { pageIndex, kind, bbox, score: 1, id, title };
}

function textRect(
	x: number,
	y: number,
	width: number,
	height: number,
	content: string,
) {
	return { rect: { origin: { x, y }, size: { width, height } }, content };
}

describe("pickDestinationRegion", () => {
	it.each([
		19,
		null,
	])("finds a reference whose label is right of the destination margin (entryIndex=%s)", (entryIndex) => {
		const result = pickDestinationRegion({
			pageIndex: 31,
			pdfX: 45.828,
			pdfY: 720 - 590.689,
			pageWidthPt: 486,
			pageHeightPt: 720,
			entryIndex,
			textRects: [
				textRect(45, 58, 395, 8, "Sample continuation."),
				textRect(53, 593, 12, 8, "[19] "),
				textRect(70, 593, 81, 8, "Sample continuation."),
				textRect(153, 593, 189, 8, "Sample continuation."),
				textRect(344, 593, 29, 8, "Sample continuation."),
				textRect(53, 603, 12, 8, "[20] "),
				textRect(70, 603, 292, 8, "Sample continuation."),
			],
		});
		expect(result.entryMatched).toBe(entryIndex != null);
		expect(result.bbox.y * 720).toBeLessThanOrEqual(593);
		expect((result.bbox.y + result.bbox.h) * 720).toBeLessThan(603);
		expect((result.bbox.x + result.bbox.w) * 486).toBeGreaterThanOrEqual(373);
	});

	it("includes a spaced URL and its small punctuation without joining the other column", () => {
		const result = pickDestinationRegion({
			pageIndex: 10,
			pdfX: 311.978,
			pdfY: 713.362,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects: [
				textRect(54, 81, 246, 8, "[1] Sample reference."),
				textRect(313, 81, 12, 7, "[18] "),
				textRect(331, 81, 70, 8, "Sample continuation."),
				textRect(411, 81, 43, 8, "https://example.org/sample"),
				textRect(455, 85, 1, 1, "."),
				textRect(456, 81, 107, 8, "Sample continuation."),
				textRect(330, 89, 25, 8, "Sample continuation."),
				textRect(356, 94, 1, 1, "."),
				textRect(313, 99, 12, 7, "[19] "),
				textRect(331, 99, 226, 8, "Sample continuation."),
			],
		});
		expect(result.bbox.x * 612).toBeGreaterThanOrEqual(307);
		expect((result.bbox.x + result.bbox.w) * 612).toBeGreaterThanOrEqual(563);
		expect((result.bbox.y + result.bbox.h) * 792).toBeGreaterThanOrEqual(97);
		expect((result.bbox.y + result.bbox.h) * 792).toBeLessThan(99);
	});

	it("does not treat repeated detached URLs on entry rows as a neighbouring column", () => {
		const result = pickDestinationRegion({
			pageIndex: 10,
			pdfX: 50,
			pdfY: 720,
			pageWidthPt: 612,
			pageHeightPt: 792,
			entryIndex: 1,
			textRects: [
				textRect(50, 72, 70, 9, "[1] Sample reference."),
				textRect(200, 72, 200, 9, "https://example.org/sample"),
				textRect(50, 100, 70, 9, "[2] Sample reference."),
				textRect(200, 100, 200, 9, "https://example.org/sample"),
			],
		});
		expect((result.bbox.x + result.bbox.w) * 612).toBeGreaterThanOrEqual(400);
		expect((result.bbox.y + result.bbox.h) * 792).toBeLessThan(100);
	});

	it("finds the start of a range when fewer digits indent its marker beyond the anchor", () => {
		const result = pickDestinationRegion({
			pageIndex: 14,
			pdfX: 317.88,
			pdfY: 281.876,
			pageWidthPt: 612,
			pageHeightPt: 792,
			entryIndex: 8,
			endEntryIndex: 12,
			textRects: [
				textRect(324, 283, 236, 9, "[8] Sample reference."),
				textRect(324, 306, 236, 9, "[9] Sample reference."),
				textRect(319, 329, 241, 9, "[10] Sample reference."),
				textRect(319, 352, 241, 9, "[11] Sample reference."),
				textRect(319, 375, 241, 9, "[12] Sample reference."),
				textRect(319, 398, 241, 9, "[13] Sample reference."),
			],
		});
		expect(result.entryMatched).toBe(true);
		expect(result.bbox.y * 792).toBeLessThanOrEqual(283);
		expect((result.bbox.y + result.bbox.h) * 792).toBeGreaterThanOrEqual(384);
		expect((result.bbox.y + result.bbox.h) * 792).toBeLessThan(398);
	});

	it("keeps a left reference separate from right prose beneath a full-width page header", () => {
		const result = pickDestinationRegion({
			pageIndex: 14,
			pdfX: 53.798,
			pdfY: 792 - 165.38,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects: [
				textRect(54, 62, 504, 7, "Sample continuation."),
				textRect(55, 168, 10, 7, "[50] "),
				textRect(69, 168, 226, 7, "Sample continuation."),
				textRect(69, 176, 225, 7, "Sample continuation."),
				textRect(69, 184, 226, 7, "Sample continuation."),
				textRect(70, 192, 33, 7, "Sample continuation."),
				textRect(102, 192, 193, 7, "Sample continuation."),
				textRect(55, 200, 10, 7, "[51] "),
				textRect(69, 200, 226, 7, "Sample continuation."),
				textRect(318, 170, 240, 9, "Sample continuation."),
				textRect(318, 181, 172, 9, "Sample continuation."),
			],
		});
		expect((result.bbox.x + result.bbox.w) * 612).toBeLessThan(318);
		expect((result.bbox.y + result.bbox.h) * 792).toBeGreaterThan(198.99);
		expect((result.bbox.y + result.bbox.h) * 792).toBeLessThan(200);
	});

	it("keeps sparse appendix headings in the neighbouring column out of the reference", () => {
		const result = pickDestinationRegion({
			pageIndex: 18,
			pdfX: 54,
			pdfY: 343.207,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects: [
				textRect(55, 457, 15, 9, "[56] "),
				textRect(76, 457, 219, 9, "Sample continuation."),
				textRect(75, 469, 220, 9, "Sample continuation."),
				textRect(76, 481, 219, 9, "Sample continuation."),
				textRect(76, 493, 220, 9, "Sample continuation."),
				textRect(76, 505, 68, 9, "Sample continuation."),
				textRect(55, 526, 15, 9, "[57] "),
				textRect(76, 526, 220, 9, "Sample continuation."),
				textRect(318, 463, 59, 11, "Appendices"),
				textRect(318, 503, 203, 11, "Sample continuation."),
			],
		});
		expect((result.bbox.x + result.bbox.w) * 612).toBeLessThan(318);
		expect((result.bbox.y + result.bbox.h) * 792).toBeGreaterThanOrEqual(514);
		expect((result.bbox.y + result.bbox.h) * 792).toBeLessThan(526);
	});

	it("ignores a vertical watermark overlapping several reference rows", () => {
		const result = pickDestinationRegion({
			pageIndex: 4,
			pdfX: 53.945,
			pdfY: 326.614,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects: [
				textRect(5, 302, 19, 188, "Sample continuation."),
				textRect(49, 425, 251, 8, "Sample continuation."),
				textRect(55, 471, 10, 9, "[9] "),
				textRect(71, 471, 229, 9, "Sample continuation."),
				textRect(71, 482, 230, 9, "Sample continuation."),
				textRect(71, 494, 229, 9, "Sample continuation."),
				textRect(71, 506, 134, 10, "Sample continuation."),
				textRect(50, 518, 15, 9, "[10] "),
				textRect(71, 518, 229, 9, "Sample continuation."),
			],
		});
		expect(result.bbox.x * 612).toBeGreaterThanOrEqual(44);
		expect(result.bbox.y * 792).toBeGreaterThan(460);
		expect(result.bbox.y * 792).toBeLessThanOrEqual(471);
		expect((result.bbox.y + result.bbox.h) * 792).toBeGreaterThanOrEqual(516);
		expect((result.bbox.y + result.bbox.h) * 792).toBeLessThan(518);
	});

	it("isolates single reference entry from [N] marker until the next marker [N+1]", () => {
		const textRects = [
			textRect(50, 72, 240, 9, "[1] Sample reference."),
			textRect(65, 82, 220, 9, "Sample continuation."),
			textRect(65, 92, 40, 9, "2025."),

			textRect(50, 104, 240, 9, "[2] Sample reference."),
		];

		const result = pickDestinationRegion({
			pageIndex: 11,
			pdfX: 50,
			pdfY: 722,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
		});

		expect(result.pageIndex).toBe(11);

		expect(result.bbox.y).toBeLessThanOrEqual(72 / 792);

		const bottomPt = (result.bbox.y + result.bbox.h) * 792;
		expect(bottomPt).toBeLessThan(104);
	});

	it("clamps full-width layout regions to a single column when the document is two-column", () => {
		const regions = [
			region(8, "text", { x: 0.52, y: 0.1, w: 0.42, h: 0.4 }),

			region(8, "text", { x: 0.05, y: 0.1, w: 0.88, h: 0.8 }),
		];

		const result = pickDestinationRegion({
			pageIndex: 8,
			pdfX: 45,
			pdfY: 554.4,
			pageWidthPt: 612,
			pageHeightPt: 792,
			regions,
		});

		expect(result.bbox.w).toBeLessThanOrEqual(0.46);
		expect(result.bbox.x + result.bbox.w).toBeLessThanOrEqual(0.5);
	});

	it("aligns to layout text regions when textRects are absent", () => {
		const regions = [
			region(
				8,
				"text",
				{ x: 0.06, y: 0.1, w: 0.42, h: 0.8 },
				undefined,
				"col-1",
			),
			region(
				8,
				"text",
				{ x: 0.52, y: 0.1, w: 0.42, h: 0.8 },
				undefined,
				"col-2",
			),
		];

		const result = pickDestinationRegion({
			pageIndex: 8,
			pdfX: 324,
			pdfY: 554.4,
			pageWidthPt: 612,
			pageHeightPt: 792,
			regions,
		});
		expect(result.pageIndex).toBe(8);
		expect(result.bbox.x).toBe(0.52);
		expect(result.bbox.w).toBe(0.42);
		expect(result.bbox.y).toBeCloseTo(0.3 - 0.015, 2);
	});

	it("uses column geometry heuristic when regions and textRects are absent", () => {
		const left = pickDestinationRegion({
			pageIndex: 5,
			pdfX: 40,
			pdfY: 400,
			pageWidthPt: 612,
			pageHeightPt: 792,
		});
		expect(left.pageIndex).toBe(5);
		expect(left.bbox.x).toBeLessThan(0.4);
		expect(left.bbox.w).toBeLessThanOrEqual(0.46);

		const right = pickDestinationRegion({
			pageIndex: 5,
			pdfX: 320,
			pdfY: 400,
			pageWidthPt: 612,
			pageHeightPt: 792,
		});
		expect(right.pageIndex).toBe(5);
		expect(right.bbox.x).toBeGreaterThanOrEqual(0.48);
		expect(right.bbox.x + right.bbox.w).toBeLessThanOrEqual(0.98);
	});

	it("does not hijack distant entryIndex when far from destination anchor", () => {
		const textRects = [
			textRect(50, 72, 240, 9, "[4] Sample reference."),

			textRect(50, 400, 240, 9, "[18] Sample reference."),
		];

		const result = pickDestinationRegion({
			pageIndex: 11,
			pdfX: 50,
			pdfY: 792 - 400,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
			entryIndex: 4,
		});

		expect(result.bbox.y * 792).toBeGreaterThanOrEqual(390);
	});
	it("reports entryMatched only when the [N] / N. line is found", () => {
		const textRects = [
			textRect(50, 72, 240, 9, "[7] Sample reference."),
			textRect(50, 84, 240, 9, "8.  Sample reference."),
		];
		const base = {
			pageIndex: 3,
			pdfX: 50,
			pdfY: 792 - 72,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
		};
		expect(pickDestinationRegion({ ...base, entryIndex: 7 }).entryMatched).toBe(
			true,
		);
		expect(pickDestinationRegion({ ...base, entryIndex: 8 }).entryMatched).toBe(
			true,
		);

		expect(pickDestinationRegion({ ...base, entryIndex: 2 }).entryMatched).toBe(
			false,
		);
		expect(pickDestinationRegion(base).entryMatched).toBe(false);

		expect(
			pickDestinationRegion({ ...base, textRects: undefined, entryIndex: 7 })
				.entryMatched,
		).toBe(false);
	});

	it("crops a short single-line entry to its text width near the right page edge", () => {
		const textRects = [textRect(560, 300, 30, 9, "[3] Sample reference.")];
		const result = pickDestinationRegion({
			pageIndex: 0,
			pdfX: 560,
			pdfY: 792 - 300,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
			entryIndex: 3,
		});
		expect(result.bbox.w * 612).toBeCloseTo(42);
		expect(result.bbox.x * 612).toBeCloseTo(554);
		expect(result.bbox.x + result.bbox.w).toBeLessThanOrEqual(0.98 + 1e-9);
	});

	it("uses actual line bounds when the gutter is not at the page centre", () => {
		const textRects = [
			textRect(50, 72, 30, 9, "[1] Sample reference."),
			textRect(370, 72, 190, 9, "[10] Sample reference."),
			textRect(50, 84, 280, 9, "[2] Sample reference."),
			textRect(65, 96, 265, 9, "Sample continuation."),
			textRect(370, 84, 190, 9, "[11] Sample reference."),
			textRect(50, 108, 280, 9, "[3] Sample reference."),
		];
		const base = {
			pageIndex: 0,
			pdfX: 50,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
		};
		const short = pickDestinationRegion({
			...base,
			pdfY: 792 - 72,
			entryIndex: 1,
		});
		expect(short.bbox.w * 612).toBeCloseTo(42);
		const wrapped = pickDestinationRegion({
			...base,
			pdfY: 792 - 84,
			entryIndex: 2,
		});
		const right = (wrapped.bbox.x + wrapped.bbox.w) * 612;
		expect(right).toBeCloseTo(336);
		expect((wrapped.bbox.y + wrapped.bbox.h) * 792).toBeGreaterThanOrEqual(105);
		expect((wrapped.bbox.y + wrapped.bbox.h) * 792).toBeLessThan(108);
	});

	it("does not read a labelled entry's continuation line as an author-year start", () => {
		const textRects = [
			textRect(330, 382, 172, 8, "Sample continuation."),
			textRect(317, 391, 246, 8, "[5] Sample reference."),
			textRect(330, 400, 234, 8, "Sample continuation."),
			textRect(330, 409, 95, 8, "Writer, 2025. Sample details."),
			textRect(317, 418, 246, 8, "[6] Sample reference."),
			textRect(330, 427, 116, 8, "Sample continuation."),
			textRect(317, 436, 246, 8, "[7] Sample reference."),
			textRect(330, 445, 231, 8, "Sample continuation."),

			textRect(59, 404, 241, 8, "Sample continuation."),
			textRect(49, 413, 251, 8, "Sample continuation."),
		];
		const base = {
			pageIndex: 10,
			pdfX: 312,
			pdfY: 381,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
		};

		for (const entryIndex of [null, 6]) {
			const result = pickDestinationRegion({ ...base, entryIndex });
			expect(result.bbox.y * 792).toBeGreaterThan(409);
			expect(result.bbox.y * 792).toBeLessThanOrEqual(418);
			expect((result.bbox.y + result.bbox.h) * 792).toBeLessThan(436);
		}
	});

	it('does not take IEEE\'s "[Online]. Available:" line for an entry start', () => {
		const textRects = [
			textRect(317, 481, 246, 8, "[9] Sample reference."),
			textRect(
				331,
				490,
				232,
				8,
				"[Online]. Available: https://example.org/sample",
			),
			textRect(330, 499, 36, 8, "Sample continuation."),
			textRect(313, 508, 250, 8, "[10] Sample reference."),
			textRect(330, 517, 233, 8, "Sample continuation."),
			textRect(330, 526, 120, 8, "Writer, 2025. Sample details."),
			textRect(313, 535, 250, 8, "[11] Sample reference."),
			textRect(
				331,
				544,
				200,
				8,
				"[Online]. Available: https://example.org/sample",
			),
			textRect(49, 500, 251, 8, "Sample continuation."),
			textRect(49, 509, 251, 8, "Sample continuation."),
		];
		const base = {
			pdfX: 312,
			pageWidthPt: 612,
			pageHeightPt: 792,
			pageIndex: 10,
			textRects,
		};

		const ten = pickDestinationRegion({ ...base, pdfY: 792 - 499 });
		expect(ten.bbox.y * 792).toBeGreaterThan(499);
		expect(ten.bbox.y * 792).toBeLessThanOrEqual(508);
		expect((ten.bbox.y + ten.bbox.h) * 792).toBeLessThan(535);

		const eleven = pickDestinationRegion({ ...base, pdfY: 792 - 534 });
		expect((eleven.bbox.y + eleven.bbox.h) * 792).toBeGreaterThan(550);
	});

	it("keeps a full-width bibliography below equations and isolated right-side fragments", () => {
		const textRects = [
			textRect(167, 97, 392, 10, "Sample continuation."),
			textRect(188, 271, 373, 10, "Sample continuation."),
			textRect(166, 296, 393, 10, "Sample continuation."),
			textRect(299, 148, 71, 10, "Sample continuation."),
			textRect(434, 322, 4, 10, "Sample continuation."),
			textRect(540, 539, 19, 10, "Sample continuation."),
			textRect(36, 666, 50, 10, "References"),
			textRect(36, 681, 6, 10, "1. "),
			textRect(57, 681, 444, 10, "Sample continuation."),
			textRect(36, 693, 6, 10, "2. "),
			textRect(57, 693, 417, 10, "Sample continuation."),
			textRect(36, 704, 6, 10, "3. "),
			textRect(57, 704, 502, 10, "Sample continuation."),
		];
		const result = pickDestinationRegion({
			pageIndex: 27,
			pdfX: 35.716,
			pdfY: 165.009,
			pageWidthPt: 595.276,
			pageHeightPt: 841.89,
			textRects,
			entryIndex: 1,
		});
		expect(result.entryMatched).toBe(true);
		const right = (result.bbox.x + result.bbox.w) * 595.276;
		expect(right).toBeGreaterThanOrEqual(501);
		expect(right).toBeLessThanOrEqual(507);
		expect(result.bbox.y * 841.89).toBeLessThanOrEqual(681);
		expect((result.bbox.y + result.bbox.h) * 841.89).toBeLessThan(693);
	});

	it("crops full citation range from [8] through [12] even when destination anchor is at reference [12]", () => {
		const textRects = [
			textRect(50, 72, 240, 9, "[8] Sample reference."),
			textRect(65, 82, 220, 9, "Sample continuation."),
			textRect(50, 96, 240, 9, "[9] Sample reference."),
			textRect(50, 110, 240, 9, "[10] Sample reference."),
			textRect(50, 124, 240, 9, "[11] Sample reference."),
			textRect(50, 138, 240, 9, "[12] Sample reference."),
			textRect(65, 148, 220, 9, "Sample continuation."),
			textRect(50, 162, 240, 9, "[13] Sample reference."),
		];

		const result = pickDestinationRegion({
			pageIndex: 14,
			pdfX: 50,
			pdfY: 792 - 138,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
			entryIndex: 8,
			endEntryIndex: 12,
		});

		expect(result.bbox.y * 792).toBeLessThanOrEqual(72);

		const bottomPt = (result.bbox.y + result.bbox.h) * 792;
		expect(bottomPt).toBeGreaterThan(148);

		expect(bottomPt).toBeLessThan(162);
	});

	it("crops all entries on landing page belonging to range when start entry is on previous page (e.g. range [1-10] landing on [10] with [9] and [10] present)", () => {
		const textRects = [
			textRect(50, 70, 240, 9, "[9] Sample reference."),
			textRect(65, 82, 220, 9, "Sample continuation."),

			textRect(50, 96, 240, 9, "[10] Sample reference."),
			textRect(65, 108, 220, 9, "Sample continuation."),

			textRect(50, 122, 240, 9, "[11] Sample reference."),
		];

		const result = pickDestinationRegion({
			pageIndex: 14,
			pdfX: 50,
			pdfY: 792 - 96,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
			entryIndex: 1,
			endEntryIndex: 10,
		});

		expect(result.bbox.y * 792).toBeLessThanOrEqual(70);

		const bottomPt = (result.bbox.y + result.bbox.h) * 792;
		expect(bottomPt).toBeGreaterThan(108);

		expect(bottomPt).toBeLessThan(122);
	});

	it("stops before next entry for dot-numbered reference entries split into number and dot runs", () => {
		const textRects = [
			textRect(313, 95, 7, 6, "12"),
			textRect(322, 95, 5, 6, "."),
			textRect(330, 95, 230, 9, "Sample continuation."),
			textRect(330, 106, 230, 9, "Sample continuation."),

			textRect(313, 127, 7, 6, "13"),
			textRect(322, 127, 5, 6, "."),
			textRect(330, 127, 230, 9, "Sample continuation."),
			textRect(330, 138, 230, 9, "Sample continuation."),

			textRect(313, 148, 7, 6, "14"),
			textRect(322, 148, 5, 6, "."),
			textRect(330, 148, 230, 9, "Sample continuation."),
		];

		const result = pickDestinationRegion({
			pageIndex: 11,
			pdfX: 330,
			pdfY: 802 - 127,
			pageWidthPt: 612,
			pageHeightPt: 802,
			textRects,
			entryIndex: 11,
			endEntryIndex: 13,
		});

		const topPt = result.bbox.y * 802;
		const bottomPt = (result.bbox.y + result.bbox.h) * 802;

		expect(topPt).toBeLessThanOrEqual(95);

		expect(bottomPt).toBeGreaterThan(138);

		expect(bottomPt).toBeLessThan(148);
	});

	it("crops in-range entries even when destination anchor is at top of column above the entries", () => {
		const textRects = [
			textRect(50, 95, 200, 9, "[12] Sample reference."),
			textRect(66, 106, 184, 9, "Sample continuation."),

			textRect(50, 127, 200, 9, "[13] Sample reference."),

			textRect(50, 148, 200, 9, "[14] Sample reference."),
		];

		const result = pickDestinationRegion({
			pageIndex: 11,
			pdfX: 50,
			pdfY: 802 - 30,
			pageWidthPt: 612,
			pageHeightPt: 802,
			textRects,
			entryIndex: 11,
			endEntryIndex: 13,
		});

		const topPt = result.bbox.y * 802;
		const bottomPt = (result.bbox.y + result.bbox.h) * 802;
		expect(topPt).toBeLessThanOrEqual(95);
		expect(bottomPt).toBeGreaterThan(127);
		expect(bottomPt).toBeLessThan(148);
	});

	it("stops the last entry at the appendix heading after it", () => {
		const textRects = [
			textRect(70, 320, 33, 7, "Sample continuation."),
			textRect(102, 321, 69, 6, "Sample continuation."),
			textRect(55, 328, 10, 7, "[56] "),
			textRect(69, 328, 225, 7, "Sample continuation."),
			textRect(69, 336, 225, 7, "Sample continuation."),
			textRect(69, 344, 98, 7, "Sample continuation."),
			textRect(169, 344, 126, 7, "Sample continuation."),
			textRect(70, 352, 33, 7, "Sample continuation."),
			textRect(102, 352, 193, 7, "Sample continuation."),
			textRect(54, 373, 113, 11, "Sample continuation."),
			textRect(54, 389, 116, 8, "Sample continuation."),
			textRect(64, 405, 25, 6, "Proof. "),
			textRect(93, 404, 175, 9, "Sample continuation."),
		];
		const result = pickDestinationRegion({
			pageIndex: 14,
			pdfX: 54,
			pdfY: 792 - 324.8,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
		});
		const bottom = (result.bbox.y + result.bbox.h) * 792;
		expect(result.bbox.y * 792).toBeLessThanOrEqual(328);
		expect(bottom).toBeGreaterThanOrEqual(359);
		expect(bottom).toBeLessThan(373);
	});

	it("stops at a centred heading a line-height gap below the entry", () => {
		const textRects = [
			textRect(312, 148, 14, 9, "[63] "),
			textRect(334, 148, 230, 9, "Sample continuation."),
			textRect(334, 160, 60, 7, "Sample continuation."),
			textRect(396, 160, 166, 9, "Sample continuation."),
			textRect(334, 172, 20, 7, "2025."),
			textRect(408, 192, 22, 7, "Sample continuation."),
			textRect(431, 194, 34, 6, "Sample continuation."),
			textRect(322, 207, 248, 9, "Sample continuation."),
			textRect(312, 219, 258, 9, "https://example.org/sample"),
		];
		const result = pickDestinationRegion({
			pageIndex: 15,
			pdfX: 312,
			pdfY: 792 - 148,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
		});
		const bottom = (result.bbox.y + result.bbox.h) * 792;
		expect(bottom).toBeGreaterThanOrEqual(179);
		expect(bottom).toBeLessThan(192);
	});

	it("keeps left-column text that overhangs the gutter out of the right column", () => {
		const left = [298, 306, 314, 322, 330, 338, 346].map((y) =>
			textRect(54, y, 246, 7, "Sample continuation."),
		);
		const textRects = [
			...left,
			textRect(300, 344, 2, 6, ","),
			textRect(320, 322, 12, 7, "[33] "),
			textRect(340, 322, 231, 7, "Sample continuation."),
			textRect(340, 330, 231, 7, "Sample continuation."),
			textRect(341, 340, 95, 7, "Sample continuation."),
			textRect(436, 340, 22, 7, ", 2025."),
			textRect(320, 351, 12, 7, "[34] "),
			textRect(340, 351, 231, 7, "Sample continuation."),
		];
		const result = pickDestinationRegion({
			pageIndex: 14,
			pdfX: 320,
			pdfY: 792 - 320,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
		});
		const bottom = (result.bbox.y + result.bbox.h) * 792;
		expect(result.bbox.x * 612).toBeGreaterThanOrEqual(306);
		expect(bottom).toBeGreaterThanOrEqual(347);
		expect(bottom).toBeLessThan(351);
	});
});
