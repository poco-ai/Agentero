import { describe, expect, it } from "vitest";

import {
	annotationTranslationForQuote,
	parseAnnotationTranslateSidecar,
} from "@/lib/pdf/layout/annotation-translate-display";

const sentences = {
	schemaVersion: 2,
	source: { targetLang: "zh-CN" },
	items: [
		{
			source: "Alpha runs. Beta follows. Gamma ends.",
			translated: "整段。",
			sentences: [
				{ quote: "Alpha runs.", translated: "甲。" },
				{ quote: "Beta follows.", translated: "乙。" },
				{ quote: "Gamma ends.", translated: "丙。" },
			],
		},
	],
};

describe("parseAnnotationTranslateSidecar", () => {
	it("reads schema 1 and schema 2, and drops a bad sentence", () => {
		expect(
			parseAnnotationTranslateSidecar({
				schemaVersion: 1,
				source: { targetLang: "zh-CN" },
				items: [{ source: "Alpha runs.", translated: "甲。" }],
			})?.items,
		).toEqual([{ source: "Alpha runs.", translated: "甲。" }]);
		const parsed = parseAnnotationTranslateSidecar({
			schemaVersion: 2,
			source: { targetLang: "en" },
			items: [
				{
					source: "Alpha runs.",
					translated: "甲。",
					sentences: [
						{ quote: "Alpha runs.", translated: "甲。" },
						{ quote: "", translated: "丢" },
					],
				},
				{ source: " ", translated: " " },
			],
		});
		expect(parsed?.items).toEqual([
			{
				source: "Alpha runs.",
				translated: "甲。",
				sentences: [{ quote: "Alpha runs.", translated: "甲。" }],
			},
		]);
		expect(
			parseAnnotationTranslateSidecar({ schemaVersion: 3, items: [] }),
		).toBe(null);
	});

	it("drops a block whose translation echoes the Index-Translate prompt", () => {
		const parsed = parseAnnotationTranslateSidecar({
			schemaVersion: 2,
			source: { targetLang: "zh-CN" },
			items: [
				{
					source: "We can estimate the noise power as",
					translated:
						"噪声功率可估计为\n\n【约束要求】\n只输出译文，不要有任何额外说明。",
				},
				{ source: "Beta follows.", translated: "乙。" },
			],
		});
		expect(parsed?.items).toEqual([
			{ source: "Beta follows.", translated: "乙。" },
		]);
		expect(
			annotationTranslationForQuote({
				sidecar: parsed,
				quote: "We can estimate the noise power as",
			}),
		).toBeNull();
		expect(
			annotationTranslationForQuote({
				sidecar: parsed,
				quote: "Beta follows.",
			}),
		).toBe("乙。");
	});
});

describe("annotationTranslationForQuote", () => {
	const sidecar = parseAnnotationTranslateSidecar(sentences);

	it("shows one sentence or a consecutive run, not the rest of the block", () => {
		expect(
			annotationTranslationForQuote({ sidecar, quote: "Beta follows." }),
		).toBe("乙。");
		expect(
			annotationTranslationForQuote({
				sidecar,
				quote: "Alpha runs. Beta follows.",
			}),
		).toBe("甲。乙。");
		expect(
			annotationTranslationForQuote({ sidecar, quote: "Alpha" }),
		).toBeNull();
	});

	it("joins a sentence split across blocks once", () => {
		const split = parseAnnotationTranslateSidecar({
			schemaVersion: 2,
			source: { targetLang: "zh-CN" },
			items: [
				{
					source: "Alpha runs.",
					translated: "甲。",
					sentences: [{ quote: "Alpha runs.", translated: "甲。" }],
				},
				{
					source: "Beta follows.",
					translated: "乙。",
					sentences: [{ quote: "Beta follows.", translated: "乙。" }],
				},
			],
		});
		expect(
			annotationTranslationForQuote({
				sidecar: split,
				quote: "Alpha runs. Beta follows.",
			}),
		).toBe("甲。乙。");
	});

	it("shows a schema 1 block only when the source is the whole quote", () => {
		const legacy = parseAnnotationTranslateSidecar({
			schemaVersion: 1,
			source: { targetLang: "zh-CN" },
			items: [
				{
					source: "Alpha runs. Beta follows.",
					translated: "整段。",
				},
			],
		});
		expect(
			annotationTranslationForQuote({
				sidecar: legacy,
				quote: "Alpha runs. Beta follows.",
			}),
		).toBe("整段。");
		expect(
			annotationTranslationForQuote({ sidecar: legacy, quote: "Alpha runs." }),
		).toBeNull();
	});

	it("prefers sentence pairs, then an exact block, then the newest mark", () => {
		expect(
			annotationTranslationForQuote({
				sidecar,
				quote: "Beta follows.",
				markResults: [
					{ quote: "Beta follows.", result: "划词", createdAt: "2024" },
				],
			}),
		).toBe("乙。");
		const bare = parseAnnotationTranslateSidecar({
			schemaVersion: 2,
			source: { targetLang: "en" },
			items: [{ source: "Alpha runs.", translated: "Alpha." }],
		});
		expect(
			annotationTranslationForQuote({
				sidecar: bare,
				quote: "Alpha runs.",
				markResults: [
					{ quote: "Alpha runs.", result: "mark", createdAt: "2024" },
				],
			}),
		).toBe("Alpha.");
		expect(
			annotationTranslationForQuote({
				sidecar: null,
				quote: "Alpha runs.",
				markResults: [
					{ quote: "Alpha runs.", result: "旧", createdAt: "2020" },
					{ quote: "Alpha runs.", result: "新", updatedAt: "2024" },
				],
			}),
		).toBe("新");
	});
});
