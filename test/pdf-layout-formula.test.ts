import { describe, expect, it } from "vitest";

import {
	compareLayoutReadingOrder,
	formulaSortAnchor,
	mergeCaptionsIntoHosts,
	mergeFormulasByNumber,
	selectFormulasForNumber,
} from "@/lib/pdf/layout/merge-captions";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

function region(
	partial: Partial<PdfLayoutRegion> &
		Pick<PdfLayoutRegion, "id" | "kind" | "score" | "bbox">,
): PdfLayoutRegion {
	return {
		pageIndex: 0,
		label: partial.kind,
		readingOrder: 0,
		rect: {
			x: partial.bbox.x * 100,
			y: partial.bbox.y * 100,
			w: partial.bbox.w * 100,
			h: partial.bbox.h * 100,
		},
		...partial,
	};
}

describe("selectFormulasForNumber", () => {
	it("picks left-side formula bodies in the number band", () => {
		const num = region({
			id: "n1",
			kind: "formula_number",
			score: 0.9,
			bbox: { x: 0.85, y: 0.4, w: 0.08, h: 0.04 },
		});
		const body = region({
			id: "f1",
			kind: "formula",
			score: 0.95,
			bbox: { x: 0.2, y: 0.39, w: 0.55, h: 0.05 },
		});
		const other = region({
			id: "f2",
			kind: "formula",
			score: 0.9,
			bbox: { x: 0.2, y: 0.7, w: 0.55, h: 0.05 },
		});
		const picked = selectFormulasForNumber(num, [body, other]);
		expect(picked.map((p) => p.id)).toEqual(["f1"]);
	});

	it("does not vertically merge stacked lines or interline body formulas", () => {
		const num = region({
			id: "n1",
			kind: "formula_number",
			score: 0.9,
			bbox: { x: 0.88, y: 0.42, w: 0.06, h: 0.02 },
		});
		const line1 = region({
			id: "f1",
			kind: "formula",
			score: 0.9,
			bbox: { x: 0.15, y: 0.415, w: 0.65, h: 0.025 },
		});
		// Next display-ish line — must NOT union into host (swallows body text).
		const line2 = region({
			id: "f2",
			kind: "formula",
			score: 0.9,
			bbox: { x: 0.15, y: 0.46, w: 0.65, h: 0.025 },
		});
		// Inline scrap in paragraph above.
		const interline = region({
			id: "f-inline",
			kind: "formula",
			score: 0.85,
			bbox: { x: 0.2, y: 0.35, w: 0.15, h: 0.02 },
		});
		const picked = selectFormulasForNumber(num, [line1, line2, interline]);
		expect(picked.map((p) => p.id)).toEqual(["f1"]);
	});

	it("rejects paragraph-tall formula mislabels as seeds", () => {
		const num = region({
			id: "n1",
			kind: "formula_number",
			score: 0.9,
			bbox: { x: 0.89, y: 0.5, w: 0.03, h: 0.015 },
		});
		const tall = region({
			id: "f-tall",
			kind: "formula",
			score: 0.95,
			// Whole column of body text dual-labeled as formula.
			bbox: { x: 0.1, y: 0.4, w: 0.7, h: 0.2 },
		});
		const line = region({
			id: "f-line",
			kind: "formula",
			score: 0.9,
			bbox: { x: 0.15, y: 0.495, w: 0.65, h: 0.025 },
		});
		const picked = selectFormulasForNumber(num, [tall, line]);
		expect(picked.map((p) => p.id)).toEqual(["f-line"]);
	});

	it("prefers high-score body over tiny scraps next to the number", () => {
		const num = region({
			id: "n1",
			kind: "formula_number",
			score: 0.8,
			bbox: { x: 0.89, y: 0.613, w: 0.022, h: 0.014 },
		});
		const main = region({
			id: "f-main",
			kind: "formula",
			score: 0.84,
			bbox: { x: 0.622, y: 0.612, w: 0.173, h: 0.017 },
		});
		const scrap = region({
			id: "f-scrap",
			kind: "formula",
			score: 0.02,
			bbox: { x: 0.86, y: 0.613, w: 0.022, h: 0.014 },
		});
		const picked = selectFormulasForNumber(num, [scrap, main]);
		expect(picked.map((p) => p.id)).toContain("f-main");
		expect(picked.map((p) => p.id)).not.toContain("f-scrap");
	});
});

