// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MarkdownSurface } from "@/components/agent/rendering/markdown-surface";
import { tableElementToMarkdown } from "@/components/agent/rendering/table-markdown";

function renderTable(markdown: string): HTMLTableElement {
	const container = document.createElement("div");
	container.innerHTML = renderToStaticMarkup(
		createElement(MarkdownSurface, {}, markdown),
	);
	const table = container.querySelector("table");
	if (!table) throw new Error("Expected a rendered table");
	return table;
}

it("exports formulas in headers and cells as Markdown that renders again", () => {
	const source = String.raw`| Score $\hat{x}$ | Text |
| --- | --- |
| Mean $\sigma_1$ and $\left\|x\right\|$ | a\|b |`;
	const table = renderTable(source);
	const original = table.innerHTML;
	const markdown = tableElementToMarkdown(table);

	expect(markdown).toBe(source);
	expect(table.innerHTML).toBe(original);
	expect(
		Array.from(
			renderTable(markdown).querySelectorAll(
				'annotation[encoding="application/x-tex"]',
			),
			(node) => node.textContent,
		),
	).toEqual([
		String.raw`\hat{x}`,
		String.raw`\sigma_1`,
		String.raw`\left\|x\right\|`,
	]);
});

it("uses the ordinary Markdown table serializer for cells without formulas", () => {
	const source = String.raw`| Text |
| --- |
| a\|b |`;
	expect(tableElementToMarkdown(renderTable(source))).toBe(source);
});
