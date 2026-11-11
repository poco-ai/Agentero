import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	applyHeadingBodyFloor,
	bodyReferenceFontSize,
	expandLayoutTranslateBbox,
	fontSizeForLayoutTranslateBox,
	HEADING_TO_BODY_SIZE_RATIO,
} from "@/components/viewer/pdf/layers/layout-translate-overlay";
import {
	applyLayoutTranslateSidecar,
	countPendingLayoutTranslateItems,
	flushLayoutTranslateSidecar,
	groupLayoutTranslateItemsByPage,
	hasPendingLayoutTranslateItems,
	hydrateLayoutTranslateItems,
	LAYOUT_TRANSLATE_WRITE_DEBOUNCE_MS,
	type LayoutTranslateCacheKey,
	type LayoutTranslateItem,
	type LayoutTranslateItemStatus,
	layoutRegionSourceText,
	layoutTranslatePendingPageRange,
	listTranslatableLayoutRegions,
	parseLayoutTranslateSidecar,
	persistLayoutTranslateSidecarBestEffort,
	toLayoutTranslateItems,
	translateServiceKey,
	writeLayoutTranslateSidecar,
} from "@/lib/pdf/layout/layout-translate";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";
import { DEFAULT_TRANSLATE_SETTINGS } from "@/lib/translate/defaults";

