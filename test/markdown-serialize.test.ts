import { BaseBoldPlugin } from "@platejs/basic-nodes";
import { BaseLinkPlugin } from "@platejs/link";
import { MarkdownPlugin } from "@platejs/markdown";
import { BaseTablePlugin } from "@platejs/table";
import { createSlateEditor, createSlatePlugin, KEYS } from "platejs";
import { describe, expect, it } from "vitest";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { WikiLinkPlugin } from "@/components/editor/plugins/wikilink-plugin";
import { serializeBlocksAsMarkdown } from "@/lib/markdown/block-selection";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";
import { serializeSelectionAsMarkdown } from "@/lib/markdown/selection-markdown";
import { stripInlinePlaceholders } from "@/lib/markdown/serialize";

const ZWSP = "\u200B";
const InlineEquation = createSlatePlugin({
	key: KEYS.inlineEquation,
	node: { isElement: true, isInline: true, isVoid: true },
});

describe("stripInlinePlaceholders", () => {
	it("cleans multiple inline placeholders without changing CRLF or empty paragraph lines", () => {
		const source = `${ZWSP}$x$ text ${ZWSP}[[note]]${ZWSP}\r\n \t${ZWSP}\r\n\r\n${ZWSP}![[embed]]${ZWSP}`;
		const cleaned = stripInlinePlaceholders(source);
		expect(cleaned).toBe(`$x$ text [[note]]\r\n \t${ZWSP}\r\n\r\n![[embed]]`);
		expect(stripInlinePlaceholders(cleaned)).toBe(cleaned);
	});

	it("preserves backtick and tilde fenced code, including inside a callout", () => {
		const fences = `\`\`\`\`txt\r\na${ZWSP}b\r\n\`\`\`\r\nc${ZWSP}d\r\n\`\`\`\`\r\n\r\n> [!note]\r\n>\r\n> ~~~\r\n> e${ZWSP}f\r\n> ~~~\r\n>\r\n> ${ZWSP}\r\n`;
		expect(
			stripInlinePlaceholders(
				`before${ZWSP}\r\n\r\n${fences}> ${ZWSP}after\r\n`,
			),
		).toBe(`before\r\n\r\n${fences}> after\r\n`);
	});
});

it("round trips formulas, table cells, wiki links and consecutive empty paragraphs through Plate", () => {
	const source = `$x$ starts here\n\n| Result |\n| --- |\n| $y$ |\n\nSee [[note]]\n\n${ZWSP}\n\n${ZWSP}\n\n![[embed]]\n`;
	const plugins = [
		InlineEquation,
		BaseTablePlugin,
		WikiLinkPlugin,
		...MarkdownKit,
	];
	const parser = createSlateEditor({ plugins });
	const value = deserializeMarkdownBody(parser, source);
	const editor = createSlateEditor({
		plugins,
		value,
		shouldNormalizeEditor: true,
	});
	const raw = editor.getApi(MarkdownPlugin).markdown.serialize();
	expect(raw).toContain(`${ZWSP}$x$`);
	expect(raw).toContain(`${ZWSP}$y$${ZWSP}`);
	expect(raw).toContain(`[[note]]${ZWSP}`);
	const cleaned = stripInlinePlaceholders(raw);
	expect(cleaned.split("\n").filter((line) => line.includes(ZWSP))).toEqual([
		ZWSP,
		ZWSP,
	]);
	expect(deserializeMarkdownBody(parser, cleaned)).toEqual(value);
});

it("keeps adjacent inline equations separate when cleaning their caret spacer", () => {
	const editor = createSlateEditor({
		plugins: [InlineEquation, ...MarkdownKit],
	});
	const value = deserializeMarkdownBody(editor, `$a$${ZWSP}$b$`);
	const raw = editor.getApi(MarkdownPlugin).markdown.serialize({ value });
	const cleaned = stripInlinePlaceholders(raw);
	expect(cleaned).toBe("$a$ $b$\n");
	expect(deserializeMarkdownBody(editor, cleaned)[0].children).toEqual([
		expect.objectContaining({ type: KEYS.inlineEquation, texExpression: "a" }),
		{ text: " " },
		expect.objectContaining({ type: KEYS.inlineEquation, texExpression: "b" }),
	]);
});

it("keeps a paragraph empty after deleting its last bold character", () => {
	const editor = createSlateEditor({
		plugins: [BaseBoldPlugin, ...MarkdownKit],
		value: [
			{ type: "p", children: [{ text: "A", bold: true }] },
			{ type: "p", children: [{ text: "B" }] },
		],
	});
	editor.tf.delete({ at: editor.api.range([0]) });
	expect(editor.children[0].children).toEqual([{ text: "", bold: true }]);
	const cleaned = serializeBlocksAsMarkdown(editor, editor.children);
	expect(cleaned).toBe(`${ZWSP}\n\nB\n`);
	expect(deserializeMarkdownBody(editor, cleaned)[0]).toEqual({
		type: "p",
		children: [{ text: "" }],
	});
});

it("cleans empty bold spans around an inline node without transferring the mark", () => {
	const source = "[link](https://example.com)\n";
	const editor = createSlateEditor({
		plugins: [BaseBoldPlugin, BaseLinkPlugin, ...MarkdownKit],
	});
	const value = deserializeMarkdownBody(
		editor,
		`**${ZWSP}**${source.trimEnd()}**${ZWSP}**`,
	);
	expect(serializeBlocksAsMarkdown(editor, value)).toBe(source);
});

it("copies a link as clean Markdown from both a block and a text selection", () => {
	const source = "[link](https://example.com)\n";
	const plugins = [BaseLinkPlugin, ...MarkdownKit];
	const parser = createSlateEditor({ plugins });
	const editor = createSlateEditor({
		plugins,
		value: deserializeMarkdownBody(parser, source),
		shouldNormalizeEditor: true,
	});
	const raw = editor.getApi(MarkdownPlugin).markdown.serialize();
	expect(raw).toBe(`${ZWSP}[link](https://example.com)${ZWSP}\n`);
	expect(serializeBlocksAsMarkdown(editor, editor.children)).toBe(source);
	expect(serializeSelectionAsMarkdown(editor, editor.api.range([0]))).toBe(
		source,
	);
});
