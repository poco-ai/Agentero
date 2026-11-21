import { describe, expect, it } from "vitest";

import { companionReflowSentenceBands } from "@/lib/pdf/layout/element-sentence";
import {
	groupReflowUnitsBySentence,
	withHoverSentences,
} from "@/lib/pdf/layout/layout-sentences";

describe("companionReflowSentenceBands", () => {
	const item = {
		id: "body",
		bbox: { w: 0.5, h: 0.2 },
		reflow: { box: { w: 300, h: 120 } },
		translated: "第一句。第二句。",
		sentences: [
			{ translated: "第一句。", display: "第一句。" },
			{ translated: "第二句。", display: "第二句。" },
		],
		reflowLayout: {
			units: [
				{
					translatedOffset: 0,
					x: 60,
					y: 80,
					width: 40,
					height: 12,
					fontSize: 10,
					text: "第一句。",
				},
				{
					translatedOffset: 4,
					x: 60,
					y: 100,
					width: 40,
					height: 12,
					fontSize: 10,
					text: "第二句。",
				},
			],
		},
	};

	it("returns null while the block has no placed translation", () => {
		expect(
			companionReflowSentenceBands(
				[{ ...item, reflowLayout: undefined }],
				[{ itemId: "body", pageIndex: 0, sentenceIndex: 0 }],
				0,
			),
		).toBeNull();
	});

	it("uses the placed units of the hovered sentence after reflow", () => {
		const bands = companionReflowSentenceBands(
			[item],
			[{ itemId: "body", pageIndex: 0, sentenceIndex: 1 }],
			0,
		);
		expect(bands).toEqual([
			{
				x: 60 / 600,
				y: (100 - 8) / 600,
				w: 40 / 600,
				h: 12 / 600,
			},
		]);
	});

	it("lights the whole placed paragraph when the block has no sentence pairs", () => {
		const bands = companionReflowSentenceBands(
			[
				{
					...item,
					translated: "整段译文。",
					sentences: undefined,
				},
			],
			[{ itemId: "body", pageIndex: 0, sentenceIndex: 0 }],
			0,
		);
		expect(bands).toHaveLength(2);
	});
});

describe("groupReflowUnitsBySentence", () => {
	it("keeps every unit together when the pairs do not rebuild the block", () => {
		const groups = groupReflowUnitsBySentence(
			"整段。",
			[{ translated: "不是整段。" }],
			[{ translatedOffset: 0, text: "整" }],
		);
		expect(groups).toEqual([{ units: [{ translatedOffset: 0, text: "整" }] }]);
	});
});

describe("withHoverSentences", () => {
	it("keeps existing pairs and fills quotes for a whole-block translation", () => {
		expect(
			withHoverSentences({
				source: "Hello.",
				sentences: [{ quote: "Hello.", translated: "你好。" }],
			}).sentences,
		).toEqual([{ quote: "Hello.", translated: "你好。" }]);
		expect(
			withHoverSentences({
				source: "See Sec. 5.1. Next.",
				raw: "See Sec. 5.1. Next.",
			}).sentences,
		).toEqual([
			{ quote: "See Sec. 5.1.", translated: "" },
			{ quote: "Next.", translated: "" },
		]);
	});
});