vi.mock("@/lib/vault", () => ({
	joinVaultPath: (parent: string, name: string) => `${parent}/${name}`,
	readVaultFile: vi.fn(),
	writeVaultFile: vi.fn(),
}));

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
		expect(list[0]?.raw).toBe("This is the abstract.");
	});

	it("keeps the text-layer hyphen in raw and heals it in source", () => {
		const list = listTranslatableLayoutRegions([
			region({
				id: "hyphen",
				kind: "text",
				pageIndex: 0,
				text: "A repre- sentation helps.",
			}),
		]);
		expect(list[0]?.raw).toBe("A repre- sentation helps.");
		expect(list[0]?.source).toBe("A representation helps.");
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

	it("excludes reference entries and their heading from translation and missing counts", () => {
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
		const hydration = hydrateLayoutTranslateItems(
			toLayoutTranslateItems(list),
			{
				schemaVersion: 2,
				source: {
					mode: "pdf-layout-translate",
					generatedAt: "2026-11-11T00:00:00Z",
					providerId: "tencenttransmart",
					sourceLang: "auto",
					targetLang: "zh-CN",
					serviceKey: "tencenttransmart",
				},
				items: [...list, { ...list[0], id: "ref1" }].map((r) => ({
					...r,
					translated: "Cached translation",
				})),
			},
		);
		expect(hydration.items.map((item) => item.id)).toEqual(["body"]);
		expect(hydration.pendingRequired).toBe(0);
	});

	it.each([
		"Bibliography",
		"Works Cited",
		"参考文献",
		"參考文獻",
		"9. References",
	])("preserves the standalone %s heading while keeping inline citations and appendices translatable", (title) => {
		const list = listTranslatableLayoutRegions([
			region({ id: "heading", kind: "header", pageIndex: 0, text: title }),
			region({
				id: "body",
				kind: "text",
				pageIndex: 0,
				text: "References [1, 2] support our approach.",
			}),
			region({
				id: "appendix",
				kind: "header",
				pageIndex: 1,
				text: "A. Additional experiments",
			}),
		]);
		expect(list.map((r) => r.id)).toEqual(["body", "appendix"]);
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

	it("keeps a longer heading at the source size instead of shrinking to fit", () => {
		const bbox = { x: 0.1, y: 0.08, w: 0.7, h: 0.035 };
		const pageW = 800;
		const pageH = 1100;
		const en = "Introduction";
		const zh = "这是一个明显更长的章节标题用来验证字号不会被压扁";
		const english = fontSizeForLayoutTranslateBox(bbox, pageW, pageH, en, en, {
			heading: true,
		});
		const chinese = fontSizeForLayoutTranslateBox(bbox, pageW, pageH, en, zh, {
			heading: true,
		});
		const shrunk = fontSizeForLayoutTranslateBox(bbox, pageW, pageH, en, zh);
		expect(Math.abs(chinese - english) / english).toBeLessThanOrEqual(0.02);
		expect(chinese).toBeGreaterThan(shrunk);
	});

	it("sizes a one-line heading from the raw box when padding would hit the floor", () => {
		// A section-title strip is about one em tall. Subtracting paragraph
		// padding used to clamp "1. Introduction" to FS_MIN, below body text.
		const pageW = 600;
		const pageH = 400;
		const bbox = { x: 0.12, y: 0.2, w: 0.4, h: 12 / pageH };
		const fs = fontSizeForLayoutTranslateBox(
			bbox,
			pageW,
			pageH,
			"1. Introduction",
			"1. 介绍",
			{ heading: true },
		);
		expect(fs).toBeGreaterThan(7);
		expect(fs).toBeLessThanOrEqual(20);
	});
});

describe("heading body floor", () => {
	it("uses the median body size as the page reference", () => {
		expect(bodyReferenceFontSize([8, 9, 10, 12])).toBe(10);
		expect(bodyReferenceFontSize([8, 10, 12])).toBe(12);
		expect(bodyReferenceFontSize([])).toBeUndefined();
	});

	it("raises a short section title to body × 1.35", () => {
		const body = 10;
		const raised = applyHeadingBodyFloor(7.6, body);
		expect(raised).toBeCloseTo(body * HEADING_TO_BODY_SIZE_RATIO, 5);
		expect(applyHeadingBodyFloor(14, body)).toBe(14);
		expect(applyHeadingBodyFloor(8, undefined)).toBe(8);
	});
});

describe("expandLayoutTranslateBbox", () => {
	function item(kind: LayoutTranslateItem["kind"]): LayoutTranslateItem {
		return {
			id: "title",
			pageIndex: 0,
			bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.03 },
			kind,
			readingOrder: 0,
			source: "A long section title",
			translated: "这是一个用于验证安全扩框行为的更长章节标题",
			status: "done",
		};
	}

	it("borrows right-side whitespace for a heading but stops before a blocker", () => {
		const expanded = expandLayoutTranslateBbox(item("header"), [
			region({
				id: "next-column",
				kind: "text",
				pageIndex: 0,
				bbox: { x: 0.42, y: 0.1, w: 0.3, h: 0.1 },
			}),
		]);
		expect(expanded.w).toBeGreaterThan(0.2);
		expect(expanded.x + expanded.w).toBeLessThan(0.42);
	});

	it("does not expand a long body paragraph into adjacent content", () => {
		const body = { ...item("text"), source: "word ".repeat(100) };
		expect(expandLayoutTranslateBbox(body)).toEqual(body.bbox);
	});

	it("grows a heading down to the source font size and stops at a blocker", () => {
		const heading = item("header");
		const fontSize = fontSizeForLayoutTranslateBox(
			heading.bbox,
			800,
			1100,
			heading.source,
			heading.translated,
			{ heading: true },
		);
		const expanded = expandLayoutTranslateBbox(
			heading,
			[
				region({
					id: "body",
					kind: "text",
					pageIndex: 0,
					bbox: { x: 0.1, y: 0.2, w: 0.7, h: 0.2 },
				}),
			],
			{ pageWidthPx: 800, pageHeightPx: 1100, fontSize },
		);
		expect(expanded.h).toBeGreaterThan(heading.bbox.h);
		expect(expanded.y + expanded.h).toBeLessThanOrEqual(0.2 - 0.006 + 1e-9);
		expect(expanded.h).toBeLessThanOrEqual(heading.bbox.h * 2.75 + 1e-9);
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

	it("re-buckets a page when only sentence pairs change", () => {
		const done = { ...translateItem("a", 0, "done"), translated: "甲" };
		const before = groupLayoutTranslateItemsByPage([done]);
		const after = groupLayoutTranslateItemsByPage(
			[
				{
					...done,
					sentences: [{ quote: "A.", source: "A.", translated: "甲" }],
				},
			],
			before,
		);
		expect(after.get(0)).not.toBe(before.get(0));
	});
});

describe("layout translate sidecar cache", () => {
	const key: LayoutTranslateCacheKey = {
		providerId: "googleapi",
		sourceLang: "auto",
		targetLang: "zh-CN",
		serviceKey: "googleapi",
	};

	function item(id: string, source = `source ${id}`): LayoutTranslateItem {
		return {
			id,
			pageIndex: 0,
			bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 },
			kind: "text",
			readingOrder: 0,
			source,
			status: "pending",
		};
	}

	it("applies cached translations only when key and source text match", () => {
		const sidecar = parseLayoutTranslateSidecar(
			{
				schemaVersion: 2,
				source: {
					mode: "pdf-layout-translate",
					generatedAt: "2026-08-10T00:00:00.000Z",
					providerId: "googleapi",
					sourceLang: "auto",
					targetLang: "zh-CN",
					serviceKey: "googleapi",
				},
				items: [
					{
						id: "a",
						pageIndex: 0,
						bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 },
						kind: "text",
						readingOrder: 0,
						source: "source a",
						translated: "甲",
					},
					{
						id: "b",
						pageIndex: 0,
						bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.05 },
						kind: "text",
						readingOrder: 1,
						source: "old source",
						translated: "乙",
					},
				],
			},
			key,
		);
		const applied = applyLayoutTranslateSidecar(
			[item("a"), item("b")],
			sidecar,
		);

		expect(applied[0]).toMatchObject({
			status: "done",
			translated: "甲",
		});
		expect(applied[1]?.status).toBe("pending");
		expect(applied[1]?.translated).toBeUndefined();
		expect(hasPendingLayoutTranslateItems(applied)).toBe(true);
	});

	it("rejects caches for a different target language", () => {
		const sidecar = parseLayoutTranslateSidecar(
			{
				schemaVersion: 2,
				source: {
					mode: "pdf-layout-translate",
					generatedAt: "2026-08-10T00:00:00.000Z",
					providerId: "googleapi",
					sourceLang: "auto",
					targetLang: "en",
					serviceKey: "googleapi",
				},
				items: [
					{
						id: "a",
						pageIndex: 0,
						bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 },
						kind: "text",
						readingOrder: 0,
						source: "source a",
						translated: "A",
					},
				],
			},
			key,
		);

		expect(sidecar).toBeNull();
		expect(
			hasPendingLayoutTranslateItems([
				{ ...item("a"), translated: "甲", status: "done" },
			]),
		).toBe(false);
	});

	it("rejects a schema 1 file", () => {
		expect(
			parseLayoutTranslateSidecar(
				{
					schemaVersion: 1,
					source: {
						mode: "pdf-layout-translate",
						generatedAt: "2026-08-10T00:00:00.000Z",
						providerId: "googleapi",
						sourceLang: "auto",
						targetLang: "zh-CN",
						serviceKey: "googleapi",
					},
					items: [
						{
							id: "a",
							pageIndex: 0,
							bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 },
							kind: "text",
							readingOrder: 0,
							source: "source a",
							translated: "甲",
						},
					],
				},
				key,
			),
		).toBeNull();
	});

	it("keeps valid sentence pairs and drops a malformed entry", () => {
		const sidecar = parseLayoutTranslateSidecar(
			{
				schemaVersion: 2,
				source: {
					mode: "pdf-layout-translate",
					generatedAt: "2026-08-10T00:00:00.000Z",
					providerId: "googleapi",
					sourceLang: "auto",
					targetLang: "zh-CN",
					serviceKey: "googleapi",
				},
				items: [
					{
						id: "a",
						pageIndex: 0,
						bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 },
						kind: "text",
						readingOrder: 0,
						source: "source a",
						translated: "甲",
						sentences: [
							{
								quote: "Hello.",
								source: "Hello.",
								translated: "你好。",
								display: "你好。",
							},
							{ quote: "", source: "x", translated: "y" },
							{
								quote: "Go.",
								source: "Go.",
								translated: "走。",
								display: "走吧。",
							},
						],
					},
				],
			},
			key,
		);
		expect(sidecar?.items[0]?.sentences).toEqual([
			{ quote: "Hello.", source: "Hello.", translated: "你好。" },
			{
				quote: "Go.",
				source: "Go.",
				translated: "走。",
				display: "走吧。",
			},
		]);
		const applied = applyLayoutTranslateSidecar([item("a")], sidecar);
		expect(applied[0]?.sentences).toEqual(sidecar?.items[0]?.sentences);
	});

	it("writes schema 2 and omits display when it equals the sentence", async () => {
		const vault = await import("@/lib/vault");
		vi.mocked(vault.writeVaultFile).mockReset();
		await writeLayoutTranslateSidecar("/paper", key, [
			{
				...item("a", "Hello. Go."),
				status: "done",
				translated: "你好。走吧。",
				sentences: [
					{ quote: "Hello.", source: "Hello.", translated: "你好。" },
					{
						quote: "Go.",
						source: "Go.",
						translated: "走。",
						display: "走吧。",
					},
				],
			},
		]);
		const body = vi.mocked(vault.writeVaultFile).mock.calls[0]?.[1] as string;
		const parsed = JSON.parse(body) as {
			schemaVersion: number;
			items: { sentences: { display?: string; quote: string }[] }[];
		};
		expect(parsed.schemaVersion).toBe(2);
		expect(parsed.items[0]?.sentences[0]?.display).toBeUndefined();
		expect(parsed.items[0]?.sentences[1]?.display).toBe("走吧。");
	});
});

