import { describe, expect, it } from "vitest";

import { dedupeLayoutRegions } from "@/lib/pdf/layout/dedupe";
import { hoverableLayoutRegions } from "@/lib/pdf/layout/hit-test";
import { isFigureLayoutKind } from "@/lib/pdf/layout/labels";
import {
	areFigureNeighbors,
	bboxFullyContains,
	captionAttachScore,
	hostFamily,
	isMainFigureCaption,
	isMainTableCaption,
	mergeCaptionsIntoHosts,
	panelInTitleColumn,
	preferredCaptionPlacement,
	resolveFigureBboxOverlaps,
	selectClusterForTitle,
	suppressSpuriousFigureDetections,
	verticalCeilingForTitle,
} from "@/lib/pdf/layout/merge-captions";
import { paddlePageToRegions } from "@/lib/pdf/layout/paddle";
import {
	captionRoleFromText,
	resolveCaptionRole,
} from "@/lib/pdf/layout/title-text";
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

describe("family / placement", () => {
	it("maps host families and caption sides", () => {
		expect(hostFamily("chart")).toBe("figure");
		expect(hostFamily("table")).toBe("table");
		expect(preferredCaptionPlacement("figure")).toBe("below");
		expect(preferredCaptionPlacement("table")).toBe("above");
	});
});

describe("suppressSpuriousFigureDetections", () => {
	it("drops image dual-labeled on a confident text/header block", () => {
		const header = region({
			id: "h",
			kind: "header",
			score: 0.82,
			bbox: { x: 0.52, y: 0.83, w: 0.35, h: 0.016 },
		});
		const text = region({
			id: "t",
			kind: "text",
			score: 0.9,
			bbox: { x: 0.52, y: 0.85, w: 0.4, h: 0.05 },
		});
		// Same area as header+text — model dual-label as image.
		const fakeImg = region({
			id: "img",
			kind: "image",
			score: 0.4,
			bbox: { x: 0.52, y: 0.83, w: 0.4, h: 0.07 },
		});
		const out = suppressSpuriousFigureDetections([header, text, fakeImg]);
		expect(out.some((r) => r.kind === "image")).toBe(false);
		expect(
			out.filter((r) => r.kind === "header" || r.kind === "text"),
		).toHaveLength(2);
	});

	it("keeps real charts not covered by body text", () => {
		const chart = region({
			id: "c",
			kind: "chart",
			score: 0.9,
			bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 },
		});
		const text = region({
			id: "t",
			kind: "text",
			score: 0.95,
			// Below the chart — does not cover it.
			bbox: { x: 0.1, y: 0.5, w: 0.4, h: 0.2 },
		});
		const out = suppressSpuriousFigureDetections([chart, text]);
		expect(out.some((r) => r.id === "c")).toBe(true);
	});

	it("merge does not promote text-only blocks into figure cards", () => {
		const header = region({
			id: "h",
			kind: "header",
			score: 0.82,
			bbox: { x: 0.5, y: 0.2, w: 0.4, h: 0.03 },
			title: "5.3 Generalization to an Unseen Benchmark",
		});
		const text = region({
			id: "t",
			kind: "text",
			score: 0.9,
			bbox: { x: 0.5, y: 0.24, w: 0.4, h: 0.12 },
		});
		const fakeImg = region({
			id: "img",
			kind: "image",
			score: 0.45,
			bbox: { x: 0.5, y: 0.2, w: 0.4, h: 0.16 },
		});
		const cap = region({
			id: "ft",
			kind: "figure_title",
			score: 0.9,
			bbox: { x: 0.5, y: 0.37, w: 0.4, h: 0.04 },
			title: "Figure 9: Not a real figure.",
			captionRole: "figure_main",
		});
		const out = mergeCaptionsIntoHosts([header, text, fakeImg, cap]);
		expect(out.some((r) => isFigureLayoutKind(r.kind))).toBe(false);
	});
});

