import { describe, expect, it } from "vitest";

import {
	layoutSidecarBlocksAnalysis,
	layoutSidecarNeedsTextLayer,
	layoutSidecarNeedsViewerReload,
	layoutSidecarPath,
	layoutSidecarWasReplaced,
	layoutTextBackfillSidecar,
	type PdfLayoutSidecar,
	parseLayoutSidecar,
	sameLayoutParse,
} from "@/lib/pdf/layout/io";

function region(): PdfLayoutSidecar["regions"][number] {
	return {
		id: "body",
		pageIndex: 0,
		kind: "text",
		label: "text",
		score: 0.9,
		readingOrder: 1,
		rect: { x: 10, y: 20, w: 30, h: 40 },
		bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
	};
}

describe("layout sidecar", () => {
	it("backfills old MinerU captions once without invalidating the model parse", () => {
		const old: PdfLayoutSidecar = {
			schemaVersion: 3,
			source: {
				mode: "mineru-layout",
				generatedAt: "now",
				textLayerExtracted: true,
			},
			regions: [region()],
		};
		expect(layoutSidecarNeedsTextLayer(old)).toBe(true);
		const updated = layoutTextBackfillSidecar(old, old.regions);
		expect(layoutSidecarNeedsTextLayer(updated)).toBe(false);
		expect(updated.source.generatedAt).toBe("now");
		const parsed = parseLayoutSidecar(updated);
		expect(parsed && layoutSidecarNeedsTextLayer(parsed)).toBe(false);
	});
	it("reloads an open viewer only when the sidecar parse is new", () => {
		expect(
			layoutSidecarNeedsViewerReload(null, {
				generatedAt: "t1",
				regionCount: 1,
			}),
		).toBe(true);
		expect(
			layoutSidecarNeedsViewerReload("t1", {
				generatedAt: "t1",
				regionCount: 4,
			}),
		).toBe(false);
		expect(
			layoutSidecarNeedsViewerReload("t1", {
				generatedAt: "t2",
				regionCount: 12,
			}),
		).toBe(true);
		expect(
			layoutSidecarNeedsViewerReload("t1", {
				generatedAt: "t2",
				regionCount: 0,
			}),
		).toBe(false);
		expect(layoutSidecarNeedsViewerReload("t1", null)).toBe(false);
		expect(layoutSidecarWasReplaced("t1", "t2")).toBe(true);
		expect(layoutSidecarWasReplaced("t1", "t1")).toBe(false);
		expect(layoutSidecarWasReplaced("t1", null)).toBe(false);
	});

	it("keeps a non-empty sidecar unless the caller forces a new parse", () => {
		expect(layoutSidecarBlocksAnalysis(false, 3)).toBe(true);
		expect(layoutSidecarBlocksAnalysis(undefined, 3)).toBe(true);
		expect(layoutSidecarBlocksAnalysis(true, 3)).toBe(false);
		expect(layoutSidecarBlocksAnalysis(true, 0)).toBe(false);
		expect(layoutSidecarBlocksAnalysis(false, 0)).toBe(false);
	});

	it("stores under the paper source folder", () => {
		expect(layoutSidecarPath("/vault/papers/demo")).toBe(
			"/vault/papers/demo/source/layout.json",
		);
		expect(layoutSidecarPath("C:\\vault\\papers\\demo")).toBe(
			"C:\\vault\\papers\\demo\\source\\layout.json",
		);
	});

	it("parses raw text-enriched layout regions", () => {
		const sidecar = parseLayoutSidecar({
			schemaVersion: 3,
			source: {
				mode: "embedpdf-layout",
				generatedAt: "2026-08-07T00:00:00Z",
			},
			regions: [
				{
					id: "cap",
					pageIndex: 0,
					kind: "figure_title",
					label: "figure_title",
					score: 0.9,
					readingOrder: 1,
					rect: { x: 10, y: 20, w: 30, h: 40 },
					bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
					title: "Figure 1: Demo",
					captionRole: "figure_main",
				},
			],
		});

		expect(sidecar?.regions).toHaveLength(1);
		expect(sidecar?.regions[0]?.title).toBe("Figure 1: Demo");
		expect(sidecar?.regions[0]?.captionRole).toBe("figure_main");
	});

	it("accepts the paddle-layout source mode", () => {
		const sidecar = parseLayoutSidecar({
			schemaVersion: 3,
			source: {
				mode: "paddle-layout",
				generatedAt: "2026-08-12T00:00:00Z",
			},
			regions: [
				{
					id: "paddle-0-0",
					pageIndex: 0,
					kind: "image",
					label: "image",
					score: 0.9,
					readingOrder: 0,
					rect: { x: 10, y: 20, w: 30, h: 40 },
					bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
				},
			],
		});
		expect(sidecar?.source.mode).toBe("paddle-layout");
		expect(sidecar?.regions).toHaveLength(1);
	});

	it("records a finished text-layer walk and keeps the parse timestamp", () => {
		const sidecar = parseLayoutSidecar({
			schemaVersion: 3,
			source: {
				mode: "embedpdf-layout",
				generatedAt: "2026-08-07T00:00:00Z",
				textLayerExtracted: true,
			},
			regions: [region()],
		});
		expect(sidecar?.source.textLayerExtracted).toBe(true);
		expect(sidecar && layoutSidecarNeedsTextLayer(sidecar)).toBe(false);

		const stale = parseLayoutSidecar({
			schemaVersion: 3,
			source: {
				mode: "embedpdf-layout",
				generatedAt: "2026-08-07T00:00:00Z",
			},
			regions: [
				{
					...region(),
					text: "Harbor-Index Our third contribution is",
				},
			],
		});
		expect(stale && layoutSidecarNeedsTextLayer(stale)).toBe(true);
		if (!stale) throw new Error("expected sidecar");
		const backfill = layoutTextBackfillSidecar(stale, [
			{ ...stale.regions[0], text: "Our third contribution is Harbor-Index" },
		]);
		expect(backfill.source.generatedAt).toBe("2026-08-07T00:00:00Z");
		expect(backfill.source.textLayerExtracted).toBe(true);
		expect(backfill.regions[0]?.text).toBe(
			"Our third contribution is Harbor-Index",
		);
		expect(sameLayoutParse(stale, stale)).toBe(true);
		expect(
			sameLayoutParse(stale, {
				...stale,
				source: { ...stale.source, generatedAt: "2026-08-08T00:00:00Z" },
			}),
		).toBe(false);
		expect(
			sameLayoutParse(stale, {
				...stale,
				regions: [{ ...stale.regions[0], bbox: { x: 0, y: 0, w: 1, h: 1 } }],
			}),
		).toBe(false);
	});

	it("rejects stale schema or malformed regions", () => {
		expect(
			parseLayoutSidecar({
				schemaVersion: 0,
				source: { mode: "embedpdf-layout", generatedAt: "now" },
				regions: [],
			}),
		).toBeNull();
		expect(
			parseLayoutSidecar({
				schemaVersion: 3,
				source: { mode: "embedpdf-layout", generatedAt: "now" },
				regions: [{ id: "x", kind: "unknown" }],
			}),
		).toBeNull();
		// v1 caches predate abstract + full label map — force re-analysis.
		expect(
			parseLayoutSidecar({
				schemaVersion: 1,
				source: { mode: "embedpdf-layout", generatedAt: "now" },
				regions: [],
			}),
		).toBeNull();
	});
});
