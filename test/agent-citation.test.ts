import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "@/components/agent/message";
import {
	linkifyBareUrls,
	linkifyBareVaultCitations,
} from "@/lib/agent/bare-url-link";
import {
	citationHrefFromWikiParts,
	citationLabelFromHref,
	cleanCitationHref,
	isAgentCitationHref,
	isCitationStatusLabel,
	isVaultPdfHref,
	paperDirFromCitationPath,
	rewriteCitationHrefToPdf,
	stripCitationStatusTags,
} from "@/lib/agent/citation-href";
import {
	prefixVaultMarkdownHrefs,
	prepareAgentMessageMarkdown,
} from "@/lib/agent/message-markdown";
import {
	linkifyWikilinks,
	normalizeWikiCitationHref,
	parseWikiCitationBody,
} from "@/lib/agent/wikilink-citation";

describe("paperDirFromCitationPath", () => {
	it("strips source/ and marks/ suffixes", () => {
		expect(
			paperDirFromCitationPath(
				"papers/2303.17760/source/sections/introduction.tex",
			),
		).toBe("papers/2303.17760");
		expect(paperDirFromCitationPath("papers/a/marks/x.json")).toBe("papers/a");
	});
});

describe("rewriteCitationHrefToPdf", () => {
	it("rewrites tex paths under source/ to the paper PDF", () => {
		expect(
			rewriteCitationHrefToPdf(
				"papers/2303.17760/source/sections/introduction.tex",
			),
		).toBe("papers/2303.17760/2303.17760.pdf");
	});

	it("preserves fragments when rewriting", () => {
		expect(
			rewriteCitationHrefToPdf(
				"papers/2303.17760/source/sections/intro.tex#section=2.3",
			),
		).toBe("papers/2303.17760/2303.17760.pdf#section=2.3");
	});

	it("leaves pdf and notes hrefs unchanged", () => {
		expect(
			rewriteCitationHrefToPdf("papers/2303.17760/2303.17760.pdf#page=11"),
		).toBe("papers/2303.17760/2303.17760.pdf#page=11");
		expect(rewriteCitationHrefToPdf("papers/2303.17760/NOTES.md")).toBe(
			"papers/2303.17760/NOTES.md",
		);
	});
});

describe("isAgentCitationHref", () => {
	it("accepts pdf fragment citations", () => {
		expect(
			isAgentCitationHref("papers/vla/2504.16054/2504.16054.pdf#page=1"),
		).toBe(true);
		expect(
			isAgentCitationHref("papers/vla/2504.16054/2504.16054.pdf#section=4"),
		).toBe(true);
		expect(
			isAgentCitationHref("papers/vla/2504.16054/2504.16054.pdf#figure=3"),
		).toBe(true);
		expect(
			isAgentCitationHref("papers/vla/2504.16054/2504.16054.pdf#formula=3"),
		).toBe(true);
		expect(
			isAgentCitationHref("papers/vla/2504.16054/2504.16054.pdf#equation=3"),
		).toBe(false);
	});

	it("rejects plain paths and http urls", () => {
		expect(isAgentCitationHref("papers/vla/2504.16054/2504.16054.pdf")).toBe(
			false,
		);
		expect(isAgentCitationHref("https://example.com/a.pdf#page=1")).toBe(false);
		expect(isAgentCitationHref("papers/vla/2504.16054/NOTES.md#Intro")).toBe(
			false,
		);
	});

	it("tolerates zero-width spaces around the href", () => {
		expect(
			isAgentCitationHref(
				"\u200bpapers/vla/2504.16054/2504.16054.pdf#page=1\u200b",
			),
		).toBe(true);
	});

	it("accepts percent-encoded paths with spaces", () => {
		expect(
			isAgentCitationHref(
				"/papers/Quantum%20Error%20Correcting/parallel%20window/2209.08552/2209.08552.pdf#page=4",
			),
		).toBe(true);
	});
});

describe("isVaultPdfHref", () => {
	it("accepts a PDF path with or without a fragment", () => {
		expect(
			isVaultPdfHref(
				"./papers/Quantum%20Error%20Correcting/parallel%20window/2209.08552/2209.08552.pdf",
			),
		).toBe(true);
		expect(
			isVaultPdfHref(
				"papers/Quantum Error Correcting/parallel window/2209.08552/2209.08552.pdf#page=4",
			),
		).toBe(true);
	});

	it("rejects notes and http pdf urls", () => {
		expect(isVaultPdfHref("papers/a/NOTES.md")).toBe(false);
		expect(isVaultPdfHref("https://example.com/a.pdf")).toBe(false);
	});
});