describe("Table mislabeled as figure_title", () => {
	it("binds Table 2 caption to table above body, not to figures", () => {
		const charts = [
			region({
				id: "c1",
				kind: "chart",
				score: 0.9,
				bbox: { x: 0.05, y: 0.05, w: 0.4, h: 0.25 },
			}),
			region({
				id: "c2",
				kind: "chart",
				score: 0.9,
				bbox: { x: 0.5, y: 0.05, w: 0.4, h: 0.25 },
			}),
		];
		const figTitle = region({
			id: "ft7",
			kind: "figure_title",
			score: 0.87,
			bbox: { x: 0.05, y: 0.32, w: 0.45, h: 0.1 },
			title: "Figure 7: Component and observation-model ablations.",
			captionRole: "figure_main",
		});
		// Model wrongly says figure_title but text is Table 2.
		const tableCap = region({
			id: "tc",
			kind: "figure_title",
			score: 0.91,
			bbox: { x: 0.05, y: 0.48, w: 0.5, h: 0.1 },
			title: "Table 2: Observation model input ablation on MSA",
			captionRole: "table_main",
		});
		const table = region({
			id: "tbl",
			kind: "table",
			score: 0.95,
			bbox: { x: 0.1, y: 0.6, w: 0.45, h: 0.25 },
		});

		expect(isMainTableCaption(tableCap)).toBe(true);
		expect(isMainFigureCaption(tableCap)).toBe(false);

		const out = mergeCaptionsIntoHosts([...charts, figTitle, tableCap, table]);
		const tbl = out.find((r) => r.kind === "table");
		expect(tbl?.titleBbox).toEqual(tableCap.bbox);
		expect(tbl?.title).toMatch(/Table 2/);
		// Figure cluster should not swallow the table caption.
		const fig = out.find((r) => r.id === "ft7" || r.kind === "chart");
		expect(fig?.titleBbox?.y).not.toBe(tableCap.bbox.y);
	});
});

describe("side-by-side figures with separate titles", () => {
	it("does not merge Fig 7 and Fig 8 columns", () => {
		const leftPanels = [
			region({
				id: "l1",
				kind: "chart",
				score: 0.9,
				bbox: { x: 0.02, y: 0.05, w: 0.22, h: 0.28 },
			}),
			region({
				id: "l2",
				kind: "chart",
				score: 0.9,
				bbox: { x: 0.26, y: 0.05, w: 0.22, h: 0.28 },
			}),
		];
		const rightPanels = [
			region({
				id: "r1",
				kind: "chart",
				score: 0.9,
				bbox: { x: 0.52, y: 0.05, w: 0.22, h: 0.28 },
			}),
			region({
				id: "r2",
				kind: "chart",
				score: 0.9,
				bbox: { x: 0.76, y: 0.05, w: 0.22, h: 0.28 },
			}),
		];
		const t7 = region({
			id: "t7",
			kind: "figure_title",
			score: 0.9,
			bbox: { x: 0.02, y: 0.36, w: 0.46, h: 0.12 },
			title: "Figure 7: Component ablations.",
			captionRole: "figure_main",
		});
		const t8 = region({
			id: "t8",
			kind: "figure_title",
			score: 0.9,
			bbox: { x: 0.52, y: 0.36, w: 0.46, h: 0.12 },
			title: "Figure 8: Action-model ablations.",
			captionRole: "figure_main",
		});

		expect(panelInTitleColumn(leftPanels[0].bbox, t7.bbox)).toBe(true);
		expect(panelInTitleColumn(rightPanels[0].bbox, t7.bbox)).toBe(false);

		const out = mergeCaptionsIntoHosts([...leftPanels, ...rightPanels, t7, t8]);
		expect(
			out.filter((r) => r.kind === "chart" || r.kind === "image"),
		).toHaveLength(2);
		const f7 = out.find((r) => r.id === "t7");
		const f8 = out.find((r) => r.id === "t8");
		expect(f7?.title).toMatch(/Figure 7/);
		expect(f8?.title).toMatch(/Figure 8/);
		// Left cluster should not extend into right column.
		expect((f7?.bbox.x ?? 0) + (f7?.bbox.w ?? 0)).toBeLessThan(0.55);
		expect(f8?.bbox.x ?? 0).toBeGreaterThan(0.45);
	});
});

