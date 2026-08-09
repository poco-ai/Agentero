import { createSlateEditor, createSlatePlugin, KEYS, NodeApi } from "platejs";
import { describe, expect, it } from "vitest";

import { LinkPlugin } from "@/components/editor/plugins/link-plugin";
import {
	convertCompleteMarkdownLinkAtCaret,
	convertMarkdownLinkBeforeClosingParen,
	markdownLinkInputRule,
} from "@/lib/markdown/link-input-rule";

const TestParagraphPlugin = createSlatePlugin({
	key: KEYS.p,
	node: { isElement: true },
});

const TestLinkPlugin = createSlatePlugin({
	key: KEYS.a,
	node: {
		isElement: true,
		isInline: true,
	},
})
	.configure({
		inputRules: [markdownLinkInputRule],
	})
	.overrideEditor(
		({ editor, tf: { normalizeNode, deleteBackward, insertText } }) => ({
			transforms: {
				insertText(text, options) {
					if (
						(text === ")" || text === "）") &&
						!options?.at &&
						convertMarkdownLinkBeforeClosingParen(editor)
					) {
						return;
					}
					insertText(text, options);
					if (!options?.at) {
						convertCompleteMarkdownLinkAtCaret(editor);
					}
				},
				normalizeNode(entry) {
					const [node, path] = entry;
					if (
						node &&
						typeof node === "object" &&
						"type" in node &&
						node.type === editor.getType(KEYS.a) &&
						NodeApi.string(node) === ""
					) {
						editor.tf.removeNodes({ at: path });
						return;
					}
					normalizeNode(entry);
				},
				deleteBackward(unit) {
					deleteBackward(unit);
					const link = editor.api.above({
						match: { type: editor.getType(KEYS.a) },
					});
					if (link && NodeApi.string(link[0]) === "") {
						editor.tf.removeNodes({ at: link[1] });
					}
				},
			},
		}),
	);

const TestCodeBlockPlugin = createSlatePlugin({
	key: KEYS.codeBlock,
	node: { isElement: true },
});

const TestCodeLinePlugin = createSlatePlugin({
	key: KEYS.codeLine,
	node: { isElement: true },
});

function findLink(editor: { children: unknown }) {
	const children =
		(
			editor.children as Array<{
				children: Array<Record<string, unknown>>;
			}>
		)[0]?.children ?? [];
	return children.find((c) => c.type === KEYS.a);
}

function createLinkEditor(text: string) {
	const editor = createSlateEditor({
		plugins: [TestParagraphPlugin, TestLinkPlugin],
		value: [{ type: "p", children: [{ text }] }],
	});
	editor.tf.select({
		anchor: { path: [0, 0], offset: text.length },
		focus: { path: [0, 0], offset: text.length },
	});
	return editor;
}

function typeLink(text: string) {
	const editor = createLinkEditor("");
	for (const character of text) editor.tf.insertText(character);
	return editor;
}

