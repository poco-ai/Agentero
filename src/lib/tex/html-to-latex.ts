/**
 * Turn copied HTML into LaTeX. Plain clipboard text is kept when the HTML
 * has no block structure, so a copied command is not rewritten.
 */

const ESCAPE = /[\\{}$&#%_^~]/g;

function escapeLatex(text: string): string {
	return text.replace(ESCAPE, (character) => {
		if (character === "\\") return "\\textbackslash{}";
		if (character === "^") return "\\textasciicircum{}";
		if (character === "~") return "\\textasciitilde{}";
		return `\\${character}`;
	});
}

function href(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value, "https://example.invalid");
		if (
			url.protocol !== "http:" &&
			url.protocol !== "https:" &&
			url.protocol !== "mailto:"
		)
			return null;
		if (url.protocol === "mailto:") return url.href;
		if (value.startsWith("http://") || value.startsWith("https://"))
			return value;
		return null;
	} catch {
		return null;
	}
}

const HEADING = [
	"section",
	"subsection",
	"subsubsection",
	"paragraph",
	"subparagraph",
];

function inline(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE)
		return escapeLatex(node.textContent ?? "");
	if (node.nodeType !== Node.ELEMENT_NODE) return "";
	const element = node as Element;
	const tag = element.tagName.toLowerCase();
	const children = () => [...element.childNodes].map(inline).join("");
	if (tag === "br") return "\\\\\n";
	if (tag === "strong" || tag === "b") return `\\textbf{${children()}}`;
	if (tag === "em" || tag === "i") return `\\emph{${children()}}`;
	if (tag === "code" || tag === "kbd") return `\\texttt{${children()}}`;
	if (tag === "a") {
		const url = href(element.getAttribute("href"));
		const label = children();
		return url ? `\\href{${escapeLatex(url)}}{${label}}` : label;
	}
	if (tag === "sub") return `\\textsubscript{${children()}}`;
	if (tag === "sup") return `\\textsuperscript{${children()}}`;
	return children();
}

function cellText(cell: Element): string {
	return [...cell.childNodes].map(inline).join("").replace(/\s+/g, " ").trim();
}

function table(element: Element): string {
	const rows = [...element.querySelectorAll("tr")];
	if (!rows.length) return "";
	const width = Math.max(
		1,
		...rows.map((row) => row.querySelectorAll("th, td").length),
	);
	const body = rows
		.map((row) => {
			const cells = [...row.querySelectorAll("th, td")].map(cellText);
			while (cells.length < width) cells.push("");
			return cells.join(" & ");
		})
		.join(" \\\\\n");
	return `\\begin{tabular}{${"l".repeat(width)}}\n${body}\n\\end{tabular}`;
}

function block(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) {
		const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
		return text ? escapeLatex(text) : "";
	}
	if (node.nodeType !== Node.ELEMENT_NODE) return "";
	const element = node as Element;
	const tag = element.tagName.toLowerCase();
	if (tag === "script" || tag === "style") return "";
	const blocks = () =>
		[...element.childNodes].map(block).filter(Boolean).join("\n\n");
	const heading = /^h([1-6])$/.exec(tag);
	if (heading) {
		const name = HEADING[Math.min(Number(heading[1]) - 1, HEADING.length - 1)];
		return `\\${name}{${[...element.childNodes].map(inline).join("").trim()}}`;
	}
	if (tag === "p" || tag === "div" || tag === "blockquote") {
		const text = [...element.childNodes].map(inline).join("").trim();
		return text;
	}
	if (tag === "pre") {
		const text = (element.textContent ?? "").replace(/^\n|\n$/g, "");
		return `\\begin{verbatim}\n${text}\n\\end{verbatim}`;
	}
	if (tag === "ul" || tag === "ol") {
		const items = [...element.children]
			.filter((child) => child.tagName.toLowerCase() === "li")
			.map(
				(item) => `\\item ${[...item.childNodes].map(inline).join("").trim()}`,
			)
			.join("\n");
		const name = tag === "ul" ? "itemize" : "enumerate";
		return `\\begin{${name}}\n${items}\n\\end{${name}}`;
	}
	if (tag === "table") return table(element);
	if (tag === "br") return "\\\\";
	return blocks();
}

function hasBlock(html: string): boolean {
	return /<(?:p|h[1-6]|li|table|br|ul|ol|div|blockquote|pre)\b/i.test(html);
}

/** LaTeX for an HTML clipboard, or null when the plain text should win. */
export function latexFromClipboard(html: string, plain: string): string | null {
	if (!html.trim() || !hasBlock(html) || typeof DOMParser === "undefined")
		return null;
	const document = new DOMParser().parseFromString(html, "text/html");
	const latex = [...document.body.childNodes]
		.map(block)
		.filter(Boolean)
		.join("\n\n")
		.trim();
	if (!latex) return null;
	if (
		plain.trim() &&
		latex === escapeLatex(plain.trim()) &&
		!/\\begin\{|\\section/.test(latex)
	)
		return null;
	return latex;
}