describe("vertical ceiling between stacked figures", () => {
	it("prevents upper figure panels from joining lower title", () => {
		const upper = region({
			id: "u",
			kind: "chart",
			score: 0.9,
			bbox: { x: 0.1, y: 0.05, w: 0.8, h: 0.2 },
		});
		const t6 = region({
			id: "t6",
			kind: "figure_title",
			score: 0.9,
			bbox: { x: 0.1, y: 0.28, w: 0.8, h: 0.08 },
			title: "Figure 6: EV decoding.",
			captionRole: "figure_main",
		});
		const lower = region({
			id: "l",
			kind: "chart",
			score: 0.9,
			bbox: { x: 0.1, y: 0.4, w: 0.8, h: 0.2 },
		});
		const t7 = region({
			id: "t7",
			kind: "figure_title",
			score: 0.9,
			bbox: { x: 0.1, y: 0.62, w: 0.8, h: 0.08 },
			title: "Figure 7: Components.",
			captionRole: "figure_main",
		});

		const ceiling = verticalCeilingForTitle(t7, [t6, t7]);
		expect(ceiling).toBeGreaterThan(0.3);

		const cluster = selectClusterForTitle(t7, [upper, lower], [t6, t7]);
		expect(cluster.map((c) => c.id)).toEqual(["l"]);

		const out = mergeCaptionsIntoHosts([upper, t6, lower, t7]);
		expect(out).toHaveLength(2);
	});
});

describe("subpanel titles", () => {
	it("does not use (a)(b) as main anchors; absorbs into panels under Figure 2", () => {
		const panels = [0, 1, 2, 3].map((i) =>
			region({
				id: `p${i}`,
				kind: "chart",
				score: 0.5,
				bbox: { x: 0.02 + i * 0.24, y: 0.05, w: 0.22, h: 0.35 },
			}),
		);
		const subs = [0, 1, 2, 3].map((i) =>
			region({
				id: `s${i}`,
				kind: "figure_title",
				score: 0.6,
				bbox: { x: 0.04 + i * 0.24, y: 0.41, w: 0.18, h: 0.04 },
				title: `(${String.fromCharCode(97 + i)}) Panel`,
				captionRole: "subpanel",
			}),
		);
		const main = region({
			id: "main",
			kind: "figure_title",
			score: 0.91,
			bbox: { x: 0.05, y: 0.48, w: 0.9, h: 0.1 },
			title: "Figure 2: Motivating measurements from Terminal Bench.",
			captionRole: "figure_main",
		});
		const out = mergeCaptionsIntoHosts([...panels, ...subs, main]);
		expect(out).toHaveLength(1);
		expect(out[0]?.id).toBe("main");
		expect(out[0]?.title).toMatch(/Figure 2/);
	});
});

