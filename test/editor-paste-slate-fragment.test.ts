import { HeadingRules } from "@platejs/basic-nodes";
import { H2Plugin } from "@platejs/basic-nodes/react";
import { BaseListPlugin } from "@platejs/list";
import { createSlateEditor, createSlatePlugin, KEYS } from "platejs";
import { describe, expect, it } from "vitest";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";

const TestParagraphPlugin = createSlatePlugin({
	key: KEYS.p,
	node: { isElement: true },
});

const RealH2Plugin = H2Plugin.configure({
	inputRules: [HeadingRules.markdown()],
	rules: { break: { empty: "reset" } },
});

const TestWikiLinkPlugin = createSlatePlugin({
	key: "wikiLink",
	node: { isElement: true, isInline: true },
});

function createPasteEditor(
	initialValue: unknown[] = [{ type: "p", children: [{ text: "" }] }],
) {
	const editor = createSlateEditor({
		plugins: [
			TestParagraphPlugin,
			RealH2Plugin,
			TestWikiLinkPlugin,
			BaseListPlugin,
			...MarkdownKit,
		],
		value: initialValue,
	});
	editor.tf.select({
		anchor: { path: [0, 0], offset: 0 },
		focus: { path: [0, 0], offset: 0 },
	});
	return editor;
}

function encodeFragment(fragment: unknown[]): string {
	return Buffer.from(encodeURIComponent(JSON.stringify(fragment))).toString(
		"base64",
	);
}

function slateClipboard(options: {
	text?: string;
	fragment?: unknown[];
	htmlWithFragment?: boolean;
}) {
	const text = options.text ?? "";
	const encoded = options.fragment ? encodeFragment(options.fragment) : "";
	return {
		files: [],
		getData: (type: string) => {
			if (
				type === "application/x-slate-fragment" &&
				options.fragment &&
				!options.htmlWithFragment
			) {
				return encoded;
			}
			if (
				type === "text/html" &&
				options.fragment &&
				options.htmlWithFragment
			) {
				return `<div data-slate-fragment="${encoded}">copied content</div>`;
			}
			if (type === "text/plain") return text;
			return "";
		},
	} as unknown as DataTransfer;
}