describe("stripCitationStatusTags", () => {
	it("removes trailing status tags from source lines", () => {
		expect(
			stripCitationStatusTags(
				"papers/Dflash/2608.02438/NOTES.md [blocked]\npapers/a/a.pdf#page=11 [read]",
			),
		).toBe("papers/Dflash/2608.02438/NOTES.md\npapers/a/a.pdf#page=11");
	});
});

describe("citation status labels", () => {
	it("detects status-only link labels", () => {
		expect(isCitationStatusLabel("blocked")).toBe(true);
		expect(isCitationStatusLabel("Failed")).toBe(true);
		expect(isCitationStatusLabel("Section 2")).toBe(false);
	});

	it("derives a pill label from the href when the label is a status word", () => {
		expect(
			citationLabelFromHref("papers/vla/2504.16054/2504.16054.pdf#page=11"),
		).toBe("2504.16054.pdf · p.11");
		expect(citationLabelFromHref("papers/a/NOTES.md")).toBe("NOTES.md");
	});
});

describe("citationHrefFromWikiParts", () => {
	it("maps wiki heading page=/section= onto a citation href", () => {
		expect(
			citationHrefFromWikiParts("papers/a/a.pdf", {
				kind: "heading",
				path: ["page=1"],
			}),
		).toBe("papers/a/a.pdf#page=1");
		expect(
			citationHrefFromWikiParts("papers/a/a.pdf", {
				kind: "heading",
				path: ["Intro"],
			}),
		).toBeNull();
	});
});

describe("PDF document anchors", () => {
	it("routes section and paragraph shorthand only for PDF targets", () => {
		for (const fragment of ["2", "2.1", "2#p3", "2.1#p3"]) {
			expect(isAgentCitationHref(`papers/a/a.pdf#${fragment}`)).toBe(true);
			expect(isAgentCitationHref(`papers/a/NOTES.md#${fragment}`)).toBe(false);
			expect(
				citationHrefFromWikiParts("papers/a/a.pdf", {
					kind: "heading",
					path: fragment.split("#"),
				}),
			).toBe(`papers/a/a.pdf#${fragment}`);
			expect(
				citationHrefFromWikiParts("papers/a/NOTES.md", {
					kind: "heading",
					path: fragment.split("#"),
				}),
			).toBeNull();
		}
		expect(isAgentCitationHref("https://example.com/a.pdf#2#p3")).toBe(false);
		expect(isAgentCitationHref("papers/a/a.pdf#2%23p3")).toBe(true);
	});
});

describe("parseWikiCitationBody", () => {
	it("parses target and alias", () => {
		expect(parseWikiCitationBody("papers/a/NOTES|short")).toEqual({
			target: "papers/a/NOTES",
			alias: "short",
		});
	});

	it("parses target only", () => {
		expect(parseWikiCitationBody("papers/a/NOTES.md")).toEqual({
			target: "papers/a/NOTES.md",
			alias: undefined,
		});
	});
});

describe("normalizeWikiCitationHref", () => {
	it("appends .md for NOTES/PAPER/README basenames", () => {
		expect(normalizeWikiCitationHref("papers/vla/2504.16054/NOTES")).toBe(
			"papers/vla/2504.16054/NOTES.md",
		);
		expect(normalizeWikiCitationHref("papers/x/PAPER#intro")).toBe(
			"papers/x/PAPER.md#intro",
		);
	});

	it("keeps paper folder paths and existing extensions", () => {
		expect(normalizeWikiCitationHref("papers/vla/2504.16054")).toBe(
			"papers/vla/2504.16054",
		);
		expect(normalizeWikiCitationHref("papers/x/NOTES.md")).toBe(
			"papers/x/NOTES.md",
		);
	});
});