describe("full-width multi-panel aggregation (Fig 2 / Fig 4)", () => {
	it("takes all panels under a full-width title even if gaps break connectivity", () => {
		// Mixed chart/image with larger gutters (Figure 2 style).
		const panels = [
			region({
				id: "a",
				kind: "chart",
				score: 0.5,
				bbox: { x: 0.02, y: 0.05, w: 0.22, h: 0.35 },
			}),
			region({
				id: "b",
				kind: "chart",
				score: 0.45,
				bbox: { x: 0.28, y: 0.05, w: 0.22, h: 0.35 },
			}),
			region({
				id: "c",
				kind: "image",
				score: 0.36,
				bbox: { x: 0.54, y: 0.05, w: 0.22, h: 0.35 },
			}),
			region({
				id: "d",
				kind: "chart",
				score: 0.36,
				bbox: { x: 0.8, y: 0.05, w: 0.18, h: 0.35 },
			}),
		];
		const subs = panels.map((p, i) =>
			region({
				id: `s${i}`,
				kind: "figure_title",
				score: 0.5,
				bbox: {
					x: p.bbox.x + 0.02,
					y: 0.42,
					w: 0.16,
					h: 0.04,
				},
				title: `(${String.fromCharCode(97 + i)}) Sub`,
				captionRole: "subpanel",
			}),
		);
		const main = region({
			id: "main",
			kind: "figure_title",
			score: 0.91,
			bbox: { x: 0.05, y: 0.5, w: 0.9, h: 0.12 },
			title: "Figure 2: Motivating measurements.",
			captionRole: "figure_main",
		});
		const out = mergeCaptionsIntoHosts([...panels, ...subs, main]);
		expect(out).toHaveLength(1);
		expect(out[0]?.id).toBe("main");
		// Full width of four panels.
		expect(out[0]?.bbox.w).toBeGreaterThan(0.85);
	});

	it("does not collapse Figure 2 to the detected title block only", () => {
		const panels = [
			region({
				id: "chart-a",
				kind: "chart",
				score: 0.52,
				bbox: { x: 0.02, y: 0.1, w: 0.22, h: 0.23 },
			}),
			region({
				id: "chart-b",
				kind: "chart",
				score: 0.45,
				bbox: { x: 0.27, y: 0.1, w: 0.21, h: 0.23 },
			}),
			region({
				id: "image-c",
				kind: "image",
				score: 0.36,
				bbox: { x: 0.52, y: 0.1, w: 0.24, h: 0.23 },
			}),
			region({
				id: "chart-d",
				kind: "chart",
				score: 0.36,
				bbox: { x: 0.78, y: 0.1, w: 0.2, h: 0.23 },
			}),
		];
		const subs = panels.map((p, i) =>
			region({
				id: `sub-${i}`,
				kind: "figure_title",
				score: 0.5,
				bbox: {
					x: p.bbox.x + 0.02,
					y: 0.35,
					w: 0.16,
					h: 0.04,
				},
				title: `(${String.fromCharCode(97 + i)}) Sub`,
				captionRole: "subpanel",
			}),
		);
		// Detector may produce one large figure_title over subcaptions + main caption.
		const detectedTitleBlock = region({
			id: "figure-2-title",
			kind: "figure_title",
			score: 0.91,
			bbox: { x: 0.02, y: 0.36, w: 0.96, h: 0.2 },
			title:
				"Figure 2: Motivating measurements from Terminal Bench. (a) Concentration.",
			captionRole: "figure_main",
		});

		const out = mergeCaptionsIntoHosts([
			...panels,
			...subs,
			detectedTitleBlock,
		]);

		expect(out).toHaveLength(1);
		expect(out[0]?.id).toBe("figure-2-title");
		// The merged figure must include the visual body above the title block.
		expect(out[0]?.bbox.y).toBeLessThanOrEqual(panels[0].bbox.y + 1e-9);
		expect(out[0]?.bbox.y).toBeLessThan(detectedTitleBlock.bbox.y);
		expect(out[0]?.bbox.w).toBeGreaterThan(0.9);
	});

	it("keeps tall multi-row panels under full-width title (no maxHeight cut)", () => {
		// Figure 4 style: 3 rows × 3 cols, span ~0.65 page height — old maxHeight=0.55
		// dropped the top row; bottom row slightly bleeds into the caption.
		const panels: PdfLayoutRegion[] = [];
		const cols = [0.05, 0.35, 0.65];
		const rows = [0.08, 0.28, 0.48];
		let n = 0;
		for (const y of rows) {
			for (const x of cols) {
				n += 1;
				panels.push(
					region({
						id: `c${n}`,
						kind: "chart",
						score: 0.7 + n * 0.01,
						bbox: { x, y, w: 0.28, h: 0.18 },
					}),
				);
			}
		}
		// Bottom-right bleeds ~0.08 past title top (model caption overlap).
		const bleed = region({
			id: "c-bleed",
			kind: "chart",
			score: 0.85,
			bbox: { x: 0.35, y: 0.52, w: 0.28, h: 0.2 },
		});
		const title = region({
			id: "ft4",
			kind: "figure_title",
			score: 0.9,
			bbox: { x: 0.05, y: 0.72, w: 0.9, h: 0.08 },
			title:
				"Figure 4: End-to-end latency savings across nine Terminal-Bench harnesses.",
			captionRole: "figure_main",
		});
		const legend = region({
			id: "leg",
			kind: "header",
			score: 0.55,
			bbox: { x: 0.2, y: 0.02, w: 0.55, h: 0.04 },
			title: "Oracle-action Spec. Actions AOSpec",
		});

		const cluster = selectClusterForTitle(title, [...panels, bleed], [title]);
		// All 9 grid cells + bottom bleed row piece.
		expect(cluster.length).toBeGreaterThanOrEqual(9);
		expect(cluster.map((c) => c.id)).toEqual(
			expect.arrayContaining(panels.map((p) => p.id)),
		);
		expect(cluster.some((c) => c.id === "c-bleed")).toBe(true);

		// Top row is farther than 0.55 above title — must still be included.
		const topIds = panels.filter((p) => p.bbox.y < 0.15).map((p) => p.id);
		for (const id of topIds) {
			expect(cluster.some((c) => c.id === id)).toBe(true);
		}

		const out = mergeCaptionsIntoHosts([...panels, bleed, title, legend]);
		expect(out).toHaveLength(1);
		const host = out[0];
		expect(host).toBeDefined();
		if (!host) return;
		expect(host.kind === "chart" || host.kind === "image").toBe(true);
		expect(host.title).toMatch(/Figure 4/);
		// Host covers top row through full caption.
		expect(host.bbox.y).toBeLessThanOrEqual(0.08 + 1e-9);
		expect(host.bbox.y + host.bbox.h).toBeGreaterThanOrEqual(
			title.bbox.y + title.bbox.h - 1e-9,
		);
	});
});

