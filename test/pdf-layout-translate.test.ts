import { describe, expect, it } from "vitest";

import { fontSizeForLayoutTranslateBox } from "@/components/viewer/pdf/layers/layout-translate-overlay";
import {
	groupLayoutTranslateItemsByPage,
	type LayoutTranslateItem,
	type LayoutTranslateItemStatus,
	layoutRegionSourceText,
	listTranslatableLayoutRegions,
	toLayoutTranslateItems,
} from "@/lib/pdf/layout/layout-translate";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

function region(
	partial: Partial<PdfLayoutRegion> &
		Pick<PdfLayoutRegion, "id" | "kind" | "pageIndex">,
): PdfLayoutRegion {
	return {
		label: partial.kind,
		score: 0.9,
		readingOrder: 0,
		rect: { x: 0, y: 0, w: 100, h: 20 },
		bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 },
		...partial,
	};
}

describe("listTranslatableLayoutRegions", () => {
	it("keeps body text / abstract / header with extractable text in reading order", () => {
		const list = listTranslatableLayoutRegions([
			region({
				id: "img",
				kind: "image",
				pageIndex: 0,
				text: "should skip",
			}),
			region({
				id: "t2",
				kind: "text",
				pageIndex: 0,
				readingOrder: 2,
				bbox: { x: 0.1, y: 0.4, w: 0.5, h: 0.1 },
				text: "second paragraph",
			}),
			region({
				id: "abs",
				kind: "abstract",
				pageIndex: 0,
				readingOrder: 0,
				bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.15 },
				text: "This is the abstract.",
			}),
			region({
				id: "low",
				kind: "text",
				pageIndex: 0,
				score: 0.1,
				text: "below threshold",
			}),
			region({
				id: "empty",
				kind: "text",
				pageIndex: 0,
				readingOrder: 1,
			}),
		]);
		expect(list.map((r) => r.id)).toEqual(["abs", "t2"]);
		expect(list[0]?.source).toBe("This is the abstract.");
	});

	it("prefers text over title for source", () => {
		expect(
			layoutRegionSourceText(
				region({
					id: "h",
					kind: "header",
					pageIndex: 0,
					title: "from title",
					text: "from text",
				}),
			),
		).toBe("from text");
	});

	it("marks items pending for a new job", () => {
		const items = toLayoutTranslateItems(
			listTranslatableLayoutRegions([
				region({
					id: "a",
					kind: "text",
					pageIndex: 0,
					text: "hello",
				}),
			]),
		);
		expect(items).toHaveLength(1);
		expect(items[0]?.status).toBe("pending");
	});

	it("skips algorithm boxes and text inside them", () => {
		const list = listTranslatableLayoutRegions([
			region({
				id: "alg",
				kind: "algorithm",
				pageIndex: 0,
				bbox: { x: 0.1, y: 0.2, w: 0.8, h: 0.3 },
				text: "1: procedure FOO",
			}),
			region({
				id: "inside",
				kind: "text",
				pageIndex: 0,
				bbox: { x: 0.15, y: 0.25, w: 0.6, h: 0.1 },
				text: "line inside algorithm",
			}),
			region({
				id: "title",
				kind: "header",
				pageIndex: 0,
				bbox: { x: 0.1, y: 0.15, w: 0.4, h: 0.03 },
				text: "Algorithm 1 Main loop",
			}),
			region({
				id: "body",
				kind: "text",
				pageIndex: 0,
				bbox: { x: 0.1, y: 0.6, w: 0.8, h: 0.1 },
				text: "normal paragraph",
			}),
		]);
		expect(list.map((r) => r.id)).toEqual(["body"]);
	});

	it("includes figure and table captions (figure_title)", () => {
		const list = listTranslatableLayoutRegions([
			region({
				id: "fig",
				kind: "figure_title",
				pageIndex: 0,
				readingOrder: 1,
				bbox: { x: 0.1, y: 0.5, w: 0.8, h: 0.04 },
				title: "Figure 1: Overview of the system.",
			}),
			region({
				id: "tab",
				kind: "figure_title",
				pageIndex: 0,
				readingOrder: 2,
				bbox: { x: 0.1, y: 0.7, w: 0.8, h: 0.04 },
				text: "Table 2: Ablation study results.",
				captionRole: "table_main",
			}),
		]);
		expect(list.map((r) => r.id)).toEqual(["fig", "tab"]);
		expect(list[0]?.source).toContain("Figure 1");
		expect(list[1]?.source).toContain("Table 2");
	});

	it("skips reference entries and the References heading", () => {
		const list = listTranslatableLayoutRegions([
			region({
				id: "ref1",
				kind: "text",
				label: "reference",
				pageIndex: 0,
				bbox: { x: 0.1, y: 0.3, w: 0.8, h: 0.05 },
				text: "[1] Smith et al. A paper. 2024.",
			}),
			region({
				id: "refc",
				kind: "text",
				label: "reference_content",
				pageIndex: 0,
				bbox: { x: 0.1, y: 0.36, w: 0.8, h: 0.08 },
				text: "Long bibliography line with doi.",
			}),
			region({
				id: "reftitle",
				kind: "header",
				pageIndex: 0,
				bbox: { x: 0.1, y: 0.25, w: 0.3, h: 0.03 },
				text: "References",
			}),
			region({
				id: "body",
				kind: "text",
				label: "text",
				pageIndex: 0,
				bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 },
				text: "Introduction body.",
			}),
		]);
		expect(list.map((r) => r.id)).toEqual(["body"]);
	});

	it("skips aside_text side-margin regions", () => {
		const list = listTranslatableLayoutRegions([
			region({
				id: "aside",
				kind: "text",
				label: "aside_text",
				pageIndex: 0,
				bbox: { x: 0.01, y: 0.05, w: 0.04, h: 0.9 },
				text: "arXiv:2608.00881v1 [cs.LG] 1 Aug 2026",
			}),
			region({
				id: "body",
				kind: "text",
				label: "text",
				pageIndex: 0,
				bbox: { x: 0.12, y: 0.2, w: 0.7, h: 0.15 },
				text: "Normal paragraph on the page.",
			}),
		]);
		expect(list.map((r) => r.id)).toEqual(["body"]);
	});
});

