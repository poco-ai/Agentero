import { describe, expect, it } from "vitest";
import { hoverableLayoutRegions } from "@/lib/pdf/layout/hit-test";
import { mergeCaptionsIntoHosts } from "@/lib/pdf/layout/merge-captions";
import { paddlePageToRegions } from "@/lib/pdf/layout/paddle";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

function region(
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
const figures = (raw: PdfLayoutRegion[]) =>
	hoverableLayoutRegions(mergeCaptionsIntoHosts(raw)).filter(
		(r) => r.kind === "image" || r.kind === "chart",
	);

describe("missing figure captions (#704)", () => {
	it("keeps an uncaptioned image through both title gates without changing its geometry", () => {
		const image = region("image", "image");
		expect(figures([image])).toEqual([image]);
	});
	it("still rejects low scores, tiny boxes, body dual-labels and table duplicates", () => {
		const image = region("image", "image");
		expect(figures([{ ...image, score: 0.1 }])).toEqual([]);
		expect(
			figures([
				region("tiny", "image", 0, { x: 0.1, y: 0.1, w: 0.01, h: 0.01 }),
			]),
		).toEqual([]);
		expect(figures([image, region("body", "text")])).toEqual([]);
		expect(figures([image, region("table", "table")])).toEqual([]);
	});
	it.each([
		"Fig. 2 | Experiments.",
		"Extended Data Fig. 2 | Experiments.",
	])("recovers %s from body text", (text) => {
		const image = region("image", "image");
		const caption = region(
			"caption",
			"text",
			0,
			{ x: 0.1, y: 0.72, w: 0.8, h: 0.08 },
			text,
		);
		const out = figures([image, caption]);
		expect(out).toHaveLength(1);
		expect(out[0].title).toBe(text);
		expect(out[0].titleBbox).toEqual(caption.bbox);
	});
	it("does not absorb aligned right-column prose without reading-order evidence", () => {
		const left = region("left", "image", 0, {
			x: 0.05,
			y: 0.1,
			w: 0.4,
			h: 0.4,
		});
		const right = region("right", "chart", 0, {
			x: 0.55,
			y: 0.1,
			w: 0.4,
			h: 0.4,
		});
		const caption = region(
			"caption",
			"text",
			0,
			{ x: 0.05, y: 0.54, w: 0.43, h: 0.2 },
			"Fig. 2 | Main caption. a, Experimental results and descriptions.",
		);
		const continuation = region(
			"continuation",
			"text",
			0,
			{ x: 0.52, y: 0.54, w: 0.43, h: 0.2 },
			"b, Additional experimental results in the right column. Error bars indicate standard deviation across independent experiments.",
		);
		const out = figures([left, right, caption, continuation]);
		expect(out).toHaveLength(2);
		expect(out.find((r) => r.title)?.bbox.x).toBeCloseTo(0.05);
		expect(out.find((r) => r.title)?.title).toBe(caption.text);
		expect(out.find((r) => r.id === "right")).toEqual(right);
	});
	it.each([
		-1, 1,
	])("associates an unambiguous adjacent-page caption (%s), never unions its geometry", (direction) => {
		const image = region("image", "image", 1);
		const caption = region(
			"caption",
			"text",
			1 + direction,
			{ x: 0.05, y: direction < 0 ? 0.72 : 0.08, w: 0.9, h: 0.2 },
			"Fig. 1 | Complete figure caption.",
		);
		const out = figures([image, caption]);
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
		const caption = region(
			"caption",
			"text",
			0,
			{ x: 0.05, y: 0.72, w: 0.9, h: 0.2 },
			"Fig. 1 | Ambiguous caption.",
		);
		const after = region(
			"after",
			"text",
			2,
			{ x: 0.05, y: 0.08, w: 0.9, h: 0.2 },
			"Fig. 2 | Another eligible caption.",
		);
		const image = region("image", "image", 1);
		expect(figures([image, caption, after])).toEqual([image]);
	});
	it("does not overwrite an explicit host figure number with a different adjacent caption", () => {
		const image = {
			...region("image", "image", 1),
			title: "Fig. 2 | Known image.",
		};
		const caption = region(
			"caption",
			"text",
			0,
			{ x: 0.05, y: 0.75, w: 0.9, h: 0.2 },
			"Fig. 1 | Different image.",
		);
		expect(figures([image, caption])).toEqual([image]);
	});
	it("respects the figure number in a next-page caption hint", () => {
		const image = region("image", "image", 1);
		const hint = region(
			"hint",
			"figure_title",
			1,
			{ x: 0.1, y: 0.75, w: 0.8, h: 0.03 },
			"Extended Data Fig. 4 | See next page for caption.",
		);
		const wrong = region(
			"wrong",
			"text",
			2,
			{ x: 0.1, y: 0.08, w: 0.8, h: 0.1 },
			"Extended Data Fig. 5 | Another figure.",
		);
		expect(figures([image, hint, wrong])).toEqual([image]);
		const right = {
			...wrong,
			text: "Extended Data Fig. 4 | Complete caption.",
		};
		expect(figures([image, hint, right])[0]).toMatchObject({
			title: right.text,
			captionPageIndex: 2,
			bbox: image.bbox,
		});
	});
	it("does not group distant uncaptioned images or reinterpret a prose reference", () => {
		const a = region("a", "image", 0, { x: 0.1, y: 0.1, w: 0.3, h: 0.2 });
		const b = region("b", "image", 0, { x: 0.6, y: 0.6, w: 0.3, h: 0.2 });
		const text = region(
			"prose",
			"text",
			0,
			{ x: 0.1, y: 0.33, w: 0.3, h: 0.1 },
			"Figure 5 contains the experimental results.",
		);
		const out = figures([a, b, text]);
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
		const out = figures(raw);
		expect(out).toHaveLength(1);
		expect(out[0].titleBbox).toBeUndefined();
	});
	it("deduplicates text-only titled hosts without deleting both of them", () => {
		const image = {
			...region("image", "image"),
			title: "Fig. 1 | Known caption.",
		};
		const duplicate = {
			...region("duplicate", "chart", 0, {
				x: 0.11,
				y: 0.11,
				w: 0.78,
				h: 0.58,
			}),
			title: image.title,
		};
		expect(figures([image, duplicate])).toEqual([image]);
	});
});
