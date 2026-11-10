// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { latexFromClipboard } from "@/lib/tex/html-to-latex";

describe("html clipboard", () => {
	it("turns structured html into latex and leaves a bare command alone", () => {
		expect(
			latexFromClipboard(
				"<h1>Title</h1><p>A <strong>bold</strong> &amp; <em>note</em></p><ul><li>One</li></ul>",
				"Title",
			),
		).toBe(
			[
				"\\section{Title}",
				"A \\textbf{bold} \\& \\emph{note}",
				["\\begin{itemize}", "\\item One", "\\end{itemize}"].join("\n"),
			].join("\n\n"),
		);
		expect(
			latexFromClipboard("<span>\\cite{key}</span>", "\\cite{key}"),
		).toBeNull();
		expect(latexFromClipboard("<pre>a_b</pre>", "a_b")).toBe(
			"\\begin{verbatim}\na_b\n\\end{verbatim}",
		);
	});
});