describe("intra-editor paste preserving Slate fragment", () => {
	it("preserves rich AST (headings and paragraphs) without inserting extra blank lines", () => {
		const editor = createPasteEditor();
		const fragment = [
			{ type: KEYS.h2, children: [{ text: "二级标题" }] },
			{ type: KEYS.p, children: [{ text: "第一段正文说明" }] },
			{ type: KEYS.p, children: [{ text: "第二段正文说明" }] },
		];

		editor.tf.insertData(
			slateClipboard({
				text: "二级标题\n\n第一段正文说明\n\n第二段正文说明",
				fragment,
			}),
		);

		expect(editor.children).toHaveLength(3);
		expect(editor.children[0]).toMatchObject({
			type: KEYS.h2,
			children: [{ text: "二级标题" }],
		});
		expect(editor.children[1]).toMatchObject({
			type: KEYS.p,
			children: [{ text: "第一段正文说明" }],
		});
		expect(editor.children[2]).toMatchObject({
			type: KEYS.p,
			children: [{ text: "第二段正文说明" }],
		});

		// Ensure no ZWSP placeholder (\u200B) was injected
		expect(JSON.stringify(editor.children)).not.toContain("\u200B");
	});

	it("preserves inline wikilink nodes without duplicate label text", () => {
		const editor = createPasteEditor();
		const fragment = [
			{
				type: KEYS.p,
				children: [
					{ text: "参考 " },
					{
						type: "wikiLink",
						value: "papers/nlp/notes/NOTES",
						alias: "相关论文",
						children: [{ text: "" }],
					},
					{ text: " 机制" },
				],
			},
		];

		editor.tf.insertData(
			slateClipboard({
				text: "参考 相关论文相关论文[[papers/nlp/notes/NOTES|相关论文]] 机制",
				fragment,
			}),
		);

		expect(editor.children).toHaveLength(1);
		const pNode = editor.children[0] as {
			children: Array<Record<string, unknown>>;
		};
		expect(pNode.children).toHaveLength(3);
		expect(pNode.children[1]).toMatchObject({
			type: "wikiLink",
			value: "papers/nlp/notes/NOTES",
			alias: "相关论文",
		});
	});

	it("restores fragment from text/html data-slate-fragment attribute", () => {
		const editor = createPasteEditor();
		const fragment = [{ type: KEYS.h2, children: [{ text: "HTML 标题" }] }];

		editor.tf.insertData(
			slateClipboard({
				text: "HTML 标题",
				fragment,
				htmlWithFragment: true,
			}),
		);

		expect(editor.children[0]).toMatchObject({
			type: KEYS.h2,
			children: [{ text: "HTML 标题" }],
		});
	});

	it("falls back to markdown deserialization when no slate fragment is present", () => {
		const editor = createPasteEditor();

		editor.tf.insertData(
			slateClipboard({
				text: "- list item 1\n- list item 2",
			}),
		);

		expect(editor.children.length).toBeGreaterThan(0);
		expect(JSON.stringify(editor.children)).toContain("list item 1");
	});

	it("preserves H2 heading block when pasting plain text into empty H2", () => {
		const editor = createPasteEditor([
			{ type: KEYS.h2, children: [{ text: "" }] },
		]);

		editor.tf.insertData(
			slateClipboard({
				text: "二级标题文本",
			}),
		);

		expect(editor.children).toHaveLength(1);
		expect(editor.children[0]).toMatchObject({
			type: KEYS.h2,
			children: [{ text: "二级标题文本" }],
		});
	});

	it("preserves H2 heading block when pasting into non-empty H2", () => {
		const editor = createPasteEditor([
			{ type: KEYS.h2, children: [{ text: "前缀: " }] },
		]);
		editor.tf.select({
			anchor: { path: [0, 0], offset: 4 },
			focus: { path: [0, 0], offset: 4 },
		});

		editor.tf.insertData(
			slateClipboard({
				text: "二级标题文本",
			}),
		);

		expect(editor.children).toHaveLength(1);
		expect(editor.children[0]).toMatchObject({
			type: KEYS.h2,
			children: [{ text: "前缀: 二级标题文本" }],
		});
	});

	it("retains heading type for first block on multi-paragraph paste into empty heading", () => {
		const editor = createPasteEditor([
			{ type: KEYS.h2, children: [{ text: "" }] },
		]);

		editor.tf.insertData(
			slateClipboard({
				text: "标题行\n\n正文段落",
			}),
		);

		expect(editor.children).toHaveLength(2);
		expect(editor.children[0]).toMatchObject({
			type: KEYS.h2,
			children: [{ text: "标题行" }],
		});
		expect(editor.children[1]).toMatchObject({
			type: KEYS.p,
			children: [{ text: "正文段落" }],
		});
	});

	it("reproduces heading paste with MarkdownEditorKit", () => {
		const editor = createSlateEditor({
			plugins: [TestParagraphPlugin, RealH2Plugin, ...MarkdownKit],
			value: [{ type: KEYS.p, children: [{ text: "" }] }],
		});
		editor.tf.select({
			anchor: { path: [0, 0], offset: 0 },
			focus: { path: [0, 0], offset: 0 },
		});

		for (const c of "## ") editor.tf.insertText(c);

		editor.tf.insertData(
			slateClipboard({
				text: "二级标题文本",
				fragment: [{ type: KEYS.p, children: [{ text: "二级标题文本" }] }],
			}),
		);

		expect(editor.children).toHaveLength(1);
		expect(editor.children[0]).toMatchObject({
			type: KEYS.h2,
			children: [{ text: "二级标题文本" }],
		});
	});
});
