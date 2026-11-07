import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { styleTags, Tag, tags } from "@lezer/highlight";
import type {
	BlockContext,
	InlineContext,
	MarkdownConfig,
} from "@lezer/markdown";

import { markdownFencedLanguages } from "./markdown-fenced-languages";

const tableHeader = Tag.define(tags.heading);
const tableCell = Tag.define(tags.content);
const tableRule = Tag.define(tags.separator);
const mathCommand = Tag.define(tags.keyword);
const mathOperator = Tag.define(tags.operator);
const mathNumber = Tag.define(tags.number);

function mathTokens(
	cx: BlockContext | InlineContext,
	text: string,
	offset: number,
) {
	const tokens = /\\(?:[a-zA-Z]+|.)|(?:\d*\.\d+|\d+)|[+\-*/=<>_^&{}()[\]]/g;
	return Array.from(text.matchAll(tokens), (match) => {
		const start = offset + match.index;
		const value = match[0];
		const type = value.startsWith("\\")
			? "MathCommand"
			: /^[\d.]/.test(value)
				? "MathNumber"
				: "MathOperator";
		return cx.elt(type, start, start + value.length);
	});
}

const mathFence = /^\$\$[ \t]*$/;
const sourceSyntax: MarkdownConfig = {
	defineNodes: [
		{ name: "BlockMath", block: true, style: tags.special(tags.literal) },
		{ name: "InlineMath", style: tags.special(tags.literal) },
		{ name: "MathMark", style: tags.processingInstruction },
		{ name: "MathCommand", style: mathCommand },
		{ name: "MathOperator", style: mathOperator },
		{ name: "MathNumber", style: mathNumber },
	],
	props: [
		styleTags({
			"TableHeader/TableCell": tableHeader,
			"TableRow/TableCell": tableCell,
			TableDelimiter: tableRule,
		}),
	],
	parseBlock: [
		{
			name: "BlockMath",
			before: "FencedCode",
			parse(cx, line) {
				if (
					cx.depth !== 1 ||
					line.indent >= 4 ||
					!mathFence.test(line.text.slice(line.pos))
				)
					return false;
				const from = cx.lineStart + line.pos;
				const marks = [cx.elt("MathMark", from, from + 2)];
				while (cx.nextLine()) {
					if (!mathFence.test(line.text.slice(line.pos))) {
						for (const token of mathTokens(cx, line.text, cx.lineStart))
							marks.push(token);
						continue;
					}
					const close = cx.lineStart + line.pos;
					marks.push(cx.elt("MathMark", close, close + 2));
					cx.nextLine();
					break;
				}
				cx.addElement(cx.elt("BlockMath", from, cx.prevLineEnd(), marks));
				return true;
			},
		},
	],
	parseInline: [
		{
			name: "InlineMath",
			parse(cx, next, pos) {
				if (next !== 36 || cx.char(pos - 1) === 36 || cx.char(pos + 1) === 36)
					return -1;
				// As in remark-math, only a matching run of unescaped dollars closes.
				for (let end = pos + 1; end < cx.end; end += 1) {
					const ch = cx.char(end);
					if (ch === 10) break;
					if (ch === 92) {
						end += 1;
						continue;
					}
					if (ch !== 36) continue;
					if (cx.char(end + 1) === 36) {
						while (cx.char(end + 1) === 36) end += 1;
						continue;
					}
					if (end === pos + 1 || /\d/.test(cx.slice(end + 1, end + 2)))
						return -1;
					return cx.addElement(
						cx.elt("InlineMath", pos, end + 1, [
							cx.elt("MathMark", pos, pos + 1),
							...mathTokens(cx, cx.slice(pos + 1, end), pos + 1),
							cx.elt("MathMark", end, end + 1),
						]),
					);
				}
				return -1;
			},
		},
	],
};

export const markdownSourceLanguage = markdown({
	base: markdownLanguage,
	codeLanguages: markdownFencedLanguages,
	extensions: sourceSyntax,
	addKeymap: false,
	completeHTMLTags: false,
	pasteURLAsLink: false,
});

export const markdownSourceWithFrontmatter = yamlFrontmatter({
	content: markdownSourceLanguage,
});

const muted = "var(--muted-foreground)";
const accent =
	"light-dark(oklch(from var(--primary) 0.43 0.15 h), oklch(from var(--primary) 0.82 0.13 h))";
const literal =
	"light-dark(oklch(from var(--primary) 0.45 0.13 calc(h + 55)), oklch(from var(--primary) 0.84 0.13 calc(h + 55)))";
const headings = [
	tags.heading1,
	tags.heading2,
	tags.heading3,
	tags.heading4,
	tags.heading5,
	tags.heading6,
];

export const markdownSourceHighlight = syntaxHighlighting(
	HighlightStyle.define(
		[
			{ tag: tags.heading, color: accent, fontWeight: "600" },
			...headings.map((tag, index) => ({
				tag,
				fontWeight: "600",
				color: `color-mix(in oklab, ${accent} ${100 - index * 11}%, var(--foreground))`,
			})),
			{ tag: tags.emphasis, fontStyle: "italic" },
			{ tag: tags.strong, fontWeight: "700" },
			{ tag: tags.strikethrough, textDecoration: "line-through" },
			{ tag: tags.quote, color: muted, fontStyle: "italic" },
			{
				tag: [tags.link, tags.url],
				color: accent,
				textDecoration: "underline",
			},
			{ tag: [tags.monospace, tags.special(tags.literal)], color: literal },
			{
				tag: [
					tags.processingInstruction,
					tags.punctuation,
					tags.meta,
					tags.list,
					tags.documentMeta,
				],
				color: muted,
			},
			{ tag: tags.atom, color: accent },
			{ tag: tableHeader, color: accent, fontWeight: "600" },
			{ tag: tableCell, color: "var(--foreground)" },
			{ tag: tableRule, color: muted },
			{ tag: mathCommand, color: accent, fontWeight: "600" },
			{ tag: mathOperator, color: muted },
			{
				tag: mathNumber,
				color:
					"light-dark(oklch(from var(--primary) 0.44 0.13 calc(h - 45)), oklch(from var(--primary) 0.83 0.13 calc(h - 45)))",
			},
		],
		{ scope: markdownSourceLanguage.language },
	),
);
