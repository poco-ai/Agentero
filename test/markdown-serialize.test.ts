import { BaseBoldPlugin } from "@platejs/basic-nodes";
import { CodeBlockPlugin, CodeLinePlugin } from "@platejs/code-block/react";
import { BaseLinkPlugin } from "@platejs/link";
import { MarkdownPlugin } from "@platejs/markdown";
import { BlockSelectionPlugin } from "@platejs/selection/react";
import { BaseTablePlugin } from "@platejs/table";
import {
	createSlateEditor,
	createSlatePlugin,
	KEYS,
	type SlateEditor,
	type TElement,
	type TRange,
} from "platejs";
import { describe, expect, it } from "vitest";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { WikiLinkPlugin } from "@/components/editor/plugins/wikilink-plugin";
import {
	blockChatSelectionInput,
	isBlankParagraph,
	isElementBlockSelected,
	resolveHandleBlocks,
	selectCurrentBlockThenAll,
	selectElementAsBlocks,
	selectedBlockIds,
	serializeBlocksAsMarkdown,
} from "@/lib/markdown/block-selection";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";
import {
	mathClipboardPayload,
	mathNodeMarkdown,
	serializeSelectionAsMarkdown,
} from "@/lib/markdown/selection-markdown";
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

const inlineMath = {
	type: KEYS.inlineEquation,
	texExpression: "x^{2}+\\frac{a}{b}",
	children: [{ text: "" }],
};
const blockMath = {
	type: KEYS.equation,
	texExpression: "\\sum_{k=1}^{n}\\alpha_k",
	children: [{ text: "" }],
};

/** Minimal editor stub: only the query/serialize surface the helpers touch. */
function stubEditor({
	nodes = [] as unknown[],
	above = undefined as [unknown, number[]] | undefined,
	serialized = "SERIALIZED",
	selection = null as TRange | null,
} = {}): SlateEditor {
	return {
		selection,
		api: {
			nodes: () => nodes.map((node, index) => [node, [index]]),
			above: () => above,
			fragment: () => nodes,
		},
		getApi: () => ({ markdown: { serialize: () => serialized } }),
	} as unknown as SlateEditor;
}

function expandedSelection(): TRange {
	return {
		anchor: { path: [0, 0], offset: 0 },
		focus: { path: [0, 2], offset: 1 },
	};
}

describe("mathNodeMarkdown", () => {
	it("wraps inline equations in single dollars", () => {
		expect(mathNodeMarkdown(inlineMath)).toBe("$x^{2}+\\frac{a}{b}$");
	});

	it("wraps display equations in fences", () => {
		expect(mathNodeMarkdown(blockMath)).toBe(
			"$$\n\\sum_{k=1}^{n}\\alpha_k\n$$",
		);
	});

	it("trims the TeX source and ignores non-math / empty nodes", () => {
		expect(
			mathNodeMarkdown({ type: KEYS.inlineEquation, texExpression: "  x  " }),
		).toBe("$x$");
		expect(
			mathNodeMarkdown({ type: KEYS.inlineEquation, texExpression: "   " }),
		).toBe(null);
		expect(mathNodeMarkdown({ type: KEYS.p, children: [] })).toBe(null);
		expect(mathNodeMarkdown(undefined)).toBe(null);
	});
});

describe("serializeSelectionAsMarkdown", () => {
	it("serializes the fragment of an expanded selection", () => {
		const editor = stubEditor({
			nodes: [inlineMath],
			serialized: "SERIALIZED",
		});
		expect(serializeSelectionAsMarkdown(editor, expandedSelection())).toBe(
			"SERIALIZED",
		);
	});

	it("is empty for a collapsed selection or empty fragment", () => {
		const collapsed: TRange = {
			anchor: { path: [0, 0], offset: 1 },
			focus: { path: [0, 0], offset: 1 },
		};
		expect(serializeSelectionAsMarkdown(stubEditor(), collapsed)).toBe("");
		expect(serializeSelectionAsMarkdown(stubEditor(), null)).toBe("");
	});
});

