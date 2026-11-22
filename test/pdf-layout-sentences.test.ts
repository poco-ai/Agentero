import { describe, expect, it } from "vitest";

import {
	draftChainSentences,
	joinMemberQuotes,
	joinTranslatedDisplays,
	layoutTranslateSentenceNodes,
	matchingSentenceIndexes,
	paintSentenceTranslations,
	sentenceIndexesCoveredByQuote,
	splitLayoutSentences,
	tintedSentenceIndexes,
} from "@/lib/pdf/layout/layout-sentences";

describe("splitLayoutSentences", () => {
	it("returns one quote when the text has no sentence end", () => {
		expect(splitLayoutSentences("the agent queries the environment")).toEqual([
			"the agent queries the environment",
		]);
	});

	it("splits on . ! ? and CJK stops followed by space or the end", () => {
		expect(splitLayoutSentences("Hello world. Next one!")).toEqual([
			"Hello world.",
			"Next one!",
		]);
		expect(splitLayoutSentences("第一句。第二句？第三句！")).toEqual([
			"第一句。",
			"第二句？",
			"第三句！",
		]);
	});

	it("keeps et al., Fig., e.g., i.e., and decimals intact", () => {
		expect(
			splitLayoutSentences("Smith et al. showed this. Next sentence."),
		).toEqual(["Smith et al. showed this.", "Next sentence."]);
		expect(
			splitLayoutSentences("See Fig. 1 for the setup. Then stop."),
		).toEqual(["See Fig. 1 for the setup.", "Then stop."]);
		expect(splitLayoutSentences("Use it, e.g. the bound. Next.")).toEqual([
			"Use it, e.g. the bound.",
			"Next.",
		]);
		expect(splitLayoutSentences("That is, i.e. the limit. Next.")).toEqual([
			"That is, i.e. the limit.",
			"Next.",
		]);
		expect(splitLayoutSentences("The ratio is 0.5 today. Next.")).toEqual([
			"The ratio is 0.5 today.",
			"Next.",
		]);
		expect(splitLayoutSentences("It is 0.5. Next.")).toEqual([
			"It is 0.5.",
			"Next.",
		]);
	});

	it("does not merge a line-break hyphen", () => {
		expect(splitLayoutSentences("a repre- sentation. Next.")).toEqual([
			"a repre- sentation.",
			"Next.",
		]);
	});

	it("keeps a closing quote on the sentence it closes", () => {
		expect(splitLayoutSentences('He said "stop." Then left.')).toEqual([
			'He said "stop."',
			"Then left.",
		]);
	});

	it("keeps academic abbreviations and block-start enumerators intact", () => {
		expect(
			splitLayoutSentences(
				"The bound is discussed in Sec. 5.1 and Appendix A. Next.",
			),
		).toEqual(["The bound is discussed in Sec. 5.1 and Appendix A.", "Next."]);
		expect(
			splitLayoutSentences(
				"Fetching Unit (Sec. 3.2) that dispatches the function calls in parallel; (iii) an Executor (Sec. 3.3) that executes the dispatched tasks using the associated functions.",
			),
		).toEqual([
			"Fetching Unit (Sec. 3.2) that dispatches the function calls in parallel; (iii) an Executor (Sec. 3.3) that executes the dispatched tasks using the associated functions.",
		]);
		expect(
			splitLayoutSentences("Eq. (1) holds vs. the baseline. Next."),
		).toEqual(["Eq. (1) holds vs. the baseline.", "Next."]);
		expect(splitLayoutSentences("See Tab. 2 and Figs. 3-4. Next.")).toEqual([
			"See Tab. 2 and Figs. 3-4.",
			"Next.",
		]);
		expect(splitLayoutSentences("Cf. Lem. 1 and Thm. 2. Next.")).toEqual([
			"Cf. Lem. 1 and Thm. 2.",
			"Next.",
		]);
		expect(
			splitLayoutSentences("Dr. Ada and Prof. Lin, approx. No. 4. Next."),
		).toEqual(["Dr. Ada and Prof. Lin, approx. No. 4.", "Next."]);
		expect(splitLayoutSentences("1. The method starts here. Next.")).toEqual([
			"1. The method starts here.",
			"Next.",
		]);
		expect(splitLayoutSentences("2.1. Methods are described. Done.")).toEqual([
			"2.1. Methods are described.",
			"Done.",
		]);
		expect(
			splitLayoutSentences("A. The appendix holds the proof. Next."),
		).toEqual(["A. The appendix holds the proof.", "Next."]);
	});
});

describe("joinMemberQuotes", () => {
	it("keeps a hyphen that sits on the column break", () => {
		const joined = joinMemberQuotes(["the repre-", "sentation works. Next."]);
		expect(joined.text).toBe("the repre- sentation works. Next.");
		expect(joined.ranges).toEqual([
			{ memberIndex: 0, start: 0, end: "the repre-".length },
			{
				memberIndex: 1,
				start: "the repre- ".length,
				end: joined.text.length,
			},
		]);
	});
});

describe("joinTranslatedDisplays", () => {
	it("inserts a space for English and none for Chinese", () => {
		expect(joinTranslatedDisplays(["First.", "Second."], "en")).toBe(
			"First. Second.",
		);
		expect(joinTranslatedDisplays(["第一句。", "第二句。"], "zh-CN")).toBe(
			"第一句。第二句。",
		);
	});
});