describe("hydrateLayoutTranslateItems", () => {
	const key: LayoutTranslateCacheKey = {
		providerId: "googleapi",
		sourceLang: "auto",
		targetLang: "zh-CN",
		serviceKey: "googleapi",
	};

	function item(
		id: string,
		pageIndex = 0,
		status: LayoutTranslateItem["status"] = "pending",
	): LayoutTranslateItem {
		return {
			id,
			pageIndex,
			bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 },
			kind: "text",
			readingOrder: pageIndex,
			source: `source ${id}`,
			status,
		};
	}

	function sidecar(
		entries: { id: string; pageIndex?: number; source: string }[],
	) {
		return parseLayoutTranslateSidecar(
			{
				schemaVersion: 2,
				source: {
					mode: "pdf-layout-translate",
					generatedAt: "2026-08-10T00:00:00.000Z",
					providerId: "googleapi",
					sourceLang: "auto",
					targetLang: "zh-CN",
					serviceKey: "googleapi",
				},
				items: entries.map((entry) => ({
					id: entry.id,
					pageIndex: entry.pageIndex ?? 0,
					bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 },
					kind: "text",
					readingOrder: 0,
					source: entry.source,
					translated: `译 ${entry.id}`,
				})),
			},
			key,
		);
	}

	it("renders every matching cached block and leaves the rest pending", () => {
		const items = [item("a"), item("b"), item("c", 2)];
		const hydration = hydrateLayoutTranslateItems(
			items,
			sidecar([
				{ id: "a", source: "source a" },
				{ id: "b", source: "stale source" },
				{ id: "c", pageIndex: 2, source: "source c" },
			]),
		);
		expect(hydration.fromCache).toBe(true);
		expect(hydration.cachedCount).toBe(2);
		expect(hydration.pendingRequired).toBe(1);
		expect(hydration.items.map((it) => it.status)).toEqual([
			"done",
			"pending",
			"done",
		]);
		expect(hydration.items[1]?.translated).toBeUndefined();
		expect(countPendingLayoutTranslateItems(hydration.items)).toBe(1);
		expect(layoutTranslatePendingPageRange(hydration.items)).toEqual({
			start: 1,
			end: 1,
		});
	});

	it("reports no usable cache when the sidecar is missing", () => {
		const hydration = hydrateLayoutTranslateItems(
			[item("a"), item("b", 4)],
			null,
		);
		expect(hydration).toMatchObject({
			fromCache: false,
			cachedCount: 0,
			pendingRequired: 2,
		});
		expect(layoutTranslatePendingPageRange(hydration.items)).toEqual({
			start: 1,
			end: 5,
		});
	});

	it("needs no pending completion when every block is cached", () => {
		const hydration = hydrateLayoutTranslateItems(
			[item("a"), item("b")],
			sidecar([
				{ id: "a", source: "source a" },
				{ id: "b", source: "source b" },
			]),
		);
		expect(hydration.fromCache).toBe(true);
		expect(hydration.cachedCount).toBe(2);
		expect(hydration.pendingRequired).toBe(0);
		expect(hasPendingLayoutTranslateItems(hydration.items)).toBe(false);
	});
});