describe("mathClipboardPayload", () => {
	it("copies an expanded selection that contains math as Markdown", () => {
		const editor = stubEditor({ nodes: [inlineMath], serialized: "text $x$" });
		expect(mathClipboardPayload(editor, expandedSelection())).toEqual({
			markdown: "text $x$",
		});
	});

	it("keeps the default plain-text copy when the selection has no math", () => {
		const editor = stubEditor({ nodes: [{ text: "plain" }] });
		expect(mathClipboardPayload(editor, expandedSelection())).toBe(null);
	});

	it("copies the whole equation when the caret sits inside it", () => {
		const editor = stubEditor({ above: [inlineMath, [0, 1]] });
		expect(
			mathClipboardPayload(editor, {
				anchor: { path: [0, 1, 0], offset: 0 },
				focus: { path: [0, 1, 0], offset: 0 },
			}),
		).toEqual({ markdown: "$x^{2}+\\frac{a}{b}$", path: [0, 1] });
	});
});

const TestParagraphPlugin = createSlatePlugin({
	key: KEYS.p,
	node: { isElement: true },
});

describe("Markdown block selection serialize", () => {
	it("serializes selected nodes as Markdown without Plate ids", () => {
		const editor = createSlateEditor({
			plugins: MarkdownKit,
			value: [
				{
					id: "block-a",
					type: "p",
					children: [{ text: "First" }],
				},
				{
					id: "block-b",
					type: "h2",
					children: [{ text: "Heading" }],
				},
			],
		});

		const markdown = serializeBlocksAsMarkdown(editor, [
			editor.children[0],
			editor.children[1],
		]);
		expect(markdown).toContain("First");
		expect(markdown).toContain("## Heading");
		expect(markdown).not.toContain("block-a");
		expect(markdown).not.toContain("id=");
	});

	it("selects a top-level block by id", () => {
		const editor = createSlateEditor({
			plugins: [...MarkdownKit, BlockSelectionPlugin],
			value: [
				{
					id: "block-a",
					type: "p",
					children: [{ text: "Hello" }],
				},
			],
		});
		const nodes = selectElementAsBlocks(editor, editor.children[0] as TElement);
		expect(nodes).toHaveLength(1);
		expect(nodes[0]).toMatchObject({ id: "block-a" });
		expect(
			editor.getOption(BlockSelectionPlugin, "selectedIds")?.has("block-a"),
		).toBe(true);
	});

	it("keeps a multi-block selection when the handle belongs to it", () => {
		const editor = createSlateEditor({
			plugins: [...MarkdownKit, BlockSelectionPlugin],
			value: [
				{ id: "a", type: "p", children: [{ text: "A" }] },
				{ id: "b", type: "p", children: [{ text: "B" }] },
			],
		});
		editor.getApi(BlockSelectionPlugin).blockSelection.set(["a", "b"]);
		expect(isElementBlockSelected(editor, editor.children[1] as TElement)).toBe(
			true,
		);
		const nodes = resolveHandleBlocks(editor, editor.children[1] as TElement);
		expect(nodes.map((node) => node.id)).toEqual(["a", "b"]);
		expect(
			editor.getOption(BlockSelectionPlugin, "selectedIds")?.has("a"),
		).toBe(true);
		expect(
			editor.getOption(BlockSelectionPlugin, "selectedIds")?.has("b"),
		).toBe(true);
	});

	it("builds an add-to-chat payload for a serialized block", () => {
		expect(
			blockChatSelectionInput("Hello block\n", "notes/a.md", {
				lineFrom: 4,
				lineTo: 6,
			}),
		).toEqual({
			text: "Hello block",
			sourcePath: "notes/a.md",
			origin: "markdown",
			lineFrom: 4,
			lineTo: 6,
		});
		expect(blockChatSelectionInput("   ", "notes/a.md", null)).toBeNull();
		expect(blockChatSelectionInput("Hello", "  ", null)).toBeNull();
		expect(blockChatSelectionInput("Hello", "notes/a.md", null)).toEqual({
			text: "Hello",
			sourcePath: "notes/a.md",
			origin: "markdown",
		});
	});

	it("treats empty and whitespace paragraphs as blank lines, not content blocks", () => {
		expect(isBlankParagraph({ type: "p", children: [{ text: "" }] })).toBe(
			true,
		);
		expect(
			isBlankParagraph({ type: "p", children: [{ text: "  \n\t" }] }),
		).toBe(true);
		expect(
			isBlankParagraph({ type: "p", children: [{ text: "\uFEFF" }] }),
		).toBe(true);
		expect(isBlankParagraph({ type: "p", children: [{ text: "Hello" }] })).toBe(
			false,
		);
		expect(isBlankParagraph({ type: "h2", children: [{ text: "" }] })).toBe(
			false,
		);
		expect(
			isBlankParagraph({
				type: "p",
				children: [
					{
						type: "a",
						url: "https://example.com",
						children: [{ text: "" }],
					},
				],
			}),
		).toBe(false);
	});

	it("selects a Mermaid code block before the rest of the note", () => {
		const editor = createSlateEditor({
			plugins: [
				TestParagraphPlugin,
				CodeBlockPlugin,
				CodeLinePlugin,
				BlockSelectionPlugin,
			],
			value: [
				{
					id: "code",
					type: KEYS.codeBlock,
					lang: "mermaid",
					children: [
						{ type: KEYS.codeLine, children: [{ text: "graph TD" }] },
						{ type: KEYS.codeLine, children: [{ text: "A-->B" }] },
					],
				},
				{ id: "after", type: KEYS.p, children: [{ text: "After" }] },
			],
		});
		editor.tf.select({
			anchor: { path: [0, 1, 0], offset: 1 },
			focus: { path: [0, 1, 0], offset: 1 },
		});

		expect(selectCurrentBlockThenAll(editor)).toBe(true);
		const first = editor.api.string(editor.selection ?? []);
		expect(first).toContain("graph TD");
		expect(first).toContain("A-->B");
		expect(first).not.toContain("After");
		expect(selectedBlockIds(editor).size).toBe(0);

		expect(selectCurrentBlockThenAll(editor)).toBe(true);
		expect(selectedBlockIds(editor).has("code")).toBe(true);
		expect(selectedBlockIds(editor).has("after")).toBe(true);
	});

	it("selects an empty paragraph before the rest of the note", () => {
		const editor = createSlateEditor({
			plugins: [TestParagraphPlugin, BlockSelectionPlugin],
			value: [
				{ id: "a", type: KEYS.p, children: [{ text: "Alpha" }] },
				{ id: "empty", type: KEYS.p, children: [{ text: "" }] },
				{ id: "b", type: KEYS.p, children: [{ text: "Beta" }] },
			],
		});
		editor.tf.select({
			anchor: { path: [1, 0], offset: 0 },
			focus: { path: [1, 0], offset: 0 },
		});

		expect(selectCurrentBlockThenAll(editor)).toBe(true);
		expect([...selectedBlockIds(editor)]).toEqual(["empty"]);

		expect(selectCurrentBlockThenAll(editor)).toBe(true);
		expect(selectedBlockIds(editor).has("a")).toBe(true);
		expect(selectedBlockIds(editor).has("empty")).toBe(true);
		expect(selectedBlockIds(editor).has("b")).toBe(true);
	});

	it("selects the current paragraph before every block", () => {
		const editor = createSlateEditor({
			plugins: [TestParagraphPlugin, BlockSelectionPlugin],
			value: [
				{ id: "a", type: KEYS.p, children: [{ text: "Alpha" }] },
				{ id: "b", type: KEYS.p, children: [{ text: "Beta" }] },
			],
		});
		editor.tf.select({
			anchor: { path: [0, 0], offset: 1 },
			focus: { path: [0, 0], offset: 1 },
		});

		expect(selectCurrentBlockThenAll(editor)).toBe(true);
		expect(editor.api.string(editor.selection ?? [])).toBe("Alpha");
		expect(selectedBlockIds(editor).size).toBe(0);
	});

	it("round-trips a document without writing block ids", () => {
		const editor = createSlateEditor({
			plugins: MarkdownKit,
			value: [
				{
					id: "keep-off-disk",
					type: "p",
					children: [{ text: "Hello" }],
				},
			],
		});
		const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();
		expect(markdown.trim()).toBe("Hello");
	});
});