describe("mergeFormulasByNumber", () => {
	it("aggregates by formula_number geometry and drops unnumbered formulas", () => {
		const numberedBody = region({
			id: "f1",
			kind: "formula",
			score: 0.95,
			bbox: { x: 0.15, y: 0.3, w: 0.6, h: 0.05 },
		});
		const number = region({
			id: "n1",
			kind: "formula_number",
			score: 0.9,
			bbox: { x: 0.85, y: 0.31, w: 0.08, h: 0.04 },
		});
		const unnumbered = region({
			id: "f2",
			kind: "formula",
			score: 0.9,
			bbox: { x: 0.15, y: 0.6, w: 0.5, h: 0.04 },
		});
		const out = mergeFormulasByNumber([numberedBody, number, unnumbered]);
		expect(out).toHaveLength(1);
		expect(out[0]?.kind).toBe("formula");
		// No equation-id text parse onto title.
		expect(out[0]?.title).toBeUndefined();
		expect(out[0]?.titleBbox).toEqual(number.bbox);
		// Body ∪ number
		expect(out[0]?.bbox.x).toBeLessThanOrEqual(numberedBody.bbox.x + 1e-9);
		expect(out[0]?.bbox.x + out[0]?.bbox.w).toBeGreaterThanOrEqual(
			number.bbox.x + number.bbox.w - 1e-9,
		);
	});

	it("drops bare formulas without a model formula_number box", () => {
		const f = region({
			id: "f1",
			kind: "formula",
			score: 0.9,
			bbox: { x: 0.2, y: 0.4, w: 0.5, h: 0.05 },
		});
		const out = mergeFormulasByNumber([f]);
		expect(out).toHaveLength(0);
	});

	it("orders formulas left-column then right-column then top-to-bottom", () => {
		// Two-column page: left bottom eq should come before right-column top eqs
		// when reading left column fully first (academic dual-column order).
		const pairs: Array<{
			body: ReturnType<typeof region>;
			num: ReturnType<typeof region>;
		}> = [
			{
				// right column, top
				body: region({
					id: "fr1",
					kind: "formula",
					score: 0.9,
					bbox: { x: 0.55, y: 0.15, w: 0.3, h: 0.03 },
					readingOrder: 10,
				}),
				num: region({
					id: "nr1",
					kind: "formula_number",
					score: 0.9,
					bbox: { x: 0.88, y: 0.15, w: 0.04, h: 0.02 },
					readingOrder: 11,
				}),
			},
			{
				// left column, lower
				body: region({
					id: "fl1",
					kind: "formula",
					score: 0.9,
					bbox: { x: 0.1, y: 0.65, w: 0.3, h: 0.03 },
					readingOrder: 50,
				}),
				num: region({
					id: "nl1",
					kind: "formula_number",
					score: 0.9,
					bbox: { x: 0.42, y: 0.65, w: 0.04, h: 0.02 },
					readingOrder: 51,
				}),
			},
			{
				// right column, middle
				body: region({
					id: "fr2",
					kind: "formula",
					score: 0.9,
					bbox: { x: 0.55, y: 0.4, w: 0.3, h: 0.03 },
					readingOrder: 20,
				}),
				num: region({
					id: "nr2",
					kind: "formula_number",
					score: 0.9,
					bbox: { x: 0.88, y: 0.4, w: 0.04, h: 0.02 },
					readingOrder: 21,
				}),
			},
		];
		const out = mergeFormulasByNumber(pairs.flatMap((p) => [p.body, p.num]));
		const formulas = out.filter((r) => r.kind === "formula");
		expect(formulas.map((f) => f.id)).toEqual(["nl1", "nr1", "nr2"]);
		// Stable for sidebar re-sort.
		const resorted = [...formulas].sort((a, b) =>
			compareLayoutReadingOrder(a, b, formulaSortAnchor),
		);
		expect(resorted.map((f) => f.id)).toEqual(["nl1", "nr1", "nr2"]);
	});

	it("ignores low-score formula_number noise and co-located text dual-labels", () => {
		const body = region({
			id: "f1",
			kind: "formula",
			score: 0.84,
			bbox: { x: 0.62, y: 0.61, w: 0.17, h: 0.017 },
		});
		const goodNum = region({
			id: "n-good",
			kind: "formula_number",
			score: 0.8,
			bbox: { x: 0.89, y: 0.613, w: 0.022, h: 0.014 },
		});
		const noiseNum = region({
			id: "n-noise",
			kind: "formula_number",
			score: 0.015,
			bbox: { x: 0.62, y: 0.61, w: 0.17, h: 0.017 },
		});
		const dualText = region({
			id: "t-dual",
			kind: "text",
			score: 0.024,
			// Same box as formula — previously killed every merge via F2.
			bbox: { x: 0.62, y: 0.61, w: 0.17, h: 0.017 },
		});
		const out = mergeFormulasByNumber([body, goodNum, noiseNum, dualText]);
		const formulas = out.filter((r) => r.kind === "formula");
		expect(formulas).toHaveLength(1);
		expect(formulas[0]?.id).toBe("n-good");
		expect(out.some((r) => r.kind === "text")).toBe(false);
	});
});

describe("mergeCaptionsIntoHosts + formulas", () => {
	it("places merged formulas in final hosts and drops unnumbered", () => {
		const image = region({
			id: "img",
			kind: "image",
			score: 0.95,
			bbox: { x: 0.1, y: 0.05, w: 0.7, h: 0.2 },
		});
		const figTitle = region({
			id: "ft",
			kind: "figure_title",
			score: 0.9,
			bbox: { x: 0.1, y: 0.26, w: 0.7, h: 0.04 },
			title: "Figure 1: Overview.",
			captionRole: "figure_main",
		});
		const formula = region({
			id: "f1",
			kind: "formula",
			score: 0.92,
			bbox: { x: 0.2, y: 0.5, w: 0.55, h: 0.05 },
		});
		const num = region({
			id: "n1",
			kind: "formula_number",
			score: 0.88,
			bbox: { x: 0.85, y: 0.51, w: 0.08, h: 0.04 },
		});
		const bare = region({
			id: "f2",
			kind: "formula",
			score: 0.9,
			bbox: { x: 0.2, y: 0.7, w: 0.4, h: 0.04 },
		});

		const out = mergeCaptionsIntoHosts([image, figTitle, formula, num, bare]);
		const formulas = out.filter((r) => r.kind === "formula");
		expect(formulas).toHaveLength(1);
		expect(formulas[0]?.title).toBeUndefined();
		expect(formulas[0]?.titleBbox).toEqual(num.bbox);
		expect(out.some((r) => r.kind === "image" || r.kind === "chart")).toBe(
			true,
		);
		expect(out.some((r) => r.kind === "formula_number")).toBe(false);
	});
});
