import { describe, expect, it } from "vitest";
import {
	type CrossrefLabel,
	extractCrossrefLabel,
	pickCrossrefRegionByLabel,
} from "@/lib/pdf/crossref-resolve";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

function requireLabel(text: string): CrossrefLabel {
	const label = extractCrossrefLabel(text);
	if (!label) throw new Error(`expected label from "${text}"`);
	return label;
}

function region(
	pageIndex: number,
	kind: PdfLayoutRegion["kind"],
	bbox: PdfLayoutRegion["bbox"],
	title?: string,
	id = "r",
): PdfLayoutRegion {
	return { pageIndex, kind, bbox, score: 1, id, title };
}

describe("pickCrossrefRegionByLabel", () => {
	it("does not focus a differently numbered figure when the source link names a stale page", () => {
		expect(
			pickCrossrefRegionByLabel(
				[
					region(
						19,
						"image",
						{ x: 0.1, y: 0.1, w: 0.7, h: 0.3 },
						"Fig 11. caption",
					),
				],
				19,
				requireLabel("Fig 13"),
			),
		).toBeNull();
	});
	it("recognizes Chinese labels embedded directly in prose", () => {
		expect(extractCrossrefLabel("如图1(a)所示")).toEqual({
			kind: "figure",
			number: 1,
		});
		expect(extractCrossrefLabel("见表 2")).toEqual({
			kind: "table",
			number: 2,
		});
	});
	it("resolves plural figure references and Roman table numbers without matching prose words", () => {
		expect(extractCrossrefLabel("Figs. 6(a)")).toEqual({
			kind: "figure",
			number: 6,
		});
		expect(extractCrossrefLabel("Table XIV")).toEqual({
			kind: "table",
			number: 14,
		});
		expect(extractCrossrefLabel("Table INVALID")).toBeNull();
		expect(
			pickCrossrefRegionByLabel(
				[
					region(0, "table", { x: 0, y: 0, w: 1, h: 0.4 }, "TABLE I. First"),
					region(
						0,
						"table",
						{ x: 0, y: 0.5, w: 1, h: 0.4 },
						"TABLE II. Second",
					),
				],
				0,
				requireLabel("Table II"),
			)?.title,
		).toBe("TABLE II. Second");
	});
	it("does not mistake Figure 10 for Figure 1 on the same page", () => {
		const regions = [
			region(0, "image", { x: 0, y: 0, w: 1, h: 0.4 }, "Figure 10. caption"),
			region(0, "image", { x: 0, y: 0.5, w: 1, h: 0.4 }, "Fig. 1. caption"),
		];
		expect(
			pickCrossrefRegionByLabel(regions, 0, requireLabel("Figure 1"))?.title,
		).toBe("Fig. 1. caption");
	});
	it("matches a figure by caption title", () => {
		const regions = [
			region(0, "image", { x: 0, y: 0, w: 1, h: 0.4 }, "Figure 1. caption"),
			region(0, "image", { x: 0, y: 0.5, w: 1, h: 0.4 }, "Figure 2. caption"),
		];
		const matched = pickCrossrefRegionByLabel(
			regions,
			0,
			requireLabel("Figure 2"),
		);
		expect(matched?.title).toBe("Figure 2. caption");
	});

	it("returns the only candidate when there is no title", () => {
		const regions = [region(1, "table", { x: 0, y: 0.2, w: 1, h: 0.3 })];
		const matched = pickCrossrefRegionByLabel(
			regions,
			1,
			requireLabel("Table 1"),
		);
		expect(matched?.kind).toBe("table");
	});

	it("falls back to the largest candidate for figures without titles", () => {
		const regions = [
			region(0, "chart", { x: 0, y: 0, w: 0.4, h: 0.2 }),
			region(0, "chart", { x: 0, y: 0.5, w: 0.8, h: 0.3 }),
		];
		const matched = pickCrossrefRegionByLabel(
			regions,
			0,
			requireLabel("Fig. 1"),
		);
		expect(matched?.bbox).toEqual({ x: 0, y: 0.5, w: 0.8, h: 0.3 });
	});

	it("orders equations top-to-bottom when titles are unavailable", () => {
		const regions = [
			region(0, "formula", { x: 0, y: 0.7, w: 0.8, h: 0.05 }),
			region(0, "formula", { x: 0, y: 0.5, w: 0.8, h: 0.05 }),
			region(0, "formula", { x: 0, y: 0.6, w: 0.8, h: 0.05 }),
		];
		const matched = pickCrossrefRegionByLabel(
			regions,
			0,
			requireLabel("Eq. (2)"),
		);
		// Top-to-bottom: eq1 at y=0.5, eq2 at y=0.6, eq3 at y=0.7.
		expect(matched?.bbox.y).toBe(0.6);
	});
});

it("accepts full cross-reference nouns with publisher punctuation", () => {
	for (const [text, kind] of [
		["Table. 1", "table"],
		["Equation. (1)", "equation"],
		["Figure. 1", "figure"],
	]) {
		expect(extractCrossrefLabel(text)).toEqual({ kind, number: 1 });
	}
});