describe("fontSizeForLayoutTranslateBox", () => {
	it("scales roughly with box height for body paragraphs", () => {
		const pageW = 800;
		const pageH = 1100;
		const body = fontSizeForLayoutTranslateBox(
			{ x: 0.1, y: 0.2, w: 0.8, h: 0.2 },
			pageW,
			pageH,
			"A".repeat(600),
		);
		const header = fontSizeForLayoutTranslateBox(
			{ x: 0.1, y: 0.1, w: 0.5, h: 0.03 },
			pageW,
			pageH,
			"Introduction",
		);
		expect(body).toBeGreaterThanOrEqual(7);
		expect(body).toBeLessThanOrEqual(20);
		expect(header).toBeGreaterThanOrEqual(7);
		expect(header).toBeGreaterThan(body * 0.4);
	});

	it("grows modestly when Chinese translation is denser than English source", () => {
		const bbox = { x: 0.1, y: 0.2, w: 0.8, h: 0.25 };
		const pageW = 800;
		const pageH = 1100;
		const en = "The quick brown fox jumps over the lazy dog. ".repeat(12);
		const zh = "大型语言模型代理越来越多地通过状态工具进行操作。".repeat(4);
		const paperLike = fontSizeForLayoutTranslateBox(bbox, pageW, pageH, en, en);
		const withZh = fontSizeForLayoutTranslateBox(bbox, pageW, pageH, en, zh);
		// Denser CN may use a larger size to fill the same box, but not unbounded.
		expect(withZh).toBeGreaterThanOrEqual(paperLike * 0.95);
		expect(withZh).toBeLessThanOrEqual(paperLike * 1.25 + 0.5);
	});
});

describe("groupLayoutTranslateItemsByPage", () => {
	function translateItem(
		id: string,
		pageIndex: number,
		status: LayoutTranslateItemStatus = "pending",
	): LayoutTranslateItem {
		return {
			id,
			pageIndex,
			bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 },
			kind: "text",
			readingOrder: 0,
			source: `source ${id}`,
			status,
		};
	}

	it("buckets items by page, keeping job order within a page", () => {
		const grouped = groupLayoutTranslateItemsByPage([
			translateItem("b", 1),
			translateItem("a", 0),
			translateItem("c", 1),
		]);
		expect([...grouped.keys()]).toEqual([1, 0]);
		expect(grouped.get(0)?.map((it) => it.id)).toEqual(["a"]);
		expect(grouped.get(1)?.map((it) => it.id)).toEqual(["b", "c"]);
	});

	it("reuses previous bucket identity for unchanged pages", () => {
		const before = groupLayoutTranslateItemsByPage([
			{ ...translateItem("a", 0, "done"), translated: "甲" },
			translateItem("b", 1, "running"),
		]);
		// Fresh item objects (streaming publish copies everything); only page 1 advanced.
		const after = groupLayoutTranslateItemsByPage(
			[
				{ ...translateItem("a", 0, "done"), translated: "甲" },
				{ ...translateItem("b", 1, "done"), translated: "乙" },
			],
			before,
		);
		expect(after.get(0)).toBe(before.get(0));
		expect(after.get(1)).not.toBe(before.get(1));
		expect(after.get(1)?.map((it) => it.status)).toEqual(["done"]);
	});
});