describe("side-by-side figures must not become thin slivers", () => {
	it("keeps Fig 7 / Fig 8 reasonably separate with sane widths", () => {
		const leftPanels = [
			region({
				id: "l1",
				kind: "chart",
				score: 0.9,
				bbox: { x: 0.02, y: 0.05, w: 0.22, h: 0.28 },
			}),
			region({
				id: "l2",
				kind: "chart",
				score: 0.9,
				bbox: { x: 0.26, y: 0.05, w: 0.22, h: 0.28 },
			}),
		];
		const rightPanels = [
			region({
				id: "r1",
				kind: "chart",
				score: 0.9,
				bbox: { x: 0.52, y: 0.05, w: 0.22, h: 0.28 },
			}),
			region({
				id: "r2",
				kind: "chart",
				score: 0.9,
				bbox: { x: 0.76, y: 0.05, w: 0.22, h: 0.28 },
			}),
		];
		const t7 = region({
			id: "t7",
			kind: "figure_title",
			score: 0.9,
			bbox: { x: 0.02, y: 0.4, w: 0.46, h: 0.14 },
			title: "Figure 7: Left.",
			captionRole: "figure_main",
		});
		const t8 = region({
			id: "t8",
			kind: "figure_title",
			score: 0.9,
			bbox: { x: 0.52, y: 0.4, w: 0.46, h: 0.14 },
			title: "Figure 8: Right.",
			captionRole: "figure_main",
		});
		const out = mergeCaptionsIntoHosts([...leftPanels, ...rightPanels, t7, t8]);
		const f7 = out.find((r) => r.id === "t7");
		const f8 = out.find((r) => r.id === "t8");
		expect(f7).toBeDefined();
		expect(f8).toBeDefined();
		if (!f7 || !f8) return;
		// Never produce a thin vertical strip (the prior mid-split bug).
		expect(f7.bbox.w).toBeGreaterThan(0.25);
		expect(f8.bbox.w).toBeGreaterThan(0.25);
	});

	it("does not mid-split a full-width Figure 2 into a thin strip", () => {
		const panels = [0, 1, 2, 3].map((i) =>
			region({
				id: `p${i}`,
				kind: i === 2 ? "image" : "chart",
				score: 0.5,
				bbox: { x: 0.02 + i * 0.24, y: 0.05, w: 0.22, h: 0.35 },
			}),
		);
		const main = region({
			id: "main",
			kind: "figure_title",
			score: 0.91,
			bbox: { x: 0.05, y: 0.5, w: 0.9, h: 0.12 },
			title: "Figure 2: Motivating measurements.",
			captionRole: "figure_main",
		});
		const out = mergeCaptionsIntoHosts([...panels, main]);
		const fig = out.find((r) => r.id === "main");
		expect(fig).toBeDefined();
		if (!fig) return;
		expect(fig.bbox.w).toBeGreaterThan(0.7);
		const figureHosts = out.filter(
			(r) => r.kind === "chart" || r.kind === "image",
		);
		expect(figureHosts.length).toBe(1);
	});
});

