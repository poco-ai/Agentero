import { extractTableDataFromElement, tableDataToMarkdown } from "streamdown";
import {
	RENDERED_MATH_SELECTOR,
	renderedMathSource,
} from "@/lib/markdown/rendered-math";

/**
 * Streamdown serializes table cells from rendered text. KaTeX contributes both
 * visual glyphs and hidden MathML, so restore the TeX annotation after the
 * table has been escaped as Markdown.
 */
export function tableElementToMarkdown(table: HTMLTableElement): string {
	const mathNodes = Array.from(
		table.querySelectorAll(RENDERED_MATH_SELECTOR),
	).filter((node) => renderedMathSource(node));
	if (mathNodes.length === 0) {
		return tableDataToMarkdown(extractTableDataFromElement(table));
	}

	const copy = table.cloneNode(true) as HTMLTableElement;
	const text = copy.textContent ?? "";
	let prefix = "AGENTEROMATH";
	while (text.includes(prefix)) prefix += "X";

	const formulas: string[] = [];
	for (const math of copy.querySelectorAll(RENDERED_MATH_SELECTOR)) {
		const tex = renderedMathSource(math);
		if (!tex) continue;
		// Preserve existing TeX escapes and keep literal pipes inside the cell.
		const source = tex
			.replace(/[\r\n]+/g, " ")
			.replace(/\\.|\|/g, (part) => (part === "|" ? "\\|" : part));
		math.replaceWith(`${prefix}${formulas.length}END`);
		formulas.push(`$${source}$`);
	}

	const markdown = tableDataToMarkdown(extractTableDataFromElement(copy));
	return markdown.replace(
		new RegExp(`${prefix}(\\d+)END`, "g"),
		(match, index) => formulas[Number(index)] ?? match,
	);
}