describe("layoutTranslateSentenceNodes", () => {
	const sentences = [
		{ quote: "A.", source: "A.", translated: "第一句。" },
		{ quote: "B.", source: "B.", translated: "第二句。", display: "第二句。" },
	];

	it("joins without a space when the block translation has none", () => {
		expect(layoutTranslateSentenceNodes("第一句。第二句。", sentences)).toEqual(
			{
				gap: "",
				nodes: [
					{ index: 0, text: "第一句。" },
					{ index: 1, text: "第二句。" },
				],
			},
		);
	});

	it("inserts a space only when the block translation has one between slices", () => {
		expect(
			layoutTranslateSentenceNodes("First. Second.", [
				{ translated: "First." },
				{ translated: "Second." },
			]),
		).toEqual({
			gap: " ",
			nodes: [
				{ index: 0, text: "First." },
				{ index: 1, text: "Second." },
			],
		});
	});

	it("returns null when the pairs do not rebuild the block", () => {
		expect(
			layoutTranslateSentenceNodes("整段译文。", [
				{ translated: "只有一句。" },
			]),
		).toBeNull();
		expect(layoutTranslateSentenceNodes("整段译文。", undefined)).toBeNull();
	});
});

describe("matchingSentenceIndexes", () => {
	const sentences = [
		{ quote: "Alpha runs." },
		{ quote: "Beta follows." },
		{ quote: "Gamma ends." },
	];

	it("matches one sentence or a consecutive run, and nothing partial", () => {
		expect(matchingSentenceIndexes(sentences, "Beta follows.")).toEqual([1]);
		expect(
			matchingSentenceIndexes(sentences, "Alpha runs. Beta follows."),
		).toEqual([0, 1]);
		expect(
			matchingSentenceIndexes(sentences, "Alpha runs. Gamma ends."),
		).toEqual([]);
		expect(matchingSentenceIndexes(sentences, "runs.")).toEqual([]);
	});

	it("tints a sentence when a cross-box highlight contains it whole", () => {
		expect(
			sentenceIndexesCoveredByQuote(
				[{ quote: "Beta follows." }],
				"Alpha runs. Beta follows.",
			),
		).toEqual([0]);
	});

	it("matches a dropped period and ignores a fragment inside a sentence", () => {
		expect(sentenceIndexesCoveredByQuote(sentences, "Beta follows")).toEqual([
			1,
		]);
		expect(sentenceIndexesCoveredByQuote(sentences, "follows. Gamma")).toEqual(
			[],
		);
		expect(
			sentenceIndexesCoveredByQuote(
				[
					{
						quote:
							"We address this with Harbor Adapters , which unify diverse agentic evaluations.",
					},
				],
				"bor Adapters, which unify divers",
			),
		).toEqual([]);
		expect(sentenceIndexesCoveredByQuote(sentences, "runs")).toEqual([]);
	});

	it("unions page quotes and does not widen an exact sentence match", () => {
		expect(
			tintedSentenceIndexes(sentences, ["Gamma ends.", "Beta follows."]),
		).toEqual([2, 1]);
		expect(
			tintedSentenceIndexes(sentences, ["Alpha runs. Beta follows."]),
		).toEqual([0, 1]);
		expect(tintedSentenceIndexes(sentences, [])).toEqual([]);
	});
});

describe("draftChainSentences", () => {
	it("keeps a hyphen in the quote and heals it in the source", () => {
		const drafts = draftChainSentences([
			{
				raw: "A repre- sentation helps. It works.",
				source: "A representation helps. It works.",
				kind: "text",
			},
		]);
		expect(drafts.map((draft) => draft.quote)).toEqual([
			"A repre- sentation helps.",
			"It works.",
		]);
		expect(drafts[0]?.source).toBe("A representation helps.");
		expect(drafts[0]?.spans).toEqual([
			{ memberIndex: 0, rawLength: "A repre- sentation helps.".length },
		]);
	});

	it("records each member's overlap for a sentence cut by a column", () => {
		const drafts = draftChainSentences([
			{
				raw: "the agent queries the",
				source: "the agent queries the",
				kind: "text",
			},
			{
				raw: "environment and then updates its policy.",
				source: "environment and then updates its policy.",
				kind: "text",
			},
		]);
		expect(drafts).toHaveLength(1);
		expect(drafts[0]?.spans).toEqual([
			{ memberIndex: 0, rawLength: "the agent queries the".length },
			{
				memberIndex: 1,
				rawLength: "environment and then updates its policy.".length,
			},
		]);
	});
});

describe("paintSentenceTranslations", () => {
	it("joins Chinese sentences without a space and omits a full-sentence display", () => {
		const drafts = draftChainSentences([
			{
				source: "First sentence. Second sentence.",
				kind: "text",
			},
		]);
		const painted = paintSentenceTranslations(
			drafts,
			["第一句。", "第二句。"],
			1,
			"zh-CN",
		);
		expect(painted[0]?.translated).toBe("第一句。第二句。");
		expect(painted[0]?.sentences?.[0]?.display).toBeUndefined();
		expect(painted[0]?.sentences?.[1]?.translated).toBe("第二句。");
	});

	it("stores the full sentence on every member and a display slice on each", () => {
		const drafts = draftChainSentences([
			{ source: "the agent queries the", kind: "text" },
			{
				source: "environment and then updates its policy.",
				kind: "text",
			},
		]);
		const painted = paintSentenceTranslations(
			drafts,
			["智能体查询环境。随后它更新自己的策略。"],
			2,
			"zh-CN",
		);
		expect(painted[0]?.translated).toBe("智能体查询环境。");
		expect(painted[1]?.translated).toBe("随后它更新自己的策略。");
		expect(painted[0]?.sentences?.[0]?.translated).toBe(
			"智能体查询环境。随后它更新自己的策略。",
		);
		expect(painted[0]?.sentences?.[0]?.display).toBe("智能体查询环境。");
		expect(painted[1]?.sentences?.[0]?.quote).toBe(
			painted[0]?.sentences?.[0]?.quote,
		);
	});
});