describe("figure_title must be fully inside host box", () => {
	it("half-width Fig 7/8 each fully contain their own title", () => {
		const leftPanels = [
			region({
				id: "l1",
				kind: "chart",
				score: 0.9,
				bbox: { x: 0.02, y: 0.05, w: 0.22, h: 0.28 },
			}),
			region({
				id: "l2",
				kind: "chart",
				score: 0.9,
				bbox: { x: 0.26, y: 0.05, w: 0.22, h: 0.28 },
			}),
		];
		const rightPanels = [
			region({
				id: "r1",
				kind: "chart",
				score: 0.9,
				bbox: { x: 0.52, y: 0.05, w: 0.22, h: 0.28 },
			}),
			region({
				id: "r2",
				kind: "chart",
				score: 0.9,
				bbox: { x: 0.76, y: 0.05, w: 0.22, h: 0.28 },
			}),
		];
		const t7 = region({
			id: "t7",
			kind: "figure_title",
			score: 0.9,
			bbox: { x: 0.02, y: 0.4, w: 0.46, h: 0.14 },
			title: "Figure 7: Left full caption text that is wide.",
			captionRole: "figure_main",
		});
		const t8 = region({
			id: "t8",
			kind: "figure_title",
			score: 0.9,
			bbox: { x: 0.52, y: 0.4, w: 0.46, h: 0.14 },
			title: "Figure 8: Right full caption text that is wide.",
			captionRole: "figure_main",
		});
		const out = mergeCaptionsIntoHosts([...leftPanels, ...rightPanels, t7, t8]);
		const f7 = out.find((r) => r.id === "t7");
		const f8 = out.find((r) => r.id === "t8");
		expect(f7?.titleBbox).toBeDefined();
		expect(f8?.titleBbox).toBeDefined();
		if (!f7?.titleBbox || !f8?.titleBbox) return;
		expect(bboxFullyContains(f7.bbox, f7.titleBbox)).toBe(true);
		expect(bboxFullyContains(f8.bbox, f8.titleBbox)).toBe(true);
		// Every figure has a title.
		for (const h of out) {
			if (h.kind === "chart" || h.kind === "image") {
				expect(h.titleBbox).toBeDefined();
			}
		}
	});

	it("preserves reliable untitled figure panels", () => {
		const orphan = region({
			id: "orphan",
			kind: "chart",
			score: 0.9,
			bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
		});
		const out = mergeCaptionsIntoHosts([orphan]);
		expect(out.filter((r) => r.kind === "chart")).toEqual([orphan]);
	});
});

describe("basic 联图", () => {
	it("clusters two charts under one figure_title", () => {
		const a = region({
			id: "a",
			kind: "chart",
			score: 0.45,
			bbox: { x: 0.05, y: 0.1, w: 0.42, h: 0.4 },
		});
		const b = region({
			id: "b",
			kind: "chart",
			score: 0.48,
			bbox: { x: 0.52, y: 0.1, w: 0.42, h: 0.4 },
		});
		const title = region({
			id: "t",
			kind: "figure_title",
			score: 0.89,
			bbox: { x: 0.08, y: 0.55, w: 0.84, h: 0.1 },
			title: "Figure 5: SWE-bench transfer.",
			captionRole: "figure_main",
		});
		const out = mergeCaptionsIntoHosts([a, b, title]);
		expect(out).toHaveLength(1);
		expect(out[0]?.title).toMatch(/Figure 5/);
	});

	it("detects side-by-side neighbors", () => {
		expect(
			areFigureNeighbors(
				{ x: 0.05, y: 0.1, w: 0.4, h: 0.35 },
				{ x: 0.5, y: 0.1, w: 0.4, h: 0.35 },
			),
		).toBe(true);
	});

	it("scores table caption only when above", () => {
		const host = { x: 0.1, y: 0.3, w: 0.8, h: 0.4 };
		const above = { x: 0.15, y: 0.22, w: 0.7, h: 0.05 };
		const below = { x: 0.15, y: 0.72, w: 0.7, h: 0.05 };
		expect(captionAttachScore(host, above, "above")).toBeGreaterThan(0);
		expect(Number.isFinite(captionAttachScore(host, below, "above"))).toBe(
			false,
		);
	});
});

// --- figure aggregation regressions (merged from pdf-layout-figure-regressions) ---

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

// --- missing figure captions (merged from pdf-layout-missing-captions) ---

function pageRegion(
	id: string,
	kind: PdfLayoutRegion["kind"],
	pageIndex = 0,
	bbox = { x: 0.1, y: 0.1, w: 0.8, h: 0.6 },
	text?: string,
): PdfLayoutRegion {
	return {
		id,
		kind,
		label: kind,
		pageIndex,
		bbox,
		score: 0.95,
		readingOrder: 0,
		rect: {
			x: bbox.x * 600,
			y: bbox.y * 800,
			w: bbox.w * 600,
			h: bbox.h * 800,
		},
		...(kind === "figure_title" ? { title: text } : { text }),
	};
}
const hoverFigures = (raw: PdfLayoutRegion[]) =>
	hoverableLayoutRegions(mergeCaptionsIntoHosts(raw)).filter(
		(r) => r.kind === "image" || r.kind === "chart",
	);