describe("persistLayoutTranslateSidecarBestEffort debounce", () => {
	const key: LayoutTranslateCacheKey = {
		providerId: "googleapi",
		sourceLang: "auto",
		targetLang: "zh-CN",
		serviceKey: "googleapi",
	};
	const doneItem: LayoutTranslateItem = {
		id: "a",
		pageIndex: 0,
		bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 },
		kind: "text",
		readingOrder: 0,
		source: "source a",
		status: "done",
		translated: "甲",
	};

	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("coalesces rapid per-block writes into a single write", async () => {
		const vault = await import("@/lib/vault");
		vi.mocked(vault.writeVaultFile).mockReset();

		persistLayoutTranslateSidecarBestEffort("/vault/paper", key, [doneItem]);
		persistLayoutTranslateSidecarBestEffort("/vault/paper", key, [doneItem]);
		persistLayoutTranslateSidecarBestEffort("/vault/paper", key, [doneItem]);
		expect(vault.writeVaultFile).not.toHaveBeenCalled();

		vi.advanceTimersByTime(LAYOUT_TRANSLATE_WRITE_DEBOUNCE_MS + 1);
		expect(vault.writeVaultFile).toHaveBeenCalledTimes(1);
	});

	it("merges pending page and document progress when a finished run flushes", async () => {
		const vault = await import("@/lib/vault");
		vi.mocked(vault.writeVaultFile).mockReset();
		vi.mocked(vault.readVaultFile).mockRejectedValue(new Error("missing"));
		persistLayoutTranslateSidecarBestEffort(
			"/vault/concurrent",
			key,
			[doneItem],
			{ preserveExisting: true },
		);
		await flushLayoutTranslateSidecar(
			"/vault/concurrent",
			key,
			[{ ...doneItem, id: "b", pageIndex: 1 }],
			{ preserveExisting: true },
		);
		expect(vault.writeVaultFile).toHaveBeenCalledTimes(1);
		const written = JSON.parse(
			vi.mocked(vault.writeVaultFile).mock.calls[0][1],
		);
		expect(written.items.map((item: { id: string }) => item.id)).toEqual([
			"a",
			"b",
		]);
		await vi.runAllTimersAsync();
		expect(vault.writeVaultFile).toHaveBeenCalledTimes(1);
	});

	it("keeps a separate debounce timer per paper", async () => {
		const vault = await import("@/lib/vault");
		vi.mocked(vault.writeVaultFile).mockReset();

		persistLayoutTranslateSidecarBestEffort("/vault/paper-a", key, [doneItem]);
		persistLayoutTranslateSidecarBestEffort("/vault/paper-b", key, [doneItem]);
		vi.advanceTimersByTime(LAYOUT_TRANSLATE_WRITE_DEBOUNCE_MS + 1);
		expect(vault.writeVaultFile).toHaveBeenCalledTimes(2);
	});
});