describe("Markdown link input rule", () => {
	it("converts [label](url) when typing the closing parenthesis", () => {
		const editor = createLinkEditor("[docs](https://example.com");

		editor.tf.insertText(")");

		expect(findLink(editor)).toMatchObject({
			type: KEYS.a,
			url: "https://example.com",
			children: [{ text: "docs" }],
		});
		expect(JSON.stringify(editor.children)).not.toContain(
			"[docs](https://example.com)",
		);
	});

	it("converts long GitHub issue URLs character by character", () => {
		const editor = typeLink(
			"[issue](https://github.com/poco-ai/Agentero/issues)",
		);

		expect(findLink(editor)).toMatchObject({
			type: KEYS.a,
			url: "https://github.com/poco-ai/Agentero/issues",
			children: [{ text: "issue" }],
		});
	});

	it("converts fullwidth closing parenthesis", () => {
		const editor = createLinkEditor(
			"[issue](https://github.com/poco-ai/Agentero/issues",
		);
		editor.tf.insertText("）");
		expect(findLink(editor)).toMatchObject({
			url: "https://github.com/poco-ai/Agentero/issues",
			children: [{ text: "issue" }],
		});
	});

	it("converts when ) was already inserted as plain text", () => {
		// Simulates a path that inserted `)` without running the input rule.
		const editor = createLinkEditor(
			"[issue](https://github.com/poco-ai/Agentero/issues)",
		);
		// Caret already after complete link — force complete-at-caret path.
		const ok = convertCompleteMarkdownLinkAtCaret(editor);
		expect(ok).toBe(true);
		expect(findLink(editor)).toMatchObject({
			url: "https://github.com/poco-ai/Agentero/issues",
		});
	});

	it("converts a link after existing text and another link", () => {
		const editor = createSlateEditor({
			plugins: [TestParagraphPlugin, TestLinkPlugin],
			value: [
				{
					type: "p",
					children: [
						{ text: "see " },
						{
							type: KEYS.a,
							url: "https://a.com",
							children: [{ text: "a" }],
						},
						{
							text: " then [issue](https://github.com/poco-ai/Agentero/issues",
						},
					],
				},
			],
		});
		const tail = " then [issue](https://github.com/poco-ai/Agentero/issues"
			.length;
		editor.tf.select({
			anchor: { path: [0, 2], offset: tail },
			focus: { path: [0, 2], offset: tail },
		});
		editor.tf.insertText(")");

		const links = (
			editor.children[0] as { children: Array<Record<string, unknown>> }
		).children.filter((c) => c.type === KEYS.a);
		expect(links).toHaveLength(2);
		expect(links[1]).toMatchObject({
			url: "https://github.com/poco-ai/Agentero/issues",
			children: [{ text: "issue" }],
		});
	});

	it("converts while typing the full sequence character by character", () => {
		const editor = typeLink("[hello](https://example.org)");

		expect(findLink(editor)).toMatchObject({
			type: KEYS.a,
			url: "https://example.org",
			children: [{ text: "hello" }],
		});
	});

	it("leaves incomplete or bare parentheses alone", () => {
		const incomplete = createLinkEditor("[label](not-closed");
		incomplete.tf.insertText("x");
		expect(incomplete.children).toMatchObject([
			{ type: "p", children: [{ text: "[label](not-closedx" }] },
		]);

		const bare = createLinkEditor("foo(");
		bare.tf.insertText(")");
		expect(bare.children).toMatchObject([
			{ type: "p", children: [{ text: "foo()" }] },
		]);
	});

	it("removes an emptied link without leaving a shell node", () => {
		const editor = typeLink("[a](https://ex.com)");
		const linkPath = [0, 1];
		editor.tf.select({
			anchor: { path: [...linkPath, 0], offset: 0 },
			focus: { path: [...linkPath, 0], offset: 1 },
		});
		editor.tf.deleteFragment();
		editor.tf.normalize({ force: true });

		const flat = JSON.stringify(editor.children);
		expect(flat).not.toContain(`"type":"${KEYS.a}"`);
	});

	it("does not convert inside a code block", () => {
		const editor = createSlateEditor({
			plugins: [
				TestParagraphPlugin,
				TestLinkPlugin,
				TestCodeBlockPlugin,
				TestCodeLinePlugin,
			],
			value: [
				{
					type: KEYS.codeBlock,
					children: [
						{
							type: KEYS.codeLine,
							children: [{ text: "[a](https://example.com" }],
						},
					],
				},
			],
		});
		editor.tf.select({
			anchor: { path: [0, 0, 0], offset: "[a](https://example.com".length },
			focus: { path: [0, 0, 0], offset: "[a](https://example.com".length },
		});

		editor.tf.insertText(")");

		expect(editor.children).toMatchObject([
			{
				type: KEYS.codeBlock,
				children: [
					{
						type: KEYS.codeLine,
						children: [{ text: "[a](https://example.com)" }],
					},
				],
			},
		]);
	});

	it("ships LinkPlugin with insertText override converting long URLs", () => {
		const editor = createSlateEditor({
			plugins: [TestParagraphPlugin, LinkPlugin],
			value: [{ type: "p", children: [{ text: "" }] }],
		});
		editor.tf.select({
			anchor: { path: [0, 0], offset: 0 },
			focus: { path: [0, 0], offset: 0 },
		});
		expect(editor.getType(KEYS.a)).toBe(KEYS.a);

		for (const c of "[issue](https://github.com/poco-ai/Agentero/issues)") {
			editor.tf.insertText(c);
		}
		const flat = JSON.stringify(editor.children);
		expect(flat).toContain("github.com/poco-ai/Agentero/issues");
		expect(flat).toContain(`"type":"${KEYS.a}"`);
	});
});
