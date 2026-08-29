import { describe, expect, it } from "vitest";

import { normalizeMarkdownMath } from "@/lib/markdown/math-normalize";

describe("normalizeMarkdownMath", () => {
	it("wraps bare scripted TeX like \\pi_\\theta", () => {
		expect(normalizeMarkdownMath("policy \\pi_\\theta reward")).toBe(
			"policy $\\pi_\\theta$ reward",
		);
	});

	it("wraps braced commands like \\frac{a}{b}", () => {
		expect(normalizeMarkdownMath("loss \\frac{1}{2}")).toBe(
			"loss $\\frac{1}{2}$",
		);
	});

	it("converts \\( \\) and \\[ \\] delimiters", () => {
		expect(normalizeMarkdownMath("see \\(\\pi_\\theta\\) here")).toBe(
			"see $\\pi_\\theta$ here",
		);
		expect(normalizeMarkdownMath("block\n\\[E=mc^2\\]\nok")).toBe(
			"block\n$$\nE=mc^2\n$$\nok",
		);
	});

	it("leaves existing dollar math and code alone", () => {
		expect(normalizeMarkdownMath("already $\\pi_\\theta$ ok")).toBe(
			"already $\\pi_\\theta$ ok",
		);
		expect(normalizeMarkdownMath("code `\\pi_\\theta` ok")).toBe(
			"code `\\pi_\\theta` ok",
		);
		expect(normalizeMarkdownMath("```\n\\pi_\\theta\n```")).toBe(
			"```\n\\pi_\\theta\n```",
		);
	});

	it("does not wrap plain commands without scripts or braces", () => {
		expect(normalizeMarkdownMath("just \\pi alone")).toBe("just \\pi alone");
	});
});
