import { extractTableDataFromElement, tableDataToMarkdown } from "streamdown";

export function tableElementToMarkdown(table: HTMLTableElement): string {
	if (!table.querySelector(".katex")) {
		return tableDataToMarkdown(extractTableDataFromElement(table));
	}

	const copy = table.cloneNode(true) as HTMLTableElement;
	const text = copy.textContent ?? "";
	let prefix = "AGENTEROMATH";
	while (text.includes(prefix)) prefix += "X";

	// Streamdown reads textContent and escapes backslashes in every cell.
	// Substitute TeX after serialization so Markdown escapes only the prose.
	const formulas: string[] = [];
	for (const math of copy.querySelectorAll(".katex")) {
		const tex = math
			.querySelector('annotation[encoding="application/x-tex"]')
			?.textContent?.trim();
		if (!tex) continue;

		// Preserve existing TeX escapes and keep literal pipes inside the cell.
		const source = tex
			.replace(/[\r\n]+/g, " ")
			.replace(/\\.|\|/g, (part) => (part === "|" ? "\\|" : part));
		const fence = "$".repeat(
			Math.max(
				0,
				...Array.from(source.matchAll(/\$+/g), ([run]) => run.length),
			) + 1,
		);
		const padding = source.startsWith("$") || source.endsWith("$") ? " " : "";
		math.replaceWith(`${prefix}${formulas.length}END`);
		formulas.push(`${fence}${padding}${source}${padding}${fence}`);
	}

	const markdown = tableDataToMarkdown(extractTableDataFromElement(copy));
	return markdown.replace(
		new RegExp(`${prefix}(\\d+)END`, "g"),
		(match, index) => formulas[Number(index)] ?? match,
	);
}
