import { parser } from "@lezer/markdown";
import { defaultRules, type MdRules } from "@platejs/markdown";
import { type Descendant, type TEquationElement, TextApi } from "platejs";
import type { TexDelimiter } from "@/lib/markdown/math-normalize";

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

type DelimitedEquation = TEquationElement & { texDelimiter?: TexDelimiter };

/** Original TeX delimiter recorded by the note deserializer, if any. */
function texDelimiter(node: TEquationElement): TexDelimiter | undefined {
	const { texDelimiter: delimiter } = node as DelimitedEquation;
	return delimiter === "bracket" || delimiter === "paren"
		? delimiter
		: undefined;
}

function rawTexMarkdown(value: string) {
	// `\[…\]` / `\(…\)` are not Markdown nodes: hand them to the serializer as
	// verbatim HTML, which mdast-util-to-markdown copies without escaping.
	return { type: "html", value };
}

/**
 * Serialize `\[…\]` / `\(…\)` formulas with the delimiter they were written
 * with.
 *
 * Plate's Markdown serializer only knows dollar math. Notes round-trip to disk,
 * so editing a Cool Papers note used to rewrite every imported formula as
 * `$` / `$$` (and left a broken delimiter when that happened mid-edit) even
 * though the editor had parsed it correctly (#1171). The deserializer records
 * the original delimiter on the node; here it is written back. Dollar formulas
 * and newly created equations keep the default `$` / `$$` form.
 */
export const texDelimiterMarkdownRules = {
	equation: {
		serialize: (node: TEquationElement) => {
			const tex = node.texExpression ?? "";
			const delimiter = texDelimiter(node);
			if (tex.trim()) {
				if (delimiter === "bracket") {
					return rawTexMarkdown(`\\[\n${tex}\n\\]`);
				}
				if (delimiter === "paren") {
					return rawTexMarkdown(`\\(${tex}\\)`);
				}
			}
			return { type: "math", value: tex };
		},
	},
	inline_equation: {
		serialize: (node: TEquationElement) => {
			const tex = node.texExpression ?? "";
			const delimiter = texDelimiter(node);
			if (tex.trim()) {
				if (delimiter === "bracket") {
					return rawTexMarkdown(`\\[${tex}\\]`);
				}
				if (delimiter === "paren") {
					return rawTexMarkdown(`\\(${tex}\\)`);
				}
			}
			return { type: "inlineMath", value: tex };
		},
	},
} as unknown as MdRules;

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
