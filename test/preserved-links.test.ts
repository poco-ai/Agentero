import { describe, expect, it } from "vitest";
import {
	assignmentsWithin,
	assignPreservedLinks,
	claimTranslateLinks,
	type TranslateLinkBox,
} from "@/lib/pdf/layout/translated-links";
import { maskInlineTokens, restoreInlineTokens } from "@/lib/translate/mask";
import { findPreservedLinkSpans } from "@/lib/translate/preserved-links";

describe("findPreservedLinkSpans", () => {
	it("keeps citations, cross-references, urls, and markdown links", () => {
		const text =
			"See [12] and [1, 3] in Fig. 3 and Section 2. Visit https://example.com/a. Also [label](https://example.com/b) and (Smith et al., 2020).";
		const kinds = findPreservedLinkSpans(text).map((span) => span.text);
		expect(kinds).toEqual([
			"[12]",
			"[1, 3]",
			"Fig. 3",
			"Section 2",
			"https://example.com/a",
			"[label](https://example.com/b)",
			"(Smith et al., 2020)",
		]);
	});

	it("keeps spaced PDF cites and translated author-year forms", () => {
		const text =
			"See ( Jimenez et al. , 2024 ; Merrill et al. , 2026 ) and （Jimenez et al.，2024 ;梅里尔et al.，2026） and （Pan等人，2024 ; Jain等人，2025）.";
		expect(findPreservedLinkSpans(text).map((span) => span.text)).toEqual([
			"( Jimenez et al. , 2024 ; Merrill et al. , 2026 )",
			"（Jimenez et al.，2024 ;梅里尔et al.，2026）",
			"（Pan等人，2024 ; Jain等人，2025）",
		]);
	});

	it("does not treat batch markers as citations", () => {
		const spans = findPreservedLinkSpans("[[1]] first [2] [[3]]");
		expect(spans.map((span) => span.text)).toEqual(["[2]"]);
	});

	it("keeps a PDF citation whose brackets are padded with spaces", () => {
		expect(
			findPreservedLinkSpans(
				"engineering [ 6 , 13 , 15 , 45 ], live coding [ 3 ].",
			).map((span) => span.text),
		).toEqual(["[ 6 , 13 , 15 , 45 ]", "[ 3 ]"]);
	});

	it("keeps a balanced parenthesis that belongs to the url", () => {
		const url = "https://en.wikipedia.org/wiki/Function_(mathematics)";
		const text = `See ${url}.`;
		expect(findPreservedLinkSpans(text).map((span) => span.url)).toEqual([url]);
	});

	it("strips an unmatched closing parenthesis after a url", () => {
		const text = "See (https://example.com/a).";
		expect(findPreservedLinkSpans(text).map((span) => span.url)).toEqual([
			"https://example.com/a",
		]);
	});

	it("keeps a balanced parenthesis inside a markdown url", () => {
		const url = "https://en.wikipedia.org/wiki/Function_(mathematics)";
		const text = `Read [wiki](${url}).`;
		const spans = findPreservedLinkSpans(text);
		expect(spans.map((span) => span.url)).toEqual([url]);
		expect(spans.map((span) => span.text)).toEqual([`[wiki](${url})`]);
	});
});

describe("inline token masking of links", () => {
	it("restores citations and refs the engine would otherwise rewrite", () => {
		const source =
			"As shown in Fig. 3 and [12], see https://example.com/paper.";
		const masked = maskInlineTokens(source);
		expect(masked.text).not.toContain("Fig. 3");
		expect(masked.text).not.toContain("[12]");
		expect(masked.text).not.toContain("https://");
		expect(masked.text).toContain("⟦");
		const restored = restoreInlineTokens(masked.text, masked.tokens);
		expect(restored.missing).toBe(0);
		expect(restored.text).toBe(source);
	});

	it("leaves [[n]] batch markers intact", () => {
		const masked = maskInlineTokens("[[1]] first [2]\n\n[[3]] second");
		expect(masked.text).toContain("[[1]]");
		expect(masked.text).toContain("[[3]]");
		expect(masked.text).not.toContain("[2]");
	});
});