describe("linkifyWikilinks", () => {
	it("converts vault path wikilinks into markdown citation links", () => {
		expect(
			linkifyWikilinks("See [[papers/vla/2504.16054/NOTES]] for notes."),
		).toBe("See [NOTES](papers/vla/2504.16054/NOTES.md) for notes.");
	});

	it("uses alias as the pill label", () => {
		expect(linkifyWikilinks("[[papers/vla/2504.16054/NOTES|π0.5 notes]]")).toBe(
			"[π0.5 notes](papers/vla/2504.16054/NOTES.md)",
		);
	});

	it("leaves embeds and alias-only wikilinks alone", () => {
		expect(linkifyWikilinks("![[papers/x/fig.png]] and [[CAMEL]]")).toBe(
			"![[papers/x/fig.png]] and [[CAMEL]]",
		);
	});

	it("skips wikilinks inside inline code and fences", () => {
		expect(linkifyWikilinks("Use `[[papers/x/NOTES]]` literally.")).toBe(
			"Use `[[papers/x/NOTES]]` literally.",
		);
		expect(
			linkifyWikilinks("```\n[[papers/x/NOTES]]\n```\n[[papers/y/NOTES]]"),
		).toBe("```\n[[papers/x/NOTES]]\n```\n[NOTES](papers/y/NOTES.md)");
	});

	it("does not require outer parentheses around citations", () => {
		const text =
			"Claim. [Section 2.3](papers/a/PAPER.md#section=2.3) and [[papers/a/NOTES]].";
		expect(linkifyWikilinks(text)).toBe(
			"Claim. [Section 2.3](papers/a/PAPER.md#section=2.3) and [NOTES](papers/a/NOTES.md).",
		);
	});
});

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

describe("prefixVaultMarkdownHrefs", () => {
	it("prefixes bare vault citation hrefs so rehype-harden keeps them", () => {
		expect(
			prefixVaultMarkdownHrefs(
				"问？[摘要](papers/vla/2504.16054/2504.16054.pdf#page=1)",
			),
		).toBe("问？[摘要](./papers/vla/2504.16054/2504.16054.pdf#page=1)");
	});

	it("does not double-prefix", () => {
		expect(
			prefixVaultMarkdownHrefs(
				"[图7](./papers/vla/2504.16054/2504.16054.pdf#figure=7)",
			),
		).toBe("[图7](./papers/vla/2504.16054/2504.16054.pdf#figure=7)");
	});

	it("leaves http links alone", () => {
		expect(prefixVaultMarkdownHrefs("[arXiv](https://arxiv.org/abs/1)")).toBe(
			"[arXiv](https://arxiv.org/abs/1)",
		);
	});

	it("prefixes percent-encoded vault hrefs without double-encoding", () => {
		const href =
			"papers/Quantum%20Error%20Correcting/parallel%20window/2209.08552/2209.08552.pdf#page=4";
		expect(prefixVaultMarkdownHrefs(`[p.4](./${href})`)).toBe(
			`[p.4](./${href})`,
		);
		expect(prefixVaultMarkdownHrefs(`[p.4](${href})`)).toBe(`[p.4](./${href})`);
	});

	it("rewrites CommonMark angle-bracket destinations so harden keeps them", () => {
		expect(
			prefixVaultMarkdownHrefs(
				"[p.4](<papers/Quantum Error Correcting/parallel window/2209.08552/2209.08552.pdf#page=4>)",
			),
		).toBe(
			"[p.4](./papers/Quantum%20Error%20Correcting/parallel%20window/2209.08552/2209.08552.pdf#page=4)",
		);
		expect(
			prefixVaultMarkdownHrefs(
				"[Figure 4](<papers/Quantum Error Correcting/parallel window/2209.08552/2209.08552.pdf#figure=4>)",
			),
		).toBe(
			"[Figure 4](./papers/Quantum%20Error%20Correcting/parallel%20window/2209.08552/2209.08552.pdf#figure=4)",
		);
		expect(
			prefixVaultMarkdownHrefs(
				"[p.4](<papers/Foo (2024)/2209.08552/2209.08552.pdf#page=4>)",
			),
		).toBe("[p.4](./papers/Foo%20%282024%29/2209.08552/2209.08552.pdf#page=4)");
	});
});

