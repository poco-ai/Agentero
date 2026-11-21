import { describe, expect, it } from "vitest";
import { dedupeLayoutRegions } from "@/lib/pdf/layout/dedupe";
import { isFigureLayoutKind } from "@/lib/pdf/layout/labels";
import {
	bboxFullyContains,
	mergeCaptionsIntoHosts,
	resolveFigureBboxOverlaps,
	selectClusterForTitle,
} from "@/lib/pdf/layout/merge-captions";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

function box(
	id: string,
	kind: PdfLayoutRegion["kind"],
	x: number,
	y: number,
	w: number,
	h: number,
	title?: string,
	score = 0.9,
): PdfLayoutRegion {
	return {
		id,
		kind,
		label: kind,
		pageIndex: 0,
		readingOrder: 0,
		score,
		bbox: { x, y, w, h },
		rect: { x: x * 100, y: y * 100, w: w * 100, h: h * 100 },
		title,
	};
}
const figures = (regions: PdfLayoutRegion[]) =>
	dedupeLayoutRegions(
		mergeCaptionsIntoHosts(regions).filter((region) =>
			isFigureLayoutKind(region.kind),
		),
	);

describe("figure aggregation regressions", () => {
	it("preserves both rows in the right column when the left caption is higher", () => {
		const left = box(
			"left",
			"figure_title",
			0.05,
			0.3,
			0.4,
			0.04,
			"Figure 1: Left",
		);
		const right = box(
			"right",
			"figure_title",
			0.55,
			0.65,
			0.4,
			0.04,
			"Figure 2: Right",
		);
		const panels = [
			box("top", "chart", 0.55, 0.1, 0.4, 0.2),
			box("bottom", "chart", 0.55, 0.36, 0.4, 0.25),
		];
		expect(
			selectClusterForTitle(right, panels, [left, right]).map((r) => r.id),
		).toEqual(["top", "bottom"]);
		const result = figures([...panels, left, right]);
		expect(result).toHaveLength(1);
		for (const panel of panels)
			expect(bboxFullyContains(result[0].bbox, panel.bbox)).toBe(true);
	});
	it("does not crop vertically separate figures or mutate their input", () => {
		const hosts = [0.05, 0.5].map((y, i) => ({
			...box(`f${i}`, "chart", 0.05, y, 0.45, 0.25, `Figure ${i + 1}`),
			titleBbox: { x: 0.15, y: y + 0.21, w: 0.25, h: 0.04 },
		}));
		const before = structuredClone(hosts);
		expect(resolveFigureBboxOverlaps(hosts)).toEqual(before);
		expect(hosts).toEqual(before);
	});
	it("still separates overlapping side-by-side hosts and preserves captions", () => {
		const left = {
			...box("l", "chart", 0.05, 0.1, 0.5, 0.3),
			titleBbox: { x: 0.05, y: 0.35, w: 0.35, h: 0.05 },
		};
		const right = {
			...box("r", "chart", 0.45, 0.1, 0.5, 0.3),
			titleBbox: { x: 0.6, y: 0.35, w: 0.35, h: 0.05 },
		};
		const out = resolveFigureBboxOverlaps([left, right]);
		expect(out[0].bbox.x + out[0].bbox.w).toBeLessThan(out[1].bbox.x);
		for (const r of out) {
			expect(r.titleBbox).toBeDefined();
			if (r.titleBbox)
				expect(bboxFullyContains(r.bbox, r.titleBbox)).toBe(true);
		}
	});
	it.each([
		0.01, 0.9,
	])("does not swallow a distant unrelated image with score %s", (score) => {
		const title = box(
			"title",
			"figure_title",
			0.05,
			0.7,
			0.9,
			0.05,
			"Figure 3: Chart",
		);
		const panel = box("panel", "chart", 0.05, 0.5, 0.9, 0.15);
		const noise = box("noise", "image", 0.1, 0.1, 0.2, 0.1, undefined, score);
		const out = figures([panel, title, noise]);
		expect(out.find((r) => r.id === "title")).toEqual(
			figures([panel, title])[0],
		);
		expect(out.filter((r) => r.id === "noise")).toHaveLength(
			score >= 0.3 ? 1 : 0,
		);
	});
	it("does not let a low-score nearby panel or caption enlarge a real figure", () => {
		const title = box(
			"title",
			"figure_title",
			0.1,
			0.4,
			0.4,
			0.05,
			"Figure 1: Chart",
		);
		const panel = box("panel", "chart", 0.1, 0.1, 0.4, 0.25);
		const noise = box("noise", "image", 0.1, 0.03, 0.4, 0.05, undefined, 0.01);
		const caption = box(
			"noise-title",
			"header",
			0.01,
			0.05,
			0.55,
			0.04,
			"Legend",
			0.01,
		);
		expect(figures([panel, title, noise, caption])).toEqual(
			figures([panel, title]),
		);
	});
	it("keeps a short single-column caption when the PDF has no text layer", () => {
		const panel = box("panel", "chart", 0.1, 0.1, 0.35, 0.25);
		const title = box("title", "figure_title", 0.1, 0.4, 0.35, 0.04);
		const out = figures([panel, title]);
		expect(out).toHaveLength(1);
		expect(bboxFullyContains(out[0].bbox, panel.bbox)).toBe(true);
		expect(out[0].titleBbox).toEqual(title.bbox);
	});
	it("keeps multiple panels under a narrow caption with missing text", () => {
		const panels = [
			box("a", "chart", 0.1, 0.1, 0.16, 0.25),
			box("b", "chart", 0.29, 0.1, 0.16, 0.25),
		];
		const title = box("title", "figure_title", 0.1, 0.4, 0.35, 0.04);
		const out = figures([...panels, title]);
		expect(out).toHaveLength(1);
		for (const p of panels)
			expect(bboxFullyContains(out[0].bbox, p.bbox)).toBe(true);
	});
	it("does not let unreadable subcaptions steal panels from a known main title", () => {
		const panels = [
			box("a", "chart", 0.05, 0.1, 0.4, 0.2),
			box("b", "chart", 0.55, 0.1, 0.4, 0.2),
		];
		const captions = [
			box("a-sub", "figure_title", 0.1, 0.32, 0.2, 0.03),
			box("b-sub", "figure_title", 0.6, 0.32, 0.2, 0.03),
		];
		const main = box(
			"main",
			"figure_title",
			0.05,
			0.4,
			0.9,
			0.05,
			"Figure 1: Comparison",
		);
		const out = figures([...panels, ...captions, main]);
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe("main");
		for (const p of panels)
			expect(bboxFullyContains(out[0].bbox, p.bbox)).toBe(true);
	});
	it("does not join panels across intervening body text", () => {
		const upper = box("upper", "image", 0.1, 0.1, 0.8, 0.2);
		const body = box("body", "text", 0.1, 0.31, 0.8, 0.04);
		const lower = box("lower", "chart", 0.1, 0.36, 0.8, 0.2);
		const title = box(
			"title",
			"figure_title",
			0.1,
			0.6,
			0.8,
			0.05,
			"Figure 1: Lower",
		);
		const out = figures([upper, body, lower, title]);
		expect(out).toHaveLength(2);
		expect(out.find((r) => r.id === "title")?.bbox.y).toBeCloseTo(0.36);
		expect(out.find((r) => r.id === "upper")).toEqual(upper);
	});
});

