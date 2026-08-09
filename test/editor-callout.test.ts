import wikiLink from "@flowershow/remark-wiki-link";
import { BlockquoteRules } from "@platejs/basic-nodes";
import { BlockquotePlugin } from "@platejs/basic-nodes/react";
import { CodeBlockPlugin, CodeLinePlugin } from "@platejs/code-block/react";
import { BaseListPlugin } from "@platejs/list";
import { ListPlugin } from "@platejs/list/react";
import { MarkdownPlugin, remarkMdx } from "@platejs/markdown";
import {
	createSlateEditor,
	createSlatePlugin,
	KEYS,
	type TElement,
} from "platejs";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { describe, expect, it } from "vitest";
import {
	CalloutPlugin,
	convertBlockquoteMarkerToCallout,
} from "@/components/editor/plugins/callout-plugin";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { WikiLinkPlugin } from "@/components/editor/plugins/wikilink-plugin";
import {
	obsidianCalloutRules,
	parseCalloutMarker,
	remarkObsidianCallout,
	updateCalloutMetadata,
} from "@/lib/markdown/callout";
import {
	remarkWikiLinkLiteralPaths,
	wikiLinkRules,
} from "@/lib/wiki/wikilink-model";

const TestParagraphPlugin = createSlatePlugin({
	key: KEYS.p,
	node: { isElement: true },
});
const TestBlockquotePlugin = createSlatePlugin({
	key: KEYS.blockquote,
	node: { isElement: true },
});
const TestCalloutPlugin = createSlatePlugin({
	key: KEYS.callout,
	node: { isElement: true },
});
const TestInlineEquationPlugin = createSlatePlugin({
	key: KEYS.inlineEquation,
	node: { isElement: true, isInline: true, isVoid: true },
});
const TestMarkdownPlugin = MarkdownPlugin.configure({
	options: {
		remarkPlugins: [
			remarkMath,
			remarkGfm,
			[wikiLink, { aliasDivider: "|" }],
			remarkWikiLinkLiteralPaths,
			remarkMdx,
			remarkObsidianCallout,
		],
		rules: { ...wikiLinkRules, ...obsidianCalloutRules },
	},
});

function createCalloutEditor(markdown: string) {
	return createSlateEditor({
		plugins: [
			TestParagraphPlugin,
			TestBlockquotePlugin,
			TestCalloutPlugin,
			TestInlineEquationPlugin,
			BaseListPlugin,
			WikiLinkPlugin,
			TestMarkdownPlugin,
		],
		value: (editor) =>
			editor.getApi(MarkdownPlugin).markdown.deserialize(markdown),
	});
}

