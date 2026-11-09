import { parser } from "@lezer/markdown";
import { defaultRules, type MdRules } from "@platejs/markdown";
import { type Descendant, TextApi } from "platejs";

const PLACEHOLDER = "\u200B";
const FENCE_MARKER = /`{3,}|~{3,}/;
const QUOTE_PREFIX = /^(?: {0,3}>[ \t]?)+/;
const MATH_DELIMITER_GAP = /\$\u200B+(?=\$)/g;

function isEmptyText(child: Descendant): boolean {
	return TextApi.isText(child) && child.text === "";
}

function isMarkedEmptyText(child: Descendant): boolean {
	return isEmptyText(child) && Object.keys(child).length > 1;
}

const serializeParagraph = defaultRules.p?.serialize;
export const paragraphMarkdownRule: NonNullable<MdRules["p"]> = {
	...defaultRules.p,
	serialize:
		serializeParagraph &&
		((node, options) => {
			if (!node.children.some(isMarkedEmptyText)) {
				return serializeParagraph(node, options);
			}
			// A mark on an empty leaf would wrap the placeholder in Markdown
			// delimiters. Removing it could turn **ZWSP** into a thematic break.
			const children = node.children.every(isEmptyText)
				? [{ text: "" }]
				: node.children.map((child) =>
						isMarkedEmptyText(child) ? { text: "" } : child,
					);
			return serializeParagraph({ ...node, children }, options);
		}),
};

/** Clean Plate's inline caret placeholders while retaining empty paragraphs. */
export function stripInlinePlaceholders(markdown: string): string {
	if (!markdown.includes(PLACEHOLDER)) return markdown;

	const fences: { from: number; to: number }[] = [];
	if (FENCE_MARKER.test(markdown)) {
		// Fences can be nested in containers such as lists and Obsidian callouts.
		parser.parse(markdown).iterate({
			enter(node) {
				if (node.name !== "FencedCode") return;
				fences.push({ from: node.from, to: node.to });
				return false;
			},
		});
	}

	let offset = 0;
	let fenceIndex = 0;
	return markdown
		.split("\n")
		.map((line) => {
			const from = offset;
			offset += line.length + 1;
			if (!line.includes(PLACEHOLDER)) return line;
			let fence = fences[fenceIndex];
			while (fence && fence.to <= from) fence = fences[++fenceIndex];
			if (fence && fence.from < offset) return line;
			if (line.replace(QUOTE_PREFIX, "").trim() === PLACEHOLDER) return line;
			// Adjacent inline formulas need a separator: $a$$b$ parses as one.
			return line.replace(MATH_DELIMITER_GAP, "$ ").replaceAll(PLACEHOLDER, "");
		})
		.join("\n");
}
