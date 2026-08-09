import { CodeBlockPlugin, CodeLinePlugin } from "@platejs/code-block/react";
import { createSlateEditor, createSlatePlugin, KEYS } from "platejs";
import { describe, expect, it } from "vitest";
import { handleCodeBlockDeleteBackward } from "@/lib/markdown/code-block-delete";

const TestParagraphPlugin = createSlatePlugin({
	key: KEYS.p,
	node: { isElement: true },
});

function createCodeEditor(
	value: Array<Record<string, unknown>>,
	selection: { path: number[]; offset: number },
) {
	const editor = createSlateEditor({
		plugins: [
			TestParagraphPlugin,
			// Same outer override as MarkdownEditorKit — stock plate still has the
			// cross-block previous() bug; tests exercise our handler via the wrapper.
			CodeBlockPlugin.overrideEditor(({ editor, tf: { deleteBackward } }) => ({
				transforms: {
					deleteBackward(unit) {
						if (handleCodeBlockDeleteBackward(editor)) return;
						deleteBackward(unit);
					},
				},
			})),
			CodeLinePlugin,
		],
		value,
	});
	editor.tf.select({
		anchor: selection,
		focus: selection,
	});
	return editor;
}

describe("code block deleteBackward (#178)", () => {
	it("unwraps an empty code block instead of jumping to an earlier one", () => {
		const editor = createCodeEditor(
			[
				{
					type: KEYS.codeBlock,
					children: [{ type: KEYS.codeLine, children: [{ text: "keep me" }] }],
				},
				{ type: KEYS.p, children: [{ text: "" }] },
				{
					type: KEYS.codeBlock,
					children: [{ type: KEYS.codeLine, children: [{ text: "" }] }],
				},
			],
			// Empty second code block, caret at start of its only line
			{ path: [2, 0, 0], offset: 0 },
		);

		editor.tf.deleteBackward("character");

		expect(editor.children).toMatchObject([
			{
				type: KEYS.codeBlock,
				children: [{ type: KEYS.codeLine, children: [{ text: "keep me" }] }],
			},
			{ type: KEYS.p, children: [{ text: "" }] },
			// Unwrapped empty code block → paragraph
			{ type: KEYS.p, children: [{ text: "" }] },
		]);
		// Caret stays on the unwrapped paragraph, not in the earlier code block
		expect(editor.selection?.anchor.path[0]).toBe(2);
		expect(editor.api.string([0])).toBe("keep me");
	});

	it("removes an empty trailing code line within the same block only", () => {
		const editor = createCodeEditor(
			[
				{
					type: KEYS.codeBlock,
					children: [{ type: KEYS.codeLine, children: [{ text: "line one" }] }],
				},
				{
					type: KEYS.codeBlock,
					children: [
						{ type: KEYS.codeLine, children: [{ text: "a" }] },
						{ type: KEYS.codeLine, children: [{ text: "" }] },
					],
				},
			],
			{ path: [1, 1, 0], offset: 0 },
		);

		editor.tf.deleteBackward("character");

		expect(editor.children).toMatchObject([
			{
				type: KEYS.codeBlock,
				children: [{ type: KEYS.codeLine, children: [{ text: "line one" }] }],
			},
			{
				type: KEYS.codeBlock,
				children: [{ type: KEYS.codeLine, children: [{ text: "a" }] }],
			},
		]);
		expect(editor.selection?.anchor).toMatchObject({
			path: [1, 0, 0],
			offset: 1,
		});
	});

	it("does not leave a non-empty first line via backspace-at-start", () => {
		const editor = createCodeEditor(
			[
				{
					type: KEYS.codeBlock,
					children: [{ type: KEYS.codeLine, children: [{ text: "hello" }] }],
				},
			],
			{ path: [0, 0, 0], offset: 0 },
		);

		editor.tf.deleteBackward("character");

		expect(editor.children).toMatchObject([
			{
				type: KEYS.codeBlock,
				children: [{ type: KEYS.codeLine, children: [{ text: "hello" }] }],
			},
		]);
		expect(editor.selection?.anchor).toMatchObject({
			path: [0, 0, 0],
			offset: 0,
		});
	});
});