describe("prepareAgentMessageMarkdown", () => {
	it("keeps citation links and prefixes vault hrefs", () => {
		const input =
			"核心问题？[摘要](papers/vla/2504.16054/2504.16054.pdf#page=1)\n\n详见[图7](papers/vla/2504.16054/2504.16054.pdf#figure=7)和第4.1节。";
		const out = prepareAgentMessageMarkdown(input);
		expect(out).toContain(
			"[摘要](./papers/vla/2504.16054/2504.16054.pdf#page=1)",
		);
		expect(out).toContain(
			"[图7](./papers/vla/2504.16054/2504.16054.pdf#figure=7)",
		);
		expect(out).not.toMatch(/\[.*\[摘要\]/);
	});

	it("keeps spaced PDF citations clickable through the full prepare pipeline", () => {
		const spaced =
			"[p.4](<papers/Quantum Error Correcting/parallel window/2209.08552/2209.08552.pdf#page=4>)";
		const encoded =
			"[p.4](./papers/Quantum%20Error%20Correcting/parallel%20window/2209.08552/2209.08552.pdf#page=4)";
		expect(prepareAgentMessageMarkdown(spaced)).toBe(encoded);
		expect(prepareAgentMessageMarkdown(encoded)).toBe(encoded);
		expect(
			cleanCitationHref(
				"./papers/Quantum%20Error%20Correcting/parallel%20window/2209.08552/2209.08552.pdf#page=4",
			),
		).toBe(
			"papers/Quantum Error Correcting/parallel window/2209.08552/2209.08552.pdf#page=4",
		);
	});
});

describe("cleanCitationHref", () => {
	it("strips the ./ prefix added for Streamdown harden", () => {
		expect(
			cleanCitationHref("./papers/vla/2504.16054/2504.16054.pdf#page=1"),
		).toBe("papers/vla/2504.16054/2504.16054.pdf#page=1");
	});

	it("decodes percent-encoded vault paths before lookup", () => {
		expect(
			cleanCitationHref(
				"/papers/Quantum%20Error%20Correcting/parallel%20window/2209.08552/2209.08552.pdf#page=4",
			),
		).toBe(
			"/papers/Quantum Error Correcting/parallel window/2209.08552/2209.08552.pdf#page=4",
		);
		expect(
			cleanCitationHref(
				"./papers/Quantum%20Error%20Correcting/parallel%20window/2209.08552/2209.08552.pdf#figure=4",
			),
		).toBe(
			"papers/Quantum Error Correcting/parallel window/2209.08552/2209.08552.pdf#figure=4",
		);
		expect(
			cleanCitationHref(
				"./papers/Foo%20%282024%29/2209.08552/2209.08552.pdf#page=4",
			),
		).toBe("papers/Foo (2024)/2209.08552/2209.08552.pdf#page=4");
	});

	it("leaves scheme URLs and invalid percent sequences encoded", () => {
		expect(cleanCitationHref("https://example.com/a%20b")).toBe(
			"https://example.com/a%20b",
		);
		expect(cleanCitationHref("papers/foo%2/a.pdf#page=1")).toBe(
			"papers/foo%2/a.pdf#page=1",
		);
	});
});

/**
 * Streamdown's streaming mode runs `remend`, which truncates a TeX `<`
 * comparison (`x_{<n}`) as an unclosed HTML tag — KaTeX then fails with
 * `Expected '}', got 'EOF'` (#584). Settled messages must render statically.
 */
const ISSUE_MATH = `$$
\\mathcal{L}_{\\mathrm{AR}} = -\\frac{1}{N}\\sum_{n=1}^{N}\\log p_{\\theta}\\left(x_n \\mid x_{<n}, \\mathbf{c}\\right).
$$
`;

function render(children: string) {
	return renderToStaticMarkup(
		createElement(MessageResponse as never, { children } as never),
	);
}

describe("#584 math `<` truncated by streaming repair", () => {
	it("renders the full display equation once the message settled", () => {
		const html = render(ISSUE_MATH);
		expect(html).not.toContain("katex-error");
		expect(html).toContain("x_{&lt;n}");
	});

	it("keeps inline math `$x<y$` and prose `p<0.05` intact", () => {
		const html = render("If $x<y$ holds and p<0.05, accept.");
		expect(html).not.toContain("katex-error");
		expect(html).toContain("x&lt;y</annotation>");
		expect(html).toContain("p&lt;0.05");
	});

	it("keeps a code span containing `<` from being swallowed", () => {
		const html = render("use ``a<n`` here");
		expect(html).toContain("a&lt;n");
	});
});