describe("missing figure captions (#704)", () => {
	it("keeps an uncaptioned image through both title gates without changing its geometry", () => {
		const image = pageRegion("image", "image");
		expect(hoverFigures([image])).toEqual([image]);
	});
	it("still rejects low scores, tiny boxes, body dual-labels and table duplicates", () => {
		const image = pageRegion("image", "image");
		expect(hoverFigures([{ ...image, score: 0.1 }])).toEqual([]);
		expect(
			hoverFigures([
				pageRegion("tiny", "image", 0, { x: 0.1, y: 0.1, w: 0.01, h: 0.01 }),
			]),
		).toEqual([]);
		expect(hoverFigures([image, pageRegion("body", "text")])).toEqual([]);
		expect(hoverFigures([image, pageRegion("table", "table")])).toEqual([]);
	});
	it.each([
		"Fig. 2 | Experiments.",
		"Extended Data Fig. 2 | Experiments.",
	])("recovers %s from body text", (text) => {
		const image = pageRegion("image", "image");
		const caption = pageRegion(
			"caption",
			"text",
			0,
			{ x: 0.1, y: 0.72, w: 0.8, h: 0.08 },
			text,
		);
		const out = hoverFigures([image, caption]);
		expect(out).toHaveLength(1);
		expect(out[0].title).toBe(text);
		expect(out[0].titleBbox).toEqual(caption.bbox);
	});
	it("does not absorb aligned right-column prose without reading-order evidence", () => {
		const left = pageRegion("left", "image", 0, {
			x: 0.05,
			y: 0.1,
			w: 0.4,
			h: 0.4,
		});
		const right = pageRegion("right", "chart", 0, {
			x: 0.55,
			y: 0.1,
			w: 0.4,
			h: 0.4,
		});
		const caption = pageRegion(
			"caption",
			"text",
			0,
			{ x: 0.05, y: 0.54, w: 0.43, h: 0.2 },
			"Fig. 2 | Main caption. a, Experimental results and descriptions.",
		);
		const continuation = pageRegion(
			"continuation",
			"text",
			0,
			{ x: 0.52, y: 0.54, w: 0.43, h: 0.2 },
			"b, Additional experimental results in the right column. Error bars indicate standard deviation across independent experiments.",
		);
		const out = hoverFigures([left, right, caption, continuation]);
		expect(out).toHaveLength(2);
		expect(out.find((r) => r.title)?.bbox.x).toBeCloseTo(0.05);
		expect(out.find((r) => r.title)?.title).toBe(caption.text);
		expect(out.find((r) => r.id === "right")).toEqual(right);
	});
	it.each([
		-1, 1,
	])("associates an unambiguous adjacent-page caption (%s), never unions its geometry", (direction) => {
		const image = pageRegion("image", "image", 1);
		const caption = pageRegion(
			"caption",
			"text",
			1 + direction,
			{ x: 0.05, y: direction < 0 ? 0.72 : 0.08, w: 0.9, h: 0.2 },
			"Fig. 1 | Complete figure caption.",
		);
		const out = hoverFigures([image, caption]);
		expect(out).toHaveLength(1);
		expect(out[0].title).toBe(caption.text);
		expect(out[0].pageIndex).toBe(1);
		expect(out[0].bbox).toEqual(image.bbox);
		expect(out[0].rect).toEqual(image.rect);
		expect(out[0].titleBbox).toBeUndefined();
		expect(out[0].captionPageIndex).toBe(1 + direction);
		expect(out[0].captionBbox).toEqual(caption.bbox);
	});
	it("does not guess between adjacent pages or competing captions", () => {
		const caption = pageRegion(
			"caption",
			"text",
			0,
			{ x: 0.05, y: 0.72, w: 0.9, h: 0.2 },
			"Fig. 1 | Ambiguous caption.",
		);
		const after = pageRegion(
			"after",
			"text",
			2,
			{ x: 0.05, y: 0.08, w: 0.9, h: 0.2 },
			"Fig. 2 | Another eligible caption.",
		);
		const image = pageRegion("image", "image", 1);
		expect(hoverFigures([image, caption, after])).toEqual([image]);
	});
	it("does not overwrite an explicit host figure number with a different adjacent caption", () => {
		const image = {
			...pageRegion("image", "image", 1),
			title: "Fig. 2 | Known image.",
		};
		const caption = pageRegion(
			"caption",
			"text",
			0,
			{ x: 0.05, y: 0.75, w: 0.9, h: 0.2 },
			"Fig. 1 | Different image.",
		);
		expect(hoverFigures([image, caption])).toEqual([image]);
	});
	it("respects the figure number in a next-page caption hint", () => {
		const image = pageRegion("image", "image", 1);
		const hint = pageRegion(
			"hint",
			"figure_title",
			1,
			{ x: 0.1, y: 0.75, w: 0.8, h: 0.03 },
			"Extended Data Fig. 4 | See next page for caption.",
		);
		const wrong = pageRegion(
			"wrong",
			"text",
			2,
			{ x: 0.1, y: 0.08, w: 0.8, h: 0.1 },
			"Extended Data Fig. 5 | Another figure.",
		);
		expect(hoverFigures([image, hint, wrong])).toEqual([image]);
		const right = {
			...wrong,
			text: "Extended Data Fig. 4 | Complete caption.",
		};
		expect(hoverFigures([image, hint, right])[0]).toMatchObject({
			title: right.text,
			captionPageIndex: 2,
			bbox: image.bbox,
		});
	});
	it("does not group distant uncaptioned images or reinterpret a prose reference", () => {
		const a = pageRegion("a", "image", 0, { x: 0.1, y: 0.1, w: 0.3, h: 0.2 });
		const b = pageRegion("b", "image", 0, { x: 0.6, y: 0.6, w: 0.3, h: 0.2 });
		const text = pageRegion(
			"prose",
			"text",
			0,
			{ x: 0.1, y: 0.33, w: 0.3, h: 0.1 },
			"Figure 5 contains the experimental results.",
		);
		const out = hoverFigures([a, b, text]);
		expect(out).toHaveLength(2);
		expect(out.every((r) => !r.title && !r.titleBbox)).toBe(true);
	});
	it("preserves hosted caption text without inventing caption geometry", () => {
		const raw = paddlePageToRegions({
			pageIndex: 0,
			pageWidth: 600,
			pageHeight: 800,
			idPrefix: "mineru",
			page: {
				widthPx: 600,
				heightPx: 800,
				boxes: [
					{
						clsId: -1,
						label: "image",
						score: 1,
						coordinate: [60, 80, 540, 560],
						caption: "Fig. 1 | Known caption.",
						text: null,
					},
				],
			},
		});
		expect(raw[0].title).toBe("Fig. 1 | Known caption.");
		const out = hoverFigures(raw);
		expect(out).toHaveLength(1);
		expect(out[0].titleBbox).toBeUndefined();
	});
	it("deduplicates text-only titled hosts without deleting both of them", () => {
		const image = {
			...pageRegion("image", "image"),
			title: "Fig. 1 | Known caption.",
		};
		const duplicate = {
			...pageRegion("duplicate", "chart", 0, {
				x: 0.11,
				y: 0.11,
				w: 0.78,
				h: 0.58,
			}),
			title: image.title,
		};
		expect(hoverFigures([image, duplicate])).toEqual([image]);
	});
});

