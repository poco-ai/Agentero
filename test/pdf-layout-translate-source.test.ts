import { describe, expect, it } from "vitest";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/layout-translate";
import {
	buildLayoutTranslateChains,
	isLayoutParagraphContinuation,
	joinContinuationSources,
	normalizeLayoutSourceText,
	splitChainTranslation,
} from "@/lib/pdf/layout/layout-translate-source";
import { maskInlineTokens, restoreInlineTokens } from "@/lib/translate/mask";

describe("normalizeLayoutSourceText", () => {
	it("rejoins words broken by line-break hyphenation", () => {
		expect(
			normalizeLayoutSourceText(
				"We learn a repre- sentation of the infor- mation.",
				"text",
			),
		).toBe("We learn a representation of the information.");
	});

	it("keeps real suspended hyphens before a conjunction", () => {
		expect(
			normalizeLayoutSourceText("We compare pre- and post-training.", "text"),
		).toBe("We compare pre- and post-training.");
	});

	it("expands ligatures and drops soft hyphens", () => {
		expect(normalizeLayoutSourceText("the \uFB01nal \uFB02ow", "text")).toBe(
			"the final flow",
		);
		expect(normalizeLayoutSourceText("re\u00ADsult", "text")).toBe("result");
	});

	it("strips arXiv stamps and venue boilerplate", () => {
		expect(
			normalizeLayoutSourceText(
				"arXiv:2608.00881v1 [cs.LG] 1 Aug 2026 We study agents.",
				"text",
			),
		).toBe("We study agents.");
		expect(
			normalizeLayoutSourceText(
				"Under review as a conference paper at ICLR 2026 We study agents.",
				"text",
			),
		).toBe("We study agents.");
	});

	it("drops a page number glued after a sentence end", () => {
		expect(
			normalizeLayoutSourceText("This completes the proof. 7", "text"),
		).toBe("This completes the proof.");
	});

	it("keeps numbers that belong to a cross-reference", () => {
		expect(normalizeLayoutSourceText("Results are in Table 2", "text")).toBe(
			"Results are in Table 2",
		);
	});

	it("drops a leading line number before a continuation fragment", () => {
		expect(
			normalizeLayoutSourceText("104 and therefore the bound holds.", "text"),
		).toBe("and therefore the bound holds.");
	});

	it("leaves headers untouched by edge-number stripping", () => {
		expect(normalizeLayoutSourceText("3 Method", "header")).toBe("3 Method");
	});
});

describe("paragraph continuation", () => {
	const side = (
		source: string,
		pageIndex = 0,
		kind: LayoutTranslateItem["kind"] = "text",
	) => ({ source, pageIndex, kind });

	it("chains an unfinished sentence into the next fragment", () => {
		expect(
			isLayoutParagraphContinuation(
				side("the model attends over"),
				side("all input tokens.", 1),
			),
		).toBe(true);
	});

	it("does not chain across a finished sentence", () => {
		expect(
			isLayoutParagraphContinuation(
				side("the model attends over all tokens."),
				side("we now describe training.", 1),
			),
		).toBe(false);
	});

	it("does not chain when the next fragment starts a new sentence", () => {
		expect(
			isLayoutParagraphContinuation(
				side("the model attends over"),
				side("We now describe training.", 1),
			),
		).toBe(false);
	});

	it("does not chain headers or captions", () => {
		expect(
			isLayoutParagraphContinuation(
				side("the model attends over"),
				side("all tokens.", 0, "header"),
			),
		).toBe(false);
	});

	it("does not chain a truncated source", () => {
		expect(
			isLayoutParagraphContinuation(
				side("a very long paragraph…"),
				side("continues here.", 1),
			),
		).toBe(false);
	});

	it("heals a hyphen left at the break", () => {
		expect(joinContinuationSources("the repre-", "sentation is")).toBe(
			"the representation is",
		);
		expect(joinContinuationSources("attends over", "all tokens")).toBe(
			"attends over all tokens",
		);
	});
});

