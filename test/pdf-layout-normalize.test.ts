import type {
	DocumentLayout,
	PageLayout,
} from "@embedpdf/plugin-layout-analysis";
import { describe, expect, it } from "vitest";
import {
	documentLayoutToResult,
	pageLayoutToRegions,
} from "@/lib/pdf/layout/normalize";

function makePage(partial: {
	pageIndex: number;
	blocks: PageLayout["blocks"];
	pageSize?: { width: number; height: number };
}): PageLayout {
	return {
		pageIndex: partial.pageIndex,
		blocks: partial.blocks,
		tableStructures: new Map(),
		imageSize: { width: 800, height: 1000 },
		pageSize: partial.pageSize ?? { width: 612, height: 792 },
	};
}

describe("pageLayoutToRegions", () => {
	it("keeps image/table/formula/chart and normalizes bbox", () => {
		const page = makePage({
			pageIndex: 0,
			blocks: [
				{
					id: "a",
					classId: 14,
					label: "image",
					score: 0.9,
					rect: {
						origin: { x: 61.2, y: 79.2 },
						size: { width: 306, height: 198 },
					},
					imageBbox: [0, 0, 1, 1],
					readingOrder: 2,
				},
				{
					id: "b",
					classId: 22,
					label: "text",
					score: 0.99,
					rect: {
						origin: { x: 0, y: 0 },
						size: { width: 100, height: 20 },
					},
					imageBbox: [0, 0, 1, 1],
					readingOrder: 0,
				},
				{
					id: "c",
					classId: 5,
					label: "formula",
					score: 0.8,
					rect: {
						origin: { x: 100, y: 200 },
						size: { width: 200, height: 40 },
					},
					imageBbox: [0, 0, 1, 1],
					readingOrder: 1,
				},
				{
					id: "d",
					classId: 21,
					label: "table",
					score: 0.85,
					rect: {
						origin: { x: 50, y: 400 },
						size: { width: 500, height: 100 },
					},
					imageBbox: [0, 0, 1, 1],
					readingOrder: 3,
				},
				{
					id: "e",
					classId: 3,
					label: "chart",
					score: 0.7,
					rect: {
						origin: { x: 10, y: 10 },
						size: { width: 100, height: 100 },
					},
					imageBbox: [0, 0, 1, 1],
					readingOrder: 4,
				},
			],
		});

		const regions = pageLayoutToRegions(page);
		// text kept as formula-merge blocker; sidebar never shows it.
		expect(regions.map((r) => r.kind)).toEqual([
			"text",
			"formula",
			"image",
			"table",
			"chart",
		]);
		const image = regions.find((r) => r.id === "a");
		expect(image?.bbox).toEqual({
			x: 0.1,
			y: 0.1,
			w: 0.5,
			h: 0.25,
		});
		expect(image?.rect).toEqual({
			x: 61.2,
			y: 79.2,
			w: 306,
			h: 198,
		});
	});

	it("keeps the detector's display/inline formula split in the label", () => {
		const page = makePage({
			pageIndex: 0,
			blocks: [
				{
					id: "display",
					classId: 5,
					label: "formula",
					score: 0.9,
					rect: {
						origin: { x: 100, y: 200 },
						size: { width: 200, height: 40 },
					},
					imageBbox: [0, 0, 1, 1],
					readingOrder: 0,
				},
				{
					id: "inline",
					classId: 15,
					label: "formula",
					score: 0.9,
					rect: {
						origin: { x: 200, y: 100 },
						size: { width: 40, height: 12 },
					},
					imageBbox: [0, 0, 1, 1],
					readingOrder: 1,
				},
			],
		});
		const regions = pageLayoutToRegions(page);
		expect(
			regions.map((region) => [region.id, region.kind, region.label]),
		).toEqual([
			["display", "formula", "display_formula"],
			["inline", "formula", "inline_formula"],
		]);
	});

	it("aggregates document counts (figures need title; unnumbered formulas drop)", () => {
		const doc: DocumentLayout = {
			pages: [
				makePage({
					pageIndex: 0,
					blocks: [
						{
							id: "1",
							classId: 14,
							label: "image",
							score: 1,
							rect: {
								origin: { x: 50, y: 50 },
								size: { width: 400, height: 300 },
							},
							imageBbox: [0, 0, 1, 1],
							readingOrder: 0,
						},
						{
							id: "cap",
							classId: 7,
							label: "figure_title",
							score: 0.9,
							rect: {
								origin: { x: 50, y: 360 },
								size: { width: 400, height: 40 },
							},
							imageBbox: [0, 0, 1, 1],
							readingOrder: 1,
						},
						{
							id: "2",
							classId: 5,
							label: "formula",
							score: 1,
							rect: {
								origin: { x: 0, y: 0 },
								size: { width: 10, height: 10 },
							},
							imageBbox: [0, 0, 1, 1],
							readingOrder: 2,
						},
					],
				}),
			],
		};
		const result = documentLayoutToResult("doc-1", doc);
		// Merged figure keeps image kind; unnumbered formula dropped; bare captions dropped.
		expect(result.counts.image + result.counts.chart).toBeGreaterThanOrEqual(1);
		expect(result.counts.formula).toBe(0);
		expect(
			result.regions.some((r) => r.kind === "image" || r.kind === "chart"),
		).toBe(true);
		expect(result.regions.some((r) => r.kind === "formula")).toBe(false);
	});

	it("maps formula_number blocks", () => {
		const page = makePage({
			pageIndex: 0,
			blocks: [
				{
					id: "f",
					classId: 5,
					label: "formula",
					score: 0.9,
					rect: {
						origin: { x: 100, y: 200 },
						size: { width: 300, height: 40 },
					},
					imageBbox: [0, 0, 1, 1],
					readingOrder: 0,
				},
				{
					id: "n",
					classId: 11,
					label: "formula_number",
					score: 0.85,
					rect: {
						origin: { x: 450, y: 205 },
						size: { width: 30, height: 30 },
					},
					imageBbox: [0, 0, 1, 1],
					readingOrder: 1,
				},
			],
		});
		const regions = pageLayoutToRegions(page);
		expect(regions.map((r) => r.kind).sort()).toEqual([
			"formula",
			"formula_number",
		]);
	});
});
