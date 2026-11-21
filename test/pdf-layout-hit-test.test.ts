import { describe, expect, it } from "vitest";
import {
	layoutElementBoxes,
	layoutElementCaptionPage,
	layoutElementNeedsCrop,
	layoutElementPreview,
	layoutElementQuote,
} from "@/lib/pdf/layout/element-selection";
import {
	dropTruncatedSentencePrefixes,
	elementSentenceAtPoint,
	mergeSentenceItems,
} from "@/lib/pdf/layout/element-sentence";
import {
	bboxArea,
	hoverableLayoutRegions,
	hoverableLayoutRegionsByPage,
	hoverableLayoutRegionsOnPage,
	pickLayoutRegionAtPoint,
	pickSelectableLayoutRegion,
	pointInBbox,
	selectableLayoutRegions,
	selectableLayoutRegionsByPage,
} from "@/lib/pdf/layout/hit-test";
import { layoutSentenceScope } from "@/lib/pdf/layout/store";
import { sentenceHoverTextRegions } from "@/lib/pdf/layout/translatable";
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

describe("layout hit-test", () => {
	it("pointInBbox uses inclusive edges on normalized rects", () => {
		const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
		expect(pointInBbox(0.1, 0.2, box)).toBe(true);
		expect(pointInBbox(0.4, 0.6, box)).toBe(true);
		expect(pointInBbox(0.09, 0.2, box)).toBe(false);
		expect(pointInBbox(0.25, 0.61, box)).toBe(false);
	});

	it("filters to sidebar kinds above the score gate", () => {
		const regions = [
			region({
				id: "fig",
				kind: "image",
				score: 0.9,
				bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 },
			}),
			region({
				id: "body",
				kind: "text",
				score: 0.99,
				bbox: { x: 0.1, y: 0.5, w: 0.8, h: 0.2 },
			}),
			region({
				id: "low",
				kind: "table",
				score: 0.1,
				bbox: { x: 0.5, y: 0.1, w: 0.3, h: 0.2 },
			}),
			region({
				id: "formula",
				kind: "formula",
				score: 0.8,
				bbox: { x: 0.1, y: 0.7, w: 0.5, h: 0.05 },
			}),
		];
		const hoverable = hoverableLayoutRegions(regions);
		expect(hoverable.map((r) => r.id).sort()).toEqual(["fig", "formula"]);
	});

	it("paints larger boxes first so smaller overlays win pointer hits", () => {
		const regions = [
			region({
				id: "small",
				kind: "formula",
				score: 0.7,
				bbox: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 },
			}),
			region({
				id: "big",
				kind: "image",
				score: 0.9,
				bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
			}),
		];
		const ordered = hoverableLayoutRegionsOnPage(regions, 0);
		expect(ordered.map((r) => r.id)).toEqual(["big", "small"]);
		const [first, second] = ordered;
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		if (!first || !second) return;
		expect(bboxArea(first.bbox)).toBeGreaterThan(bboxArea(second.bbox));
	});

	it("prefers the smallest-area region under a point", () => {
		// Different sidebar kinds so NMS does not collapse them first.
		const regions = [
			region({
				id: "outer",
				kind: "image",
				score: 0.5,
				bbox: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 },
			}),
			region({
				id: "inner",
				kind: "formula",
				score: 0.4,
				bbox: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 },
			}),
		];
		const hit = pickLayoutRegionAtPoint(regions, 0, 0.25, 0.25);
		expect(hit?.id).toBe("inner");
	});

	it("breaks area ties with higher score", () => {
		const regions = [
			region({
				id: "a",
				kind: "table",
				score: 0.4,
				bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
			}),
			region({
				id: "b",
				kind: "algorithm",
				score: 0.9,
				bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
			}),
		];
		const hit = pickLayoutRegionAtPoint(regions, 0, 0.2, 0.2);
		expect(hit?.id).toBe("b");
	});

	it("buckets hoverable regions per page, largest first", () => {
		const regions = [
			region({
				id: "p1-small",
				pageIndex: 1,
				kind: "formula",
				score: 0.7,
				bbox: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 },
			}),
			region({
				id: "p1-big",
				pageIndex: 1,
				kind: "image",
				score: 0.9,
				bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
			}),
			region({
				id: "p0-table",
				pageIndex: 0,
				kind: "table",
				score: 0.8,
				bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
			}),
			region({
				id: "p2-body",
				pageIndex: 2,
				kind: "text",
				score: 0.99,
				bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 },
			}),
		];
		const byPage = hoverableLayoutRegionsByPage(regions);
		expect(byPage.get(0)?.map((r) => r.id)).toEqual(["p0-table"]);
		expect(byPage.get(1)?.map((r) => r.id)).toEqual(["p1-big", "p1-small"]);
		// Body text is not hoverable, so page 2 has no bucket at all.
		expect(byPage.has(2)).toBe(false);
	});

	it("keeps every kind for element selection, largest first", () => {
		const regions = [
			region({
				id: "header",
				kind: "header",
				score: 0.8,
				bbox: { x: 0.1, y: 0.02, w: 0.5, h: 0.03 },
			}),
			region({
				id: "body",
				kind: "text",
				score: 0.95,
				bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.4 },
			}),
			region({
				id: "abstract",
				kind: "abstract",
				score: 0.9,
				bbox: { x: 0.1, y: 0.55, w: 0.8, h: 0.15 },
			}),
			region({
				id: "caption",
				kind: "figure_title",
				score: 0.7,
				bbox: { x: 0.1, y: 0.75, w: 0.4, h: 0.04 },
			}),
			region({
				id: "low",
				kind: "text",
				score: 0.1,
				bbox: { x: 0.1, y: 0.9, w: 0.4, h: 0.05 },
			}),
			region({
				id: "speck",
				kind: "header",
				score: 0.99,
				bbox: { x: 0.9, y: 0.9, w: 0.01, h: 0.01 },
			}),
			region({
				id: "short-header",
				kind: "header",
				score: 0.85,
				bbox: { x: 0.1, y: 0.01, w: 0.2, h: 0.005 },
			}),
		];
		const selectable = selectableLayoutRegions(regions);
		expect(selectable.map((item) => item.id).sort()).toEqual([
			"abstract",
			"body",
			"caption",
			"header",
			"short-header",
		]);
		const byPage = selectableLayoutRegionsByPage(regions);
		expect(byPage.get(0)?.map((item) => item.id)).toEqual([
			"body",
			"abstract",
			"caption",
			"header",
			"short-header",
		]);
	});

	it("prefers the smallest selectable box, including text inside a figure", () => {
		const regions = selectableLayoutRegions([
			region({
				id: "figure",
				kind: "image",
				score: 0.9,
				bbox: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 },
			}),
			region({
				id: "paragraph",
				kind: "text",
				score: 0.8,
				bbox: { x: 0.15, y: 0.15, w: 0.2, h: 0.1 },
			}),
		]);
		expect(pickSelectableLayoutRegion(regions, 0.2, 0.2)?.id).toBe("paragraph");
		expect(pickSelectableLayoutRegion(regions, 0.5, 0.5)?.id).toBe("figure");
	});

	it("hits a figure through its same-page caption and ignores another page", () => {
		const figure = region({
			id: "fig",
			kind: "image",
			score: 0.9,
			bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 },
			captionBbox: { x: 0.1, y: 0.42, w: 0.4, h: 0.06 },
			captionPageIndex: 0,
			title: "Figure 1. Cats",
		});
		expect(layoutElementBoxes(figure).map((box) => box.key)).toEqual([
			"bbox",
			"caption",
		]);
		expect(pickSelectableLayoutRegion([figure], 0.2, 0.45)?.id).toBe("fig");
		expect(layoutElementCaptionPage(figure)).toBeNull();

		const split = region({
			...figure,
			captionPageIndex: 2,
		});
		expect(layoutElementBoxes(split).map((box) => box.key)).toEqual(["bbox"]);
		expect(pickSelectableLayoutRegion([split], 0.2, 0.45)).toBeNull();
		expect(layoutElementCaptionPage(split)).toBe(3);
	});

	it("quotes body text and figure titles, and clips the preview", () => {
		const body = region({
			id: "body",
			kind: "text",
			score: 0.9,
			bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 },
			text: "The  result\nis stable.",
			title: "unused title",
		});
		const figure = region({
			id: "fig",
			kind: "image",
			score: 0.9,
			bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 },
			title: "Figure 1. Cats",
			text: "caption body",
		});
		expect(layoutElementQuote(body)).toBe("The result is stable.");
		expect(layoutElementQuote(figure)).toBe("Figure 1. Cats");
		expect(layoutElementNeedsCrop(body.kind)).toBe(false);
		expect(layoutElementNeedsCrop(figure.kind)).toBe(true);
		expect(layoutElementPreview("short note")).toBe("short note");
		expect(layoutElementPreview("")).toBe("");
		const long = layoutElementPreview("a".repeat(80));
		expect(long.endsWith("…")).toBe(true);
		expect(long.length).toBeLessThanOrEqual(72);
	});

	it("can hit a line that crosses the element when the point is outside it", () => {
		const body = region({
			id: "body",
			kind: "text",
			score: 0.9,
			bbox: { x: 0.2, y: 0.2, w: 0.4, h: 0.05 },
		});
		expect(pickSelectableLayoutRegion([body], 0.05, 0.22)).toBeNull();
		expect(
			pickSelectableLayoutRegion([body], 0.05, 0.22, {
				x: 0,
				y: 0.21,
				w: 0.3,
				h: 0.02,
			})?.id,
		).toBe("body");
	});
});