it("recomputes a cached geometry-only subpanel role", () => {
	const panel = box("panel", "chart", 0.1, 0.1, 0.35, 0.25);
	const caption = {
		...box("caption", "figure_title", 0.1, 0.4, 0.35, 0.04),
		captionRole: "subpanel" as const,
	};
	expect(figures([panel, caption])).toHaveLength(1);
});
it("does not bypass text barriers through the single-figure fallback", () => {
	const panel = box("panel", "chart", 0.1, 0.1, 0.35, 0.2);
	const body = box("body", "text", 0.1, 0.31, 0.35, 0.04);
	const caption = box(
		"caption",
		"figure_title",
		0.1,
		0.4,
		0.35,
		0.04,
		"Figure 1",
	);
	expect(figures([panel, body, caption])).toEqual([panel]);
});

it("recovers confident caption text without admitting low-score caption duplicates", () => {
	const panel = box("panel", "image", 0.65, 0.43, 0.16, 0.22);
	const caption = {
		...box("caption", "text", 0.625, 0.67, 0.2, 0.07),
		text: "Figure 6: Representative examples of attention.",
	};
	const duplicate = box(
		"duplicate",
		"figure_title",
		0.625,
		0.67,
		0.2,
		0.025,
		"Figure 6: Representative",
		0.01,
	);
	const out = figures([panel, caption, duplicate]);
	expect(out).toHaveLength(1);
	expect(out[0].titleBbox).toEqual(caption.bbox);
	expect(out[0].title).toBe(caption.text);
	expect(caption.kind).toBe("text");
});
it("does not reinterpret a prose cross-reference as a caption", () => {
	const panel = box("panel", "image", 0.1, 0.1, 0.8, 0.2);
	const body = {
		...box("body", "text", 0.1, 0.33, 0.8, 0.05),
		text: "Figure 5 contains the transfer performance versus cost.",
	};
	expect(figures([panel, body])).toEqual([panel]);
});
