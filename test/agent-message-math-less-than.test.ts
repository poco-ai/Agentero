import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageResponse } from "@/components/agent/message";

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