describe("sentenceHoverTextRegions", () => {
	it("drops a low-score cross-column box and text inside an algorithm", () => {
		const kept = sentenceHoverTextRegions([
			region({
				id: "wide",
				kind: "text",
				score: 0.0086,
				bbox: { x: 0.157, y: 0.466, w: 0.679, h: 0.052 },
			}),
			region({
				id: "left",
				kind: "text",
				score: 0.92,
				bbox: { x: 0.08, y: 0.45, w: 0.36, h: 0.1 },
			}),
			region({
				id: "alg",
				kind: "algorithm",
				score: 0.88,
				bbox: { x: 0.08, y: 0.7, w: 0.84, h: 0.2 },
			}),
			region({
				id: "inner",
				kind: "text",
				score: 0.91,
				bbox: { x: 0.12, y: 0.74, w: 0.3, h: 0.04 },
			}),
		]);
		expect(kept.map((entry) => entry.id)).toEqual(["left"]);
	});

	it("drops a line box contained by the paragraph it repeats", () => {
		const kept = sentenceHoverTextRegions([
			region({
				id: "para",
				kind: "text",
				score: 0.9,
				bbox: { x: 0.1, y: 0.2, w: 0.35, h: 0.12 },
			}),
			region({
				id: "line",
				kind: "text",
				score: 0.8,
				bbox: { x: 0.1, y: 0.2, w: 0.35, h: 0.02 },
			}),
		]);
		expect(kept.map((entry) => entry.id)).toEqual(["para"]);
	});
});