describe("translateServiceKey custom prompt fingerprint", () => {
	it("invalidates OpenAI translation caches when request options change", () => {
		const cfg = {
			apiKey: "",
			baseUrl: "https://example.test/v1",
			region: "",
			model: "qwen3",
		};
		const key = (options: { extraRequestBody?: string }) =>
			translateServiceKey({
				...DEFAULT_TRANSLATE_SETTINGS,
				provider: "openaiCompatible",
				providerConfigs: { openaiCompatible: { ...cfg, ...options } },
			});
		expect(key({})).toBe("openaiCompatible:https://example.test/v1::qwen3");
		expect(key({ extraRequestBody: "" })).toBe(key({}));
		expect(key({ extraRequestBody: "{}" })).not.toBe(key({}));
		expect(key({ extraRequestBody: '{"temperature":0.7}' })).not.toBe(
			key({ extraRequestBody: '{"temperature":0.2}' }),
		);
	});
	const base = {
		...DEFAULT_TRANSLATE_SETTINGS,
		provider: "googleapi" as const,
	};

	it("empty prompt keeps the prompt-less key byte-identical", () => {
		expect(translateServiceKey({ ...base, customPrompt: "" })).toBe(
			"googleapi",
		);
		expect(translateServiceKey({ ...base, customPrompt: "   " })).toBe(
			"googleapi",
		);
	});

	it("non-empty prompt appends a stable fingerprint", () => {
		const a = translateServiceKey({ ...base, customPrompt: "Be terse." });
		const b = translateServiceKey({ ...base, customPrompt: "Be terse." });
		const c = translateServiceKey({ ...base, customPrompt: "Be verbose." });
		expect(a).not.toBe("googleapi");
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	it("works for the agent provider too", () => {
		const agentBase = {
			...DEFAULT_TRANSLATE_SETTINGS,
			provider: "agent" as const,
			agentId: "claude-1",
			modelId: "",
		};
		expect(translateServiceKey({ ...agentBase, customPrompt: "" })).toBe(
			"agent:claude-1:default",
		);
		expect(
			translateServiceKey({ ...agentBase, customPrompt: "Be terse." }),
		).not.toBe("agent:claude-1:default");
	});

	it("folds system and user templates into the same fingerprint", () => {
		const legacy = translateServiceKey({
			...base,
			customPrompt: "Be terse.",
			customSystem: "",
			customUser: "",
		});
		expect(translateServiceKey({ ...base, customPrompt: "Be terse." })).toBe(
			legacy,
		);
		expect(
			translateServiceKey({
				...base,
				customPrompt: "",
				customSystem: "Keep formulas.\nStay terse.",
			}),
		).not.toBe(legacy);
		expect(
			translateServiceKey({
				...base,
				customUser: "\n  \n",
			}),
		).toBe("googleapi");
	});
});