describe("Obsidian callout Markdown model", () => {
	it("parses known and custom markers without accepting fold syntax", () => {
		expect(parseCalloutMarker("[!important] Custom title")).toEqual({
			type: "important",
			typeRaw: "important",
			title: "Custom title",
		});
		expect(parseCalloutMarker("[!My-Type]")).toEqual({
			type: "my-type",
			typeRaw: "My-Type",
		});
		expect(parseCalloutMarker("[!important]- Folded")).toBeNull();
		expect(parseCalloutMarker("important")).toBeNull();
	});

	it("round-trips a titled multi-paragraph callout", () => {
		const editor = createCalloutEditor(
			"> [!important] Read this\n>\n> First paragraph.\n>\n> Second paragraph.",
		);

		expect(editor.children).toMatchObject([
			{
				type: "callout",
				calloutType: "important",
				calloutTypeRaw: "important",
				title: "Read this",
				children: [
					{ type: "p", children: [{ text: "First paragraph." }] },
					{ type: "p", children: [{ text: "Second paragraph." }] },
				],
			},
		]);
		expect(editor.getApi(MarkdownPlugin).markdown.serialize()).toBe(
			"> [!important] Read this\n>\n> First paragraph.\n>\n> Second paragraph.\n",
		);
	});

	it("keeps ordinary and unsupported folded blockquotes unchanged", () => {
		const editor = createCalloutEditor(
			"> Ordinary quote\n\n> [!important]- Folded title",
		);

		expect(editor.children).toMatchObject([
			{ type: "blockquote" },
			{ type: "blockquote" },
		]);
	});

	it("supports a body on the line immediately after the marker", () => {
		const editor = createCalloutEditor(
			"> [!warning]\n> Body without a blank quote line.",
		);

		expect(editor.children).toMatchObject([
			{
				type: "callout",
				calloutType: "warning",
				children: [
					{
						type: "p",
						children: [{ text: "Body without a blank quote line." }],
					},
				],
			},
		]);
	});

	it("supports a hard break between the marker title and body", () => {
		const editor = createCalloutEditor(
			"> [!important] Summary\\\n> Body with $a$.",
		);

		expect(editor.children).toMatchObject([
			{
				type: "callout",
				calloutType: "important",
				title: "Summary",
				children: [
					{
						type: "p",
						children: [
							{ text: "Body with " },
							{ type: "inline_equation", texExpression: "a" },
							{ text: "." },
						],
					},
				],
			},
		]);
	});

	it("keeps an escaped callout marker as literal blockquote text", () => {
		const editor = createCalloutEditor(
			"> \\[!important] Literal marker\\\n> Body",
		);

		expect(editor.children).toMatchObject([{ type: "blockquote" }]);
	});

	it("retains lists, math, and wikilinks inside the callout body", () => {
		const editor = createCalloutEditor(
			"> [!important] Mixed body\n>\n> See [[Other]] and $a$.\n>\n> - one\n> - two",
		);

		expect(editor.children).toMatchObject([
			{
				type: "callout",
				children: [
					{
						type: "p",
						children: [
							{ text: "See " },
							{ type: "wikiLink", value: "Other" },
							{ text: " and " },
							{ type: "inline_equation", texExpression: "a" },
							{ text: "." },
						],
					},
					{ type: "p", listStyleType: "disc", children: [{ text: "one" }] },
					{ type: "p", listStyleType: "disc", children: [{ text: "two" }] },
				],
			},
		]);
		const serialized = editor.getApi(MarkdownPlugin).markdown.serialize();
		expect(serialized).toContain("> See [[Other]] and $a$.");
		expect(serialized).toContain("> * one\n> * two");
	});

	it("uses the production Markdown kit for Obsidian callouts", () => {
		const editor = createSlateEditor({
			plugins: [
				TestParagraphPlugin,
				TestBlockquotePlugin,
				TestCalloutPlugin,
				TestInlineEquationPlugin,
				BaseListPlugin,
				WikiLinkPlugin,
				...MarkdownKit,
			],
			value: (currentEditor) =>
				currentEditor
					.getApi(MarkdownPlugin)
					.markdown.deserialize("> [!My-Type]\n> Body"),
		});

		expect(editor.children).toMatchObject([
			{
				type: "callout",
				calloutType: "my-type",
				calloutTypeRaw: "My-Type",
				children: [{ type: "p", children: [{ text: "Body" }] }],
			},
		]);
		expect(editor.getApi(MarkdownPlugin).markdown.serialize()).toBe(
			"> [!My-Type]\n>\n> Body\n",
		);
	});

	it("converts a completed live marker and selects the editable body", () => {
		const editor = createSlateEditor({
			plugins: [
				TestParagraphPlugin,
				TestBlockquotePlugin,
				TestCalloutPlugin,
				TestMarkdownPlugin,
			],
			value: [
				{
					type: "blockquote",
					children: [{ text: "[!important] Read this" }],
				},
			],
		});
		const offset = "[!important] Read this".length;
		editor.tf.select({
			anchor: { path: [0, 0], offset },
			focus: { path: [0, 0], offset },
		});

		expect(convertBlockquoteMarkerToCallout(editor)).toBe(true);
		expect(editor.children).toMatchObject([
			{
				type: "callout",
				calloutType: "important",
				calloutTypeRaw: "important",
				title: "Read this",
				children: [{ type: "p", children: [{ text: "" }] }],
			},
		]);
		expect(editor.selection).toEqual({
			anchor: { path: [0, 0, 0], offset: 0 },
			focus: { path: [0, 0, 0], offset: 0 },
		});
		expect(editor.getApi(MarkdownPlugin).markdown.serialize()).toContain(
			"> [!important] Read this",
		);
	});

	it("converts a marker typed through the production blockquote input rule", () => {
		const editor = createSlateEditor({
			plugins: [
				TestParagraphPlugin,
				BlockquotePlugin.configure({
					inputRules: [BlockquoteRules.markdown()],
				}),
				TestCalloutPlugin,
				TestMarkdownPlugin,
			],
			value: [{ type: "p", children: [{ text: "" }] }],
		});
		editor.tf.select({
			anchor: { path: [0, 0], offset: 0 },
			focus: { path: [0, 0], offset: 0 },
		});
		for (const character of "> [!important] 一句话抓住全文") {
			editor.tf.insertText(character);
		}

		expect(convertBlockquoteMarkerToCallout(editor)).toBe(true);
		expect(editor.children).toMatchObject([
			{
				type: "callout",
				calloutType: "important",
				title: "一句话抓住全文",
				children: [{ type: "p", children: [{ text: "" }] }],
			},
		]);
	});

	it("updates editable callout type and title metadata", () => {
		const editor = createCalloutEditor("> [!note] Old title\n>\n> Body");
		const element = editor.children[0] as TElement;

		expect(
			updateCalloutMetadata(editor, element, {
				typeRaw: "Important",
				title: "  New title  ",
			}),
		).toBe(true);
		expect(editor.children).toMatchObject([
			{
				type: "callout",
				calloutType: "important",
				calloutTypeRaw: "Important",
				title: "New title",
			},
		]);
		expect(editor.getApi(MarkdownPlugin).markdown.serialize()).toContain(
			"> [!Important] New title",
		);
		expect(
			updateCalloutMetadata(editor, editor.children[0] as TElement, {
				typeRaw: "bad type",
				title: "",
			}),
		).toBe(false);
		expect(editor.children).toMatchObject([
			{
				calloutTypeRaw: "Important",
				title: "New title",
			},
		]);
	});

	it("keeps Enter inside the current callout body", () => {
		const editor = createSlateEditor({
			plugins: [TestParagraphPlugin, CalloutPlugin],
			value: [
				{
					type: "callout",
					calloutType: "important",
					calloutTypeRaw: "important",
					title: "Editable",
					children: [{ type: "p", children: [{ text: "BeforeAfter" }] }],
				},
			],
		});
		editor.tf.select({
			anchor: { path: [0, 0, 0], offset: 6 },
			focus: { path: [0, 0, 0], offset: 6 },
		});

		editor.tf.insertBreak();

		expect(editor.children).toMatchObject([
			{
				type: "callout",
				calloutType: "important",
				title: "Editable",
				children: [
					{ type: "p", children: [{ text: "Before" }] },
					{ type: "p", children: [{ text: "After" }] },
				],
			},
		]);
		expect(editor.selection).toEqual({
			anchor: { path: [0, 1, 0], offset: 0 },
			focus: { path: [0, 1, 0], offset: 0 },
		});
	});

	it("preserves list Enter behavior inside a callout", () => {
		const editor = createSlateEditor({
			plugins: [TestParagraphPlugin, CalloutPlugin, ListPlugin],
			value: [
				{
					type: "callout",
					calloutType: "important",
					calloutTypeRaw: "important",
					children: [
						{
							type: "p",
							listStyleType: "disc",
							indent: 1,
							children: [{ text: "item one" }],
						},
						{
							type: "p",
							listStyleType: "disc",
							indent: 1,
							children: [{ text: "item two" }],
						},
					],
				},
			],
		});
		editor.tf.select({
			anchor: { path: [0, 0, 0], offset: 8 },
			focus: { path: [0, 0, 0], offset: 8 },
		});

		editor.tf.insertBreak();
		editor.tf.insertText("item one b");

		expect(editor.children).toMatchObject([
			{
				type: "callout",
				children: [
					{
						type: "p",
						listStyleType: "disc",
						children: [{ text: "item one" }],
					},
					{
						type: "p",
						listStyleType: "disc",
						children: [{ text: "item one b" }],
					},
					{
						type: "p",
						listStyleType: "disc",
						children: [{ text: "item two" }],
					},
				],
			},
		]);
	});

	it("selects the whole document from inside a callout", () => {
		const editor = createSlateEditor({
			plugins: [
				TestParagraphPlugin,
				CalloutPlugin,
				CodeBlockPlugin,
				CodeLinePlugin,
			],
			value: [
				{ type: "p", children: [{ text: "Before" }] },
				{
					type: "callout",
					calloutType: "important",
					calloutTypeRaw: "important",
					children: [
						{ type: "p", children: [{ text: "First" }] },
						{ type: "p", children: [{ text: "Second" }] },
					],
				},
				{ type: "p", children: [{ text: "After" }] },
			],
		});
		editor.tf.select({
			anchor: { path: [1, 0, 0], offset: 2 },
			focus: { path: [1, 0, 0], offset: 2 },
		});

		editor.tf.selectAll();

		expect(editor.selection).toEqual({
			anchor: { path: [0, 0], offset: 0 },
			focus: { path: [2, 0], offset: 5 },
		});
	});

	it("does not live-convert unsupported folded markers", () => {
		const marker = "[!important]- Folded";
		const editor = createSlateEditor({
			plugins: [
				TestParagraphPlugin,
				TestBlockquotePlugin,
				TestCalloutPlugin,
				TestMarkdownPlugin,
			],
			value: [{ type: "blockquote", children: [{ text: marker }] }],
		});
		editor.tf.select({
			anchor: { path: [0, 0], offset: marker.length },
			focus: { path: [0, 0], offset: marker.length },
		});

		expect(convertBlockquoteMarkerToCallout(editor)).toBe(false);
		expect(editor.children).toMatchObject([{ type: "blockquote" }]);
	});

	it("keeps MDX callout attributes on the existing portable path", () => {
		const editor = createCalloutEditor(
			'<callout variant="warning">\n\nMDX body\n\n</callout>',
		);

		expect(editor.children).toMatchObject([
			{
				type: "callout",
				variant: "warning",
				children: [{ type: "p", children: [{ text: "MDX body" }] }],
			},
		]);
		const serialized = editor.getApi(MarkdownPlugin).markdown.serialize();
		expect(serialized).toContain('<callout variant="warning">');
		expect(serialized).toContain("MDX body");
	});
});
