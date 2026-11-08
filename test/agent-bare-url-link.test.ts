import { describe, expect, it } from "vitest";
import {
	linkifyBareUrls,
	linkifyBareVaultCitations,
} from "@/lib/agent/bare-url-link";

describe("linkifyBareVaultCitations", () => {
	it("wraps a bare PDF citation path in a Markdown link", () => {
		expect(
			linkifyBareVaultCitations(
				"Figure 9 (papers/vla/2504.16054/2504.16054.pdf#figure=9)",
			),
		).toBe(
			"Figure 9 ([2504.16054.pdf · figure=9](./papers/vla/2504.16054/2504.16054.pdf#figure=9))",
		);
	});

	it("wraps a bare PDF formula citation path in a Markdown link", () => {
		expect(
			linkifyBareVaultCitations(
				"Equation 3 (papers/vla/2504.16054/2504.16054.pdf#formula=3)",
			),
		).toBe(
			"Equation 3 ([2504.16054.pdf · formula=3](./papers/vla/2504.16054/2504.16054.pdf#formula=3))",
		);
	});

	it("does not link the removed equation alias", () => {
		const prose =
			"Equation 3 (papers/vla/2504.16054/2504.16054.pdf#equation=3)";
		expect(linkifyBareVaultCitations(prose)).toBe(prose);
	});

	it("leaves Markdown links and inline code unchanged", () => {
		const href = "papers/vla/2504.16054/2504.16054.pdf#page=1";
		expect(linkifyBareVaultCitations(`[Figure 1](${href})`)).toBe(
			`[Figure 1](${href})`,
		);
		expect(linkifyBareVaultCitations(`\`${href}\``)).toBe(`\`${href}\``);
	});
});

describe("linkifyBareUrls", () => {
	it("wraps a bare http url in a markdown link", () => {
		expect(linkifyBareUrls("See https://example.com for details.")).toBe(
			"See [example.com](https://example.com) for details.",
		);
	});

	it("does not double-wrap existing markdown links", () => {
		expect(
			linkifyBareUrls("[example](https://example.com) and https://other.com"),
		).toBe("[example](https://example.com) and [other.com](https://other.com)");
	});

	it("skips urls inside inline code", () => {
		expect(linkifyBareUrls("`https://example.com` is a url.")).toBe(
			"`https://example.com` is a url.",
		);
	});

	it("strips www from the label", () => {
		expect(linkifyBareUrls("https://www.arxiv.org/abs/1234")).toBe(
			"[arxiv.org](https://www.arxiv.org/abs/1234)",
		);
	});
});