describe("elementSentenceAtPoint", () => {
	const first = { x: 0.1, y: 0.1, w: 0.4, h: 0.05 };
	const second = { x: 0.1, y: 0.2, w: 0.3, h: 0.04 };
	const items = [
		{
			id: "body",
			pageIndex: 0,
			sentences: [
				{ quote: "First  sentence.", translated: "第一句。" },
				{ quote: "Second sentence.", translated: "第二句。" },
			],
		},
		{
			id: "next",
			pageIndex: 1,
			sentences: [
				{ quote: "Second sentence.", translated: "第二句。" },
				{ quote: "Second sentence.", translated: "另一译。" },
			],
		},
	];
	const glyphs = new Map([
		["body", [[first], [second]]],
		[
			"next",
			[
				[{ x: 0.2, y: 0.3, w: 0.2, h: 0.04 }],
				[{ x: 0.5, y: 0.5, w: 0.2, h: 0.04 }],
			],
		],
	]);

	it("keeps the element frame when the block has no sentence pairs", () => {
		expect(
			elementSentenceAtPoint({
				items: [{ id: "body", pageIndex: 0 }],
				glyphs,
				regionId: "body",
				x: 0.2,
				y: 0.12,
			}).status,
		).toBe("element");
	});

	it("returns the sentence under the point, collapsed, with its chain", () => {
		const located = elementSentenceAtPoint({
			items,
			glyphs,
			regionId: "body",
			x: 0.2,
			y: 0.21,
		});
		expect(located.status).toBe("sentence");
		if (located.status !== "sentence") return;
		expect(located.hit.quote).toBe("Second sentence.");
		expect(located.hit.rects).toEqual([second]);
		expect(located.hit.members.map((member) => member.itemId)).toEqual([
			"body",
			"next",
		]);
		expect(located.hit.members.map((member) => member.pageIndex)).toEqual([
			0, 1,
		]);
		expect(located.hit.members.map((member) => member.sentenceIndex)).toEqual([
			1, 0,
		]);
	});

	it("does not chain a slice whose translation differs", () => {
		const located = elementSentenceAtPoint({
			items,
			glyphs,
			regionId: "next",
			x: 0.55,
			y: 0.51,
		});
		expect(located.status).toBe("sentence");
		if (located.status !== "sentence") return;
		expect(located.hit.members).toEqual([
			{
				itemId: "next",
				pageIndex: 1,
				sentenceIndex: 1,
				quote: "Second sentence.",
			},
		]);
	});

	it("falls back to the element when the point misses every glyph", () => {
		expect(
			elementSentenceAtPoint({
				items,
				glyphs,
				regionId: "body",
				x: 0.2,
				y: 0.5,
			}).status,
		).toBe("element");
	});

	it("prefers the smaller sentence when boxes overlap", () => {
		const overlapping = new Map([
			[
				"body",
				[
					[{ x: 0.1, y: 0.1, w: 0.5, h: 0.2 }],
					[{ x: 0.15, y: 0.12, w: 0.1, h: 0.04 }],
				],
			],
		]);
		const located = elementSentenceAtPoint({
			items,
			glyphs: overlapping,
			regionId: "body",
			x: 0.16,
			y: 0.13,
		});
		expect(located.status).toBe("sentence");
		if (located.status !== "sentence") return;
		expect(located.hit.quote).toBe("Second sentence.");
	});

	it("waits for glyphs unless the overlay span already names the sentence", () => {
		expect(
			elementSentenceAtPoint({
				items,
				glyphs: new Map(),
				regionId: "body",
				x: 0.2,
				y: 0.12,
			}).status,
		).toBe("pending");
		const located = elementSentenceAtPoint({
			items,
			glyphs: new Map(),
			regionId: "body",
			x: 0.2,
			y: 0.12,
			span: { itemId: "body", sentenceIndex: 0 },
		});
		expect(located.status).toBe("sentence");
		if (located.status !== "sentence") return;
		expect(located.hit.quote).toBe("First sentence.");
		expect(located.hit.rects).toEqual([]);
	});

	it("merges pane catalogs and shares a paper scope", () => {
		expect(layoutSentenceScope("paper::translation")).toBe("paper");
		expect(layoutSentenceScope("paper::translation::r3")).toBe("paper");
		expect(layoutSentenceScope("paper::r2")).toBe("paper");
		const merged = mergeSentenceItems([
			[],
			[
				{
					id: "body",
					pageIndex: 0,
					sentences: [{ quote: "A", translated: "甲" }],
				},
			],
			[
				{
					id: "body",
					pageIndex: 0,
					sentences: [
						{ quote: "A", translated: "甲" },
						{ quote: "B", translated: "乙" },
					],
				},
			],
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.sentences).toHaveLength(2);
	});

	it("scans the block under the pointer instead of a smaller box on another block", () => {
		const pageItems = [
			{
				id: "a",
				pageIndex: 0,
				bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.08 },
				sentences: [{ quote: "Alpha sentence.", translated: "甲" }],
			},
			{
				id: "b",
				pageIndex: 0,
				bbox: { x: 0.1, y: 0.4, w: 0.4, h: 0.08 },
				sentences: [{ quote: "Beta sentence.", translated: "乙" }],
			},
		];
		const pageGlyphs = new Map([
			["a", [[{ x: 0.12, y: 0.12, w: 0.3, h: 0.04 }]]],
			["b", [[{ x: 0.12, y: 0.12, w: 0.05, h: 0.02 }]]],
		]);
		const located = elementSentenceAtPoint({
			items: pageItems,
			glyphs: pageGlyphs,
			regionId: "",
			pageIndex: 0,
			x: 0.14,
			y: 0.13,
		});
		expect(located.status).toBe("sentence");
		if (located.status !== "sentence") return;
		expect(located.hit.quote).toBe("Alpha sentence.");
	});

	it("still hits a sentence whose glyph sits just outside every block box", () => {
		const located = elementSentenceAtPoint({
			items: [
				{
					id: "a",
					pageIndex: 0,
					bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.05 },
					sentences: [{ quote: "Alpha sentence.", translated: "甲" }],
				},
			],
			glyphs: new Map([["a", [[{ x: 0.12, y: 0.2, w: 0.3, h: 0.04 }]]]]),
			regionId: "",
			pageIndex: 0,
			x: 0.14,
			y: 0.21,
		});
		expect(located.status).toBe("sentence");
		if (located.status !== "sentence") return;
		expect(located.hit.quote).toBe("Alpha sentence.");
	});

	it("drops a clipped block whose sentences are a prefix of a larger block", () => {
		const full = "Fetching Unit (Sec. 3.2) that dispatches the calls.";
		const items = [
			{
				id: "line",
				pageIndex: 0,
				bbox: { x: 0.1, y: 0.2, w: 0.35, h: 0.02 },
				sentences: [{ quote: "Fetching Unit (Sec.", translated: "" }],
			},
			{
				id: "para",
				pageIndex: 0,
				bbox: { x: 0.1, y: 0.2, w: 0.35, h: 0.08 },
				sentences: [{ quote: full, translated: "" }],
			},
		];
		expect(dropTruncatedSentencePrefixes(items).map((item) => item.id)).toEqual(
			["para"],
		);
		const located = elementSentenceAtPoint({
			items,
			glyphs: new Map([
				["line", [[{ x: 0.12, y: 0.2, w: 0.2, h: 0.015 }]]],
				["para", [[{ x: 0.12, y: 0.2, w: 0.3, h: 0.06 }]]],
			]),
			regionId: "",
			pageIndex: 0,
			x: 0.15,
			y: 0.205,
		});
		expect(located.status).toBe("sentence");
		if (located.status !== "sentence") return;
		expect(located.hit.quote).toBe(full);
	});

	it("does not invent a sentence from an empty quote", () => {
		expect(
			elementSentenceAtPoint({
				items: [
					{
						id: "body",
						pageIndex: 0,
						sentences: [{ quote: "   ", translated: "空" }],
					},
				],
				glyphs: new Map([["body", [[{ x: 0.1, y: 0.1, w: 0.2, h: 0.04 }]]]]),
				regionId: "body",
				x: 0.12,
				y: 0.12,
			}).status,
		).toBe("element");
	});
});
