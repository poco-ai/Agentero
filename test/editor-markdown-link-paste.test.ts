import { MarkdownPlugin } from "@platejs/markdown";
import { createSlateEditor, KEYS } from "platejs";
import { ParagraphPlugin } from "platejs/react";
import { describe, expect, it } from "vitest";
import { LinkPlugin } from "@/components/editor/plugins/link-plugin";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { prepareMarkdownForDeserialize } from "@/lib/markdown/deserialize";
import {
	convertMarkdownLinkBeforeClosingParen,
	isUnfinishedMarkdownLinkContext,
} from "@/lib/markdown/link-input-rule";

const plugins = [ParagraphPlugin, LinkPlugin, ...MarkdownKit];

function makeEditor(text = "") {
	const editor = createSlateEditor({
		plugins,
		value: [{ type: "p", children: [{ text }] }],
	});
	editor.tf.select({
		anchor: { path: [0, 0], offset: text.length },
		focus: { path: [0, 0], offset: text.length },
	});
	return editor;
}

function findOuterLinks(editor: { children: unknown }) {
	const children =
		(
			editor.children as Array<{
				children: Array<Record<string, unknown>>;
			}>
		)[0]?.children ?? [];
	return children.filter((c) => c.type === KEYS.a);
}

describe("paste URL into unfinished markdown link", () => {
	it("detects unfinished [label]( context", () => {
		const editor = makeEditor("[xx](");
		expect(isUnfinishedMarkdownLinkContext(editor)).toBe(true);
		const plain = makeEditor("hello ");
		expect(isUnfinishedMarkdownLinkContext(plain)).toBe(false);
	});

	it("inserts bare URL as plain text when unfinished, then ) converts", () => {
		const editor = makeEditor();
		for (const c of "[xx](") editor.tf.insertText(c);

		// Simulate MarkdownPastePlugin plain-text path for unfinished context.
		expect(isUnfinishedMarkdownLinkContext(editor)).toBe(true);
		editor.tf.insertText("https://github.com/poco-ai/Agentero/issues");
		expect(JSON.stringify(editor.children)).not.toContain('"type":"a"');

		editor.tf.insertText(")");
		const links = findOuterLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			type: KEYS.a,
			url: "https://github.com/poco-ai/Agentero/issues",
			children: [{ text: "xx" }],
		});
	});

	it("converts when URL was already pasted as an autolink node", () => {
		const editor = makeEditor();
		for (const c of "[xx](") editor.tf.insertText(c);

		const fragment = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize(
				prepareMarkdownForDeserialize(
					"https://github.com/poco-ai/Agentero/issues",
				),
			);
		editor.tf.insertFragment(fragment);

		// Caret is inside the autolink (same as real paste).
		expect(editor.api.above({ match: { type: KEYS.a } })).toBeTruthy();

		// Typing ) must fold [xx]( + autolink into one labeled link.
		const converted = convertMarkdownLinkBeforeClosingParen(editor);
		expect(converted).toBe(true);

		const links = findOuterLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			url: "https://github.com/poco-ai/Agentero/issues",
			children: [{ text: "xx" }],
		});
		expect(JSON.stringify(editor.children)).not.toContain("[xx](");
	});

	it("converts via insertText ) after autolink paste (full LinkPlugin path)", () => {
		const editor = makeEditor();
		for (const c of "[issue](") editor.tf.insertText(c);

		const fragment = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize(
				prepareMarkdownForDeserialize(
					"https://github.com/poco-ai/Agentero/issues",
				),
			);
		editor.tf.insertFragment(fragment);
		editor.tf.insertText(")");

		const links = findOuterLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			url: "https://github.com/poco-ai/Agentero/issues",
			children: [{ text: "issue" }],
		});
	});
});
