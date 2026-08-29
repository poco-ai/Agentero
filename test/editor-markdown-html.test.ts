import wikiLink from "@flowershow/remark-wiki-link";
import { MarkdownPlugin, remarkMdx } from "@platejs/markdown";
import { createSlateEditor, createSlatePlugin, KEYS } from "platejs";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { describe, expect, it } from "vitest";
import {
	obsidianCalloutRules,
	remarkObsidianCallout,
} from "@/lib/markdown/callout";
import {
	HTML_BLOCK_KEY,
	htmlRules,
	remarkPreserveHtml,
} from "@/lib/markdown/html";
import {
	remarkWikiLinkLiteralPaths,
	wikiLinkRules,
} from "@/lib/wiki/wikilink-model";

const TestParagraphPlugin = createSlatePlugin({
	key: KEYS.p,
	node: { isElement: true },
});
const TestImagePlugin = createSlatePlugin({
	key: KEYS.img,
	node: { isElement: true, isVoid: true },
});
const TestHtmlBlockPlugin = createSlatePlugin({
	key: HTML_BLOCK_KEY,
	node: { isElement: true, isVoid: true },
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
			remarkPreserveHtml,
		],
		rules: { ...wikiLinkRules, ...obsidianCalloutRules, ...htmlRules },
	},
});

function createEditor(markdown: string) {
	return createSlateEditor({
		plugins: [
			TestParagraphPlugin,
			TestImagePlugin,
			TestHtmlBlockPlugin,
			TestMarkdownPlugin,
		],
		value: (editor) =>
			editor.getApi(MarkdownPlugin).markdown.deserialize(markdown),
	});
}

function roundTrip(markdown: string) {
	return createEditor(markdown)
		.getApi(MarkdownPlugin)
		.markdown.serialize()
		.trimEnd();
}

describe("HTML in Markdown", () => {
	it("keeps a centered div verbatim", () => {
		const source = '<div align="center">Centered</div>';
		expect(createEditor(source).children).toEqual([
			{ type: HTML_BLOCK_KEY, html: source, children: [{ text: "" }] },
		]);
		expect(roundTrip(source)).toBe(source);
	});

	it("keeps center and p align verbatim", () => {
		expect(roundTrip("<center>Middle</center>")).toBe(
			"<center>Middle</center>",
		);
		expect(roundTrip('<p align="center">Middle</p>')).toBe(
			'<p align="center">Middle</p>',
		);
	});

	it("keeps an iframe verbatim", () => {
		const source =
			'<iframe src="https://example.com" width="560" height="315"></iframe>';
		expect(roundTrip(source)).toBe(source);
	});

	it("keeps multi-line html and nested markup verbatim", () => {
		const source = [
			'<div align="center">',
			'  <img src="assets/logo.png" width="200" />',
			"  <b>Title</b>",
			"</div>",
		].join("\n");
		expect(roundTrip(source)).toBe(source);
	});

	it("preserves class attributes instead of leaking the JSX spelling", () => {
		const source = '<div class="hero" align="center">Hi</div>';
		expect(roundTrip(source)).toBe(source);
	});

	it("unwraps a bare p into a real paragraph", () => {
		expect(createEditor("<p>Plain</p>").children).toEqual([
			{ type: KEYS.p, children: [{ text: "Plain" }] },
		]);
		expect(roundTrip("<p>Plain</p>")).toBe("Plain");
	});

	it("treats br as a hard line break", () => {
		const [paragraph] = createEditor("line1<br>line2").children;
		expect(paragraph.children.map((leaf) => leaf.text).join("")).toBe(
			"line1\nline2",
		);
		expect(roundTrip("line1<br>line2")).toBe("line1\\\nline2");
	});

	it("leaves fenced html samples untouched", () => {
		const source =
			'```html\n<label class="field" for="email">Email</label>\n```';
		expect(roundTrip(source)).toBe(source);
	});
});