describe("buildLayoutTranslateChains", () => {
	function item(
		id: string,
		source: string,
		pageIndex: number,
		kind: LayoutTranslateItem["kind"] = "text",
		readingOrder = 0,
	): LayoutTranslateItem {
		return {
			id,
			pageIndex,
			bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.1 },
			kind,
			readingOrder,
			source,
			status: "pending",
		};
	}

	it("merges a paragraph split across pages into one unit", () => {
		const chains = buildLayoutTranslateChains([
			item("a", "the agent then queries the", 0),
			item("b", "environment for feedback.", 1),
			item("c", "A new paragraph starts here.", 1),
		]);
		expect(chains).toHaveLength(2);
		expect(chains[0]?.members.map((m) => m.id)).toEqual(["a", "b"]);
		expect(chains[0]?.source).toBe(
			"the agent then queries the environment for feedback.",
		);
		expect(chains[1]?.members.map((m) => m.id)).toEqual(["c"]);
	});

	it("chains across an interleaved caption but not across a header", () => {
		const withCaption = buildLayoutTranslateChains([
			item("a", "the loss decreases when the", 0),
			item("cap", "Figure 2: Training curves.", 0, "figure_title"),
			item("b", "batch size grows.", 0),
		]);
		expect(withCaption.map((c) => c.members.map((m) => m.id))).toEqual([
			["a", "b"],
			["cap"],
		]);

		const withHeader = buildLayoutTranslateChains([
			item("a", "the loss decreases when the", 0),
			item("h", "4 Experiments", 0, "header"),
			item("b", "batch size grows.", 0),
		]);
		expect(withHeader.map((c) => c.members.map((m) => m.id))).toEqual([
			["a"],
			["h"],
			["b"],
		]);
	});

	it("caps chain length", () => {
		const fragments = Array.from({ length: 6 }, (_, i) =>
			item(`f${i}`, "the sequence continues with more", i),
		);
		const chains = buildLayoutTranslateChains(fragments);
		for (const chain of chains) {
			expect(chain.members.length).toBeLessThanOrEqual(4);
		}
	});
});

describe("splitChainTranslation", () => {
	it("returns the whole text for a single member", () => {
		expect(splitChainTranslation("一段译文。", [120])).toEqual(["一段译文。"]);
	});

	it("splits at a sentence boundary near the weighted target", () => {
		const parts = splitChainTranslation(
			"智能体先查询环境。随后它根据反馈更新策略。",
			[30, 30],
		);
		expect(parts).toHaveLength(2);
		expect(parts[0]).toBe("智能体先查询环境。");
		expect(parts[1]).toBe("随后它根据反馈更新策略。");
	});

	it("never produces an empty segment", () => {
		const parts = splitChainTranslation("短文本内容", [10, 10, 10]);
		expect(parts).toHaveLength(3);
		for (const part of parts) expect(part.length).toBeGreaterThan(0);
	});

	it("does not cut inside a decimal number", () => {
		const parts = splitChainTranslation(
			"准确率为 0.5 时收敛 稳定性随之提升",
			[10, 10],
		);
		expect(parts.join("")).not.toContain("0.5 时收敛稳定");
		expect(parts[0]?.endsWith("0.")).toBe(false);
	});
});

describe("inline token masking", () => {
	it("masks and restores math, URLs and DOIs", () => {
		const source =
			"See https://example.com/a_b and doi:10.1145/1234.5678 for $x_i \\in \\mathcal{X}$.";
		const masked = maskInlineTokens(source);
		expect(masked.tokens.length).toBeGreaterThan(0);
		expect(masked.text).not.toContain("https://");
		expect(masked.text).toContain("⟦0⟧");
		const restored = restoreInlineTokens(masked.text, masked.tokens);
		expect(restored.missing).toBe(0);
		expect(restored.text).toBe(source);
	});

	it.each([
		"Therefore, $5-x⟪F0⟫$.",
		"We have $$a⟪F0⟫b⟪F1⟫c$$.",
		String.raw`Use \(x⟪F0⟫=2\) here.`,
		"⟪S0⟫Use $x⟪F0⟫$ and [1].⟪/S0⟫",
		"See $x_{[1]}=⟪F0⟫$ and [paper](https://example.org/$x$).",
	])("round-trips nested protected content without nested placeholders: %s", (source) => {
		const masked = maskInlineTokens(source);
		for (const token of masked.tokens)
			expect(token.original).not.toMatch(/⟦\d+⟧/u);
		expect(restoreInlineTokens(masked.text, masked.tokens)).toEqual({
			text: source,
			missing: 0,
		});
	});

	it("protects inline math after display math without absorbing the prose", () => {
		const source = "$$6y-9x⟪F0⟫a.$$Since we know $6y-9x⟪F1⟫b$, we have";
		const masked = maskInlineTokens(source);
		expect(masked.text).toBe("⟦0⟧Since we know ⟦1⟧, we have");
		expect(restoreInlineTokens(masked.text, masked.tokens)).toEqual({
			text: source,
			missing: 0,
		});
	});

	it("tolerates padded placeholders and reports dropped ones", () => {
		const masked = maskInlineTokens("value $x$ and $y$");
		const [first, second] = masked.tokens;
		expect(first && second).toBeTruthy();
		const engineOutput = `数值 ⟦ 0 ⟧ 与`;
		const restored = restoreInlineTokens(engineOutput, masked.tokens);
		expect(restored.text).toContain("$x$");
		expect(restored.missing).toBe(1);
	});

	it("keeps [[n]] batch markers intact", () => {
		const masked = maskInlineTokens("[[1]] first $a$\n\n[[2]] second");
		expect(masked.text).toContain("[[1]]");
		expect(masked.text).toContain("[[2]]");
	});
});