describe("assignPreservedLinks", () => {
	const block = { x: 0.1, y: 0.2, w: 0.4, h: 0.1 };

	function link(
		key: string,
		x: number,
		kind: TranslateLinkBox["kind"] = "goto",
		url?: string,
	): TranslateLinkBox {
		return {
			key,
			kind,
			url,
			box: { x, y: 0.22, w: 0.04, h: 0.02 },
		};
	}

	it("gives each link to the block that contains it and pairs tokens in order", () => {
		const items = [
			{ id: "a", bbox: block, readingOrder: 0 },
			{ id: "b", bbox: { x: 0.55, y: 0.2, w: 0.3, h: 0.1 }, readingOrder: 1 },
		];
		const claimed = claimTranslateLinks(items, [
			link("cite", 0.12),
			link("fig", 0.2),
			link("other", 0.6),
			link("url", 0.3, "url", "https://example.com/a"),
		]);
		expect(claimed.get("a")?.map((item) => item.key)).toEqual([
			"cite",
			"fig",
			"url",
		]);
		expect(claimed.get("b")?.map((item) => item.key)).toEqual(["other"]);
		const text = "See [12] and Fig. 3 at https://example.com/a.";
		const assigned = assignPreservedLinks(text, claimed.get("a") ?? []);
		expect(assigned.map((item) => [item.text, item.key])).toEqual([
			["[12]", "cite"],
			["Fig. 3", "fig"],
			["https://example.com/a", "url"],
		]);
		const fig = assigned[1];
		if (!fig) throw new Error("missing fig assignment");
		expect(assignmentsWithin(assigned, fig.start, fig.end)).toEqual([
			{ ...fig, start: 0, end: fig.text.length },
		]);
	});

	it("splits a bracket group when same-line link tops differ by a fraction", () => {
		const block = { x: 0.1, y: 0.3, w: 0.8, h: 0.12 };
		const link = (
			key: string,
			x: number,
			y: number,
			w = 0.022,
		): TranslateLinkBox => ({
			key,
			kind: "goto",
			box: { x, y, w, h: 0.0105 },
		});
		// The single-digit cite sits a fraction higher. A raw top-edge sort
		// would place it before the citations to its left.
		const claimed = claimTranslateLinks(
			[{ id: "p", bbox: block, readingOrder: 0 }],
			[
				link("n18", 0.1857, 0.3879),
				link("n27", 0.2137, 0.3879),
				link("n29", 0.2416, 0.3879),
				link("n6", 0.639, 0.3876, 0.0127),
				link("n13", 0.6576, 0.3879),
				link("n15", 0.6856, 0.3879),
				link("n45", 0.7135, 0.3879),
				link("n3", 0.84, 0.3879, 0.0127),
			],
		);
		const assigned = assignPreservedLinks(
			"调用[18,27,29]，以及工程[6,13,15,45]和编码[3]。",
			claimed.get("p") ?? [],
		);
		expect(assigned.map((item) => [item.text, item.key])).toEqual([
			["18", "n18"],
			["27", "n27"],
			["29", "n29"],
			["6", "n6"],
			["13", "n13"],
			["15", "n15"],
			["45", "n45"],
			["[3]", "n3"],
		]);
	});

	it("splits the bracket whose glyphs match even when an earlier link is still queued", () => {
		const text = "见 [6,45] 和 [44]。";
		const block = { x: 0.1, y: 0.7, w: 0.8, h: 0.1 };
		const assigned = assignPreservedLinks(
			text,
			[
				// Previous line, further right than this bracket. An x-only
				// "past the token" check stops here and the group stays one link.
				{
					key: "above-right",
					kind: "goto",
					box: { x: 0.87, y: 0.745, w: 0.02, h: 0.011 },
				},
				{
					key: "orphan",
					kind: "goto",
					box: { x: 0.2, y: 0.76, w: 0.02, h: 0.012 },
				},
				{
					key: "n6",
					kind: "goto",
					box: { x: 0.298, y: 0.7737, w: 0.0127, h: 0.011 },
				},
				{
					key: "n45",
					kind: "goto",
					box: { x: 0.3183, y: 0.774, w: 0.022, h: 0.011 },
				},
				{
					key: "n44",
					kind: "goto",
					box: { x: 0.52, y: 0.774, w: 0.022, h: 0.011 },
				},
			],
			{
				block,
				runs: [
					{ text: "[6,45]", box: { x: 0.29, y: 0.7685, w: 0.05, h: 0.019 } },
					{ text: "[44]", box: { x: 0.52, y: 0.7685, w: 0.03, h: 0.019 } },
				],
			},
		);
		expect(assigned.map((item) => [item.text, item.key])).toEqual([
			["6", "n6"],
			["45", "n45"],
			["[44]", "n44"],
		]);
	});

	it("splits a bracket group into one target per adjacent link", () => {
		const near = (key: string, x: number): TranslateLinkBox => ({
			key,
			kind: "goto",
			box: { x, y: 0.51, w: 0.022, h: 0.011 },
			color: key === "n38" ? "#ed028c" : "#00a3e3",
		});
		const text = "环境 [17,38]。随后 [46]。";
		const assigned = assignPreservedLinks(text, [
			near("n17", 0.39),
			near("n38", 0.418),
			near("n46", 0.7),
		]);
		expect(assigned.map((item) => [item.text, item.key, item.color])).toEqual([
			["17", "n17", "#00a3e3"],
			["38", "n38", "#ed028c"],
			["[46]", "n46", "#00a3e3"],
		]);
	});

	it("splits a bracket group when the same rect is listed many times", () => {
		const camel: TranslateLinkBox = {
			key: "n17",
			kind: "goto",
			box: { x: 0.389715, y: 0.51265, w: 0.021958, h: 0.010851 },
			color: "#00a3e3",
		};
		const autogen: TranslateLinkBox = {
			key: "n38",
			kind: "goto",
			box: { x: 0.418171, y: 0.51265, w: 0.021958, h: 0.010644 },
			color: "#00a3e3",
		};
		const text = "工具交互[17,38]。";
		const assigned = assignPreservedLinks(text, [
			camel,
			{ ...camel, key: "n17-dup" },
			{ ...camel, key: "n17-dup-2" },
			autogen,
			{ ...autogen, key: "n38-dup" },
		]);
		expect(assigned.map((item) => [item.text, item.key])).toEqual([
			["17", "n17"],
			["38", "n38"],
		]);
	});

	it("does not borrow the next citation when one annotation covers the group", () => {
		const text = "环境 [17,38] 随后 [46]。";
		const assigned = assignPreservedLinks(text, [
			{
				key: "group",
				kind: "goto",
				box: { x: 0.39, y: 0.51, w: 0.05, h: 0.012 },
			},
			{
				key: "n46",
				kind: "goto",
				box: { x: 0.452, y: 0.51, w: 0.022, h: 0.012 },
			},
		]);
		expect(assigned.map((item) => [item.text, item.key])).toEqual([
			["[17,38]", "group"],
			["[46]", "n46"],
		]);
	});

	it("keeps a later citation outside the source token even when the gap is small", () => {
		const text = "见 [17,38] 随后 [46]。";
		const assigned = assignPreservedLinks(
			text,
			[
				{
					key: "group",
					kind: "goto",
					box: { x: 0.3, y: 0.51, w: 0.025, h: 0.012 },
				},
				{
					key: "n46",
					kind: "goto",
					box: { x: 0.345, y: 0.51, w: 0.02, h: 0.012 },
				},
			],
			{
				block: { x: 0.2, y: 0.48, w: 0.4, h: 0.08 },
				runs: [
					{
						text: "[17,38]",
						box: { x: 0.3, y: 0.51, w: 0.035, h: 0.012 },
					},
					{
						text: "[46]",
						box: { x: 0.345, y: 0.51, w: 0.02, h: 0.012 },
					},
				],
			},
		);
		expect(assigned.map((item) => [item.text, item.key])).toEqual([
			["[17,38]", "group"],
			["[46]", "n46"],
		]);
	});

	it("splits when each number's link sits on the source token", () => {
		const text = "见 [17,38] 随后 [46]。";
		const assigned = assignPreservedLinks(
			text,
			[
				{
					key: "n17",
					kind: "goto",
					box: { x: 0.31, y: 0.51, w: 0.02, h: 0.012 },
				},
				{
					key: "n38",
					kind: "goto",
					box: { x: 0.34, y: 0.51, w: 0.02, h: 0.012 },
				},
				{
					key: "n46",
					kind: "goto",
					box: { x: 0.7, y: 0.51, w: 0.02, h: 0.012 },
				},
			],
			{
				block: { x: 0.2, y: 0.48, w: 0.6, h: 0.08 },
				runs: [
					{
						text: "[17,38]",
						box: { x: 0.3, y: 0.51, w: 0.08, h: 0.012 },
					},
					{
						text: "[46]",
						box: { x: 0.7, y: 0.51, w: 0.02, h: 0.012 },
					},
				],
			},
		);
		expect(assigned.map((item) => [item.text, item.key])).toEqual([
			["17", "n17"],
			["38", "n38"],
			["[46]", "n46"],
		]);
	});

	it("keeps each citation when the translation reverses two clauses", () => {
		const source = "前半引用 [1]，后半引用 [2]。";
		const translated = "后半引用 [2]，前半引用 [1]。";
		const assigned = assignPreservedLinks(
			translated,
			[
				{
					key: "n1",
					kind: "goto",
					box: { x: 0.2, y: 0.51, w: 0.02, h: 0.012 },
				},
				{
					key: "n2",
					kind: "goto",
					box: { x: 0.55, y: 0.51, w: 0.02, h: 0.012 },
				},
			],
			{ source },
		);
		expect(assigned.map((item) => [item.text, item.key])).toEqual([
			["[2]", "n2"],
			["[1]", "n1"],
		]);
	});

	it("keeps a grouped citation's links when that group moves after the next cite", () => {
		const source = "见 [17,38]，另见 [46]。";
		const translated = "另见 [46]，见 [17,38]。";
		const assigned = assignPreservedLinks(
			translated,
			[
				{
					key: "n17",
					kind: "goto",
					box: { x: 0.39, y: 0.51, w: 0.022, h: 0.011 },
				},
				{
					key: "n38",
					kind: "goto",
					box: { x: 0.418, y: 0.51, w: 0.022, h: 0.011 },
				},
				{
					key: "n46",
					kind: "goto",
					box: { x: 0.7, y: 0.51, w: 0.022, h: 0.011 },
				},
			],
			{ source },
		);
		expect(assigned.map((item) => [item.text, item.key])).toEqual([
			["[46]", "n46"],
			["17", "n17"],
			["38", "n38"],
		]);
	});

	it("pairs a rewritten marker with the remaining links in source order", () => {
		const assigned = assignPreservedLinks(
			"参见 [9]。",
			[
				{
					key: "n1",
					kind: "goto",
					box: { x: 0.2, y: 0.51, w: 0.02, h: 0.012 },
				},
				{
					key: "n2",
					kind: "goto",
					box: { x: 0.55, y: 0.51, w: 0.02, h: 0.012 },
				},
			],
			{ source: "见 [1] 与 [2]。" },
		);
		expect(assigned.map((item) => [item.text, item.key])).toEqual([
			["[9]", "n1"],
		]);
	});

	it("does not bind an unlinked interval to the next citation", () => {
		const text = "x ∈ [0,1] see [17].";
		const block = { x: 0.1, y: 0.48, w: 0.7, h: 0.08 };
		const runs = [
			{ text: "[0,1]", box: { x: 0.2, y: 0.51, w: 0.08, h: 0.012 } },
			{ text: "[17]", box: { x: 0.55, y: 0.51, w: 0.06, h: 0.012 } },
		];
		const links: TranslateLinkBox[] = [
			{
				key: "n17",
				kind: "goto",
				box: { x: 0.56, y: 0.51, w: 0.03, h: 0.012 },
			},
		];
		const assigned = assignPreservedLinks(text, links, { block, runs });
		expect(assigned.map((item) => [item.text, item.key])).toEqual([
			["[17]", "n17"],
		]);
		const moved = assignPreservedLinks("区间 [0,1]，见 [17]。", links, {
			source: text,
			block,
			runs,
		});
		expect(moved.map((item) => [item.text, item.key])).toEqual([
			["[17]", "n17"],
		]);
	});

	it("keeps one bracket group when the next link is not beside it", () => {
		const text = "见 [17,38]，另见 [46]。";
		const assigned = assignPreservedLinks(text, [
			{
				key: "only",
				kind: "goto",
				box: { x: 0.39, y: 0.51, w: 0.022, h: 0.011 },
			},
			{
				key: "later",
				kind: "goto",
				box: { x: 0.7, y: 0.51, w: 0.022, h: 0.011 },
			},
		]);
		expect(assigned.map((item) => [item.text, item.key])).toEqual([
			["[17,38]", "only"],
			["[46]", "later"],
		]);
	});

	it("opens a markdown link from its own url", () => {
		const text = "Read [paper](https://example.com/p).";
		const link = "[paper](https://example.com/p)";
		const start = text.indexOf(link);
		const assigned = assignPreservedLinks(text, []);
		expect(assigned).toEqual([
			{
				start,
				end: start + link.length,
				text: link,
				key: null,
				url: "https://example.com/p",
			},
		]);
	});
});
