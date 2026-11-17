import { BaseListPlugin } from "@platejs/list";
import { createSlateEditor, createSlatePlugin, KEYS } from "platejs";
import { ParagraphPlugin } from "platejs/react";
import { describe, expect, it } from "vitest";
import { LinkPlugin } from "@/components/editor/plugins/link-plugin";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import {
	clearExternalLinkEditRequest,
	insertExternalLinkNode,
	peekExternalLinkEditId,
} from "@/lib/markdown/external-link-insert";
import {
	executeSlashCommand,
	findSlashCommandTrigger,
	type SlashCommandTarget,
} from "@/lib/markdown/slash-command";

const TestPlugins = [
	KEYS.p,
	KEYS.h1,
	KEYS.h2,
	KEYS.h3,
	KEYS.blockquote,
	KEYS.callout,
	KEYS.codeBlock,
	KEYS.codeLine,
].map((key) =>
	createSlatePlugin({
		key,
		node: { isElement: true },
	}),
);

function isInsideLink(editor: ReturnType<typeof createSlateEditor>): boolean {
	return Boolean(editor.api.above({ match: { type: editor.getType(KEYS.a) } }));
}

describe("external link insert cursor", () => {
	it("mid-paragraph keeps caret after the link, not inside it", () => {
		const editor = createSlateEditor({
			plugins: [ParagraphPlugin, LinkPlugin],
			value: [{ type: "p", children: [{ text: "Before after" }] }],
		});
		insertExternalLinkNode(
			editor,
			{
				anchor: { path: [0, 0], offset: 7 },
				focus: { path: [0, 0], offset: 7 },
			},
			{ openEdit: false },
		);
		expect(editor.children).toHaveLength(1);
		expect(isInsideLink(editor)).toBe(false);
		expect(editor.selection?.anchor).toEqual({ path: [0, 2], offset: 0 });
	});

	it("at end of paragraph keeps caret after link on the same line", () => {
		const editor = createSlateEditor({
			plugins: [ParagraphPlugin, LinkPlugin],
			value: [{ type: "p", children: [{ text: "Before " }] }],
		});
		insertExternalLinkNode(
			editor,
			{
				anchor: { path: [0, 0], offset: 7 },
				focus: { path: [0, 0], offset: 7 },
			},
			{ openEdit: false },
		);
		expect(editor.children).toHaveLength(1);
		expect((editor.children[0] as { type: string }).type).toBe("p");
		expect(isInsideLink(editor)).toBe(false);
		// Empty text leaf after the link, caret at its start.
		expect(editor.selection?.anchor).toEqual({ path: [0, 2], offset: 0 });
	});

	it("hand-typed [label](url) conversion keeps caret on the same paragraph", () => {
		const editor = createSlateEditor({
			plugins: [ParagraphPlugin, LinkPlugin],
			// Simulate TrailingBlock empty paragraph after the content block.
			value: [
				{
					type: "p",
					children: [{ text: "[docs](https://example.com" }],
				},
				{ type: "p", children: [{ text: "" }] },
			],
		});
		const len = "[docs](https://example.com".length;
		editor.tf.select({
			anchor: { path: [0, 0], offset: len },
			focus: { path: [0, 0], offset: len },
		});

		// Typing ) goes through the upstream input rule.
		editor.tf.insertText(")");

		expect(editor.selection?.anchor.path[0]).toBe(0);
		expect(isInsideLink(editor)).toBe(false);
		// Must not land in the trailing empty paragraph.
		expect(editor.selection?.anchor.path[0]).not.toBe(1);

		const children = (
			editor.children[0] as { children: Array<Record<string, unknown>> }
		).children;
		expect(children.some((c) => c.type === KEYS.a)).toBe(true);
	});

	it("Markdown input rule with trailing block stays in-block", () => {
		const editor = createSlateEditor({
			plugins: [ParagraphPlugin, LinkPlugin],
			value: [
				{
					type: "p",
					children: [{ text: "[x](https://a.com" }],
				},
				{ type: "p", children: [{ text: "" }] },
			],
		});
		const len = "[x](https://a.com".length;
		editor.tf.select({
			anchor: { path: [0, 0], offset: len },
			focus: { path: [0, 0], offset: len },
		});
		editor.tf.insertText(")");
		expect(editor.selection?.anchor.path[0]).toBe(0);
		expect(isInsideLink(editor)).toBe(false);
	});

	it("slash external link leaves caret after the node on the same paragraph", () => {
		const editor = createSlateEditor({
			plugins: [...TestPlugins, BaseListPlugin, LinkPlugin, ...MarkdownKit],
			value: [{ type: "p", children: [{ text: "Hello /external" }] }],
		});
		editor.tf.select({
			anchor: { path: [0, 0], offset: "Hello /external".length },
			focus: { path: [0, 0], offset: "Hello /external".length },
		});
		const trigger = findSlashCommandTrigger(
			"Hello /external",
			"Hello /external".length,
		);
		expect(trigger).toBeTruthy();
		const target: SlashCommandTarget = { ...trigger!, path: [0, 0] };
		expect(executeSlashCommand(editor, "externalLink", target)).toBe(true);

		expect(editor.children).toHaveLength(1);
		expect(isInsideLink(editor)).toBe(false);
		expect(editor.selection?.anchor.path[0]).toBe(0);
		expect(editor.selection?.anchor).toEqual({ path: [0, 2], offset: 0 });
	});
});

describe("external link auto-open request", () => {
	it("stamps agenteroEditId on the node and registers the same pending id", () => {
		const editor = createSlateEditor({
			plugins: [ParagraphPlugin, LinkPlugin],
			value: [{ type: "p", children: [{ text: "x" }] }],
		});
		const result = insertExternalLinkNode(
			editor,
			{
				anchor: { path: [0, 0], offset: 1 },
				focus: { path: [0, 0], offset: 1 },
			},
			{ openEdit: true },
		);
		expect(result.editId).toBeTruthy();
		const children = (
			editor.children[0] as { children: Array<Record<string, unknown>> }
		).children;
		const link = children.find((c) => c.type === KEYS.a) as {
			agenteroEditId?: string;
		};
		expect(link.agenteroEditId).toBe(result.editId);
		expect(peekExternalLinkEditId(editor)).toBe(result.editId);
		// Simulates component opening once
		clearExternalLinkEditRequest(editor, result.editId!);
		expect(peekExternalLinkEditId(editor)).toBeNull();
		// Second clear is no-op; id on node may still exist but peek is empty
		// so UI will not re-open after dismiss.
	});
});