// --- caption roles (merged from pdf-layout-caption-role) ---

describe("captionRoleFromText", () => {
	it("detects main figure / table / algorithm", () => {
		expect(captionRoleFromText("Figure 7: Components")).toBe("figure_main");
		expect(captionRoleFromText("Fig. 2. Overview")).toBe("figure_main");
		expect(
			captionRoleFromText("Table 2: Observation model input ablation on MSA"),
		).toBe("table_main");
		expect(captionRoleFromText("Algorithm 1 Training")).toBe("algorithm_main");
	});

	it("detects subpanel titles", () => {
		expect(captionRoleFromText("(a) Concentration")).toBe("subpanel");
		expect(captionRoleFromText("(b) Latency scatter")).toBe("subpanel");
		expect(captionRoleFromText("(c) Qualitative examples")).toBe("subpanel");
	});
});

describe("resolveCaptionRole", () => {
	it("uses text over model kind for Table mislabeled as figure_title", () => {
		const r = region({
			id: "t",
			kind: "figure_title",
			score: 0.9,
			bbox: { x: 0.1, y: 0.5, w: 0.8, h: 0.08 },
			title: "Table 2: Observation model input ablation",
		});
		expect(resolveCaptionRole(r)).toBe("table_main");
	});

	it("leaves unreadable narrow captions ambiguous", () => {
		const r = region({
			id: "s",
			kind: "figure_title",
			score: 0.9,
			bbox: { x: 0.1, y: 0.4, w: 0.2, h: 0.04 },
		});
		expect(resolveCaptionRole(r)).toBe("other");
	});
});
