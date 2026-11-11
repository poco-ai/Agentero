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
	it("keeps citation geometry aligned after astral mathematical characters", () => {
		const source =
			"𝐽, 𝐴, 𝑇, 𝑛, 𝑞, 𝜑 and 𝑘 for diamond [27], followed by ordinary prose.";
		const letters = [...source];
		const first = letters.indexOf("[");
		const links: TranslateLinkBox[] = [
			{
				key: "reference",
				kind: "goto",
				box: { x: 0.1 + first * 0.01, y: 0.2, w: 0.04, h: 0.01 },
			},
		];
		const runs = letters.map((text, i) => ({
			text,
			box: { x: 0.1 + i * 0.01, y: 0.2, w: 0.01, h: 0.01 },
		}));
		const assignments = assignPreservedLinks("金刚石 [27]。", links, {
			source,
			block: { x: 0, y: 0, w: 1, h: 1 },
			runs,
		});
		expect(assignments).toMatchObject([{ key: "reference", text: "[27]" }]);
	});
	it("keeps native author-year and arbitrary heading links on their exact original glyphs", () => {
		const text = "See Introduction, Smith et al., 2024 and Fig. 1D.";
		const runs = [...text].map((text, i) => ({
			text,
			box: { x: i * 0.01, y: 0.2, w: 0.01, h: 0.01 },
		}));
		const labels = ["Introduction", "Smith et al., 2024", "Fig. 1D"];
		const links: TranslateLinkBox[] = labels.map((s, i) => ({
			key: `native-${i}`,
			kind: "goto",
			box: { x: text.indexOf(s) * 0.01, y: 0.2, w: s.length * 0.01, h: 0.01 },
		}));
		expect(
			assignPreservedLinks(text, links, {
				source: text,
				block: { x: 0, y: 0, w: 1, h: 1 },
				runs,
				runsInReadingOrder: true,
			}).map((a) => a.text),
		).toEqual(labels);
	});
	it("aligns native links after removing a discretionary line-end hyphen", () => {
		const raw = "tech-nology Smith (2024)";
		const text = raw.replace("tech-nology", "technology");
		const runs = [...raw].map((text, i) => ({
			text,
			box: { x: i * 0.01, y: 0.2, w: 0.01, h: 0.01 },
		}));
		const link: TranslateLinkBox = {
			key: "author",
			kind: "goto",
			box: { x: 0.12, y: 0.2, w: 0.12, h: 0.01 },
		};
		expect(
			assignPreservedLinks(text, [link], {
				source: text,
				block: { x: 0, y: 0, w: 1, h: 1 },
				runs,
				runsInReadingOrder: true,
			}).map((a) => a.text),
		).toEqual(["Smith (2024)"]);
	});
	it("does not match a superscript number inside an earlier measured value", () => {
		const text = "737 nm, result37";
		const runs = [...text].map((text, i) => ({
			text,
			box: { x: 0.1 + i * 0.01, y: 0.2, w: 0.01, h: 0.01 },
		}));
		const link: TranslateLinkBox = {
			key: "ref37",
			kind: "goto",
			box: { x: 0.24, y: 0.2, w: 0.02, h: 0.01 },
		};
		expect(
			assignPreservedLinks(text, [link], {
				source: text,
				block: { x: 0, y: 0, w: 1, h: 1 },
				runs,
				runsInReadingOrder: true,
			}).map((a) => a.text),
		).toEqual(["37"]);
	});
	it("uses prepared reading order when a raised range sits above surrounding prose", () => {
		const text = "word18−20 next";
		const runs = [...text].map((text, i) => ({
			text,
			box: {
				x: 0.1 + i * 0.01,
				y: i >= 4 && i < 9 ? 0.18 : 0.2,
				w: 0.01,
				h: 0.01,
			},
		}));
		const links: TranslateLinkBox[] = [4, 7].map((i) => ({
			key: `ref${i}`,
			kind: "goto",
			box: { ...runs[i].box, w: 0.02 },
		}));
		expect(
			assignPreservedLinks(text, links, {
				source: text,
				block: { x: 0, y: 0, w: 1, h: 1 },
				runs,
				runsInReadingOrder: true,
			}).map((a) => a.text),
		).toEqual(["18", "20"]);
	});
	it("binds bare superscript numbers only at their native link geometry", () => {
		const text = "12 samples, properties1,2 and value 3.";
		const runs = [...text].map((text, i) => ({
			text,
			box: { x: 0.1 + i * 0.01, y: 0.2, w: 0.01, h: 0.01 },
		}));
		const start = text.indexOf("1,2");
		const links: TranslateLinkBox[] = [start, start + 2].map((i) => ({
			key: `cite-${i}`,
			kind: "goto",
			box: runs[i].box,
		}));
		const result = assignPreservedLinks(text, links, {
			source: text,
			block: { x: 0, y: 0, w: 1, h: 1 },
			runs,
		});
		expect(result.map((r) => [r.text, r.key])).toEqual([
			["1", `cite-${start}`],
			["2", `cite-${start + 2}`],
		]);
	});
	it("recognizes Chinese figure/table labels, compact Fig. labels and mathematical minus ranges", () => {
		expect(
			findPreservedLinkSpans("如图1(a)和表 2所示，参见[1−4]，Fig.1b.").map(
				(s) => s.text,
			),
		).toEqual(["图1(a)", "表 2", "[1−4]", "Fig.1b"]);
	});
	it("preserves following panels with an omitted shared Figure prefix", () => {
		expect(
			findPreservedLinkSpans(
				"Figures 4(a) and 4(b); Figs. 6(b) and 6(d). Then 3 samples.",
			).map((s) => s.text),
		).toEqual(["Figures 4(a) and 4(b)", "Figs. 6(b) and 6(d)"]);
	});
	it("includes parenthesized panels and Roman table identifiers in the link hit text", () => {
		expect(
			findPreservedLinkSpans(
				"See [Fig. 1(a)], Figs. 4(c), Table IV and Tables II. Table INVALID is prose.",
			).map((s) => s.text),
		).toEqual(["Fig. 1(a)", "Figs. 4(c)", "Table IV", "Tables II"]);
	});
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
	it("gives a boundary citation to its greatest overlapping paragraph", () => {
		const items = [
			{
				id: "previous",
				bbox: { x: 0.1, y: 0.38, w: 0.6, h: 0.025 },
				readingOrder: 0,
			},
			{
				id: "owner",
				bbox: { x: 0.1, y: 0.399, w: 0.6, h: 0.013 },
				readingOrder: 1,
			},
		];
		const claimed = claimTranslateLinks(items, [
			{
				key: "equation",
				kind: "goto",
				box: { x: 0.28, y: 0.399, w: 0.02, h: 0.011 },
			},
		]);
		expect(claimed.get("previous")).toEqual([]);
		expect(claimed.get("owner")?.map((l) => l.key)).toEqual(["equation"]);
	});
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

	it("restores a wrapped DOI only when its complete text matches a native URI", () => {
		const url = "https://doi.org/10.1109/CSICS07.2007.15";
		const text =
			"A paper. https://doi.org/10.1109/CSICS07. 2007.15. Next entry.";
		const native = link("doi", 0.2, "url", url);
		const assigned = assignPreservedLinks(text, [native]);
		expect(assigned.map((a) => [a.text, a.url, a.key])).toEqual([
			["https://doi.org/10.1109/CSICS07. 2007.15", url, "doi"],
		]);
		// Ordinary whitespace after a URL must remain prose, even when another
		// unrelated native URI exists in the same bibliography block.
		expect(
			assignPreservedLinks("See https://doi.org/10.1109/CSICS07. Next entry", [
				native,
			]).map((a) => a.url),
		).toEqual(["https://doi.org/10.1109/CSICS07"]);
	});

	it("binds a single token to the link on its glyphs instead of an earlier unrecognized link", () => {
		const text = "Supplement 2, see [48].";
		const links: TranslateLinkBox[] = [
			{
				key: "section",
				kind: "goto",
				box: { x: 0.12, y: 0.22, w: 0.02, h: 0.02 },
			},
			{
				key: "cite48",
				kind: "goto",
				box: { x: 0.32, y: 0.22, w: 0.02, h: 0.02 },
			},
		];
		expect(
			assignPreservedLinks(text, links, {
				block,
				runs: [{ text: "[48]", box: { x: 0.31, y: 0.22, w: 0.04, h: 0.02 } }],
			}).map((a) => [a.text, a.key]),
		).toContainEqual(["[48]", "cite48"]);
	});
});
