import { createSlateEditor, KEYS } from "platejs";
import { describe, expect, it } from "vitest";

import { LinkPlugin } from "@/components/editor/plugins/link-plugin";
import { WikiLinkPlugin } from "@/components/editor/plugins/wikilink-plugin";
import {
	editorContextMenuCapabilities,
	editorLinkTemplate,
	insertEditorLinkTemplate,
} from "@/lib/markdown/editor-context-menu";
import {
	clearExternalLinkEditRequest,
	peekExternalLinkEditId,
} from "@/lib/markdown/external-link-insert";

describe("Markdown editor context menu", () => {
	it("places an empty internal-link caret between the brackets", () => {
		expect(editorLinkTemplate("wiki")).toEqual({
			text: "[[]]",
			selectionStart: 2,
			selectionEnd: 2,
			wikiLinkDraft: true,
		});
	});

	it("marks external templates as node inserts", () => {
		expect(editorLinkTemplate("external")).toMatchObject({
			wikiLinkDraft: false,
			externalLinkNode: true,
		});
	});

	it("preserves selected text and selects it inside each link", () => {
		expect(editorLinkTemplate("wiki", "Target")).toEqual({
			text: "[[Target]]",
			selectionStart: 2,
			selectionEnd: 8,
			wikiLinkDraft: true,
		});
		expect(editorLinkTemplate("external", "Label")).toMatchObject({
			externalLinkNode: true,
			wikiLinkDraft: false,
		});
	});

	it("inserts a wiki draft with the caret before its closing brackets", () => {
		const editor = createSlateEditor({
			plugins: [WikiLinkPlugin],
			value: [{ type: "p", children: [{ text: "Before after" }] }],
		});
		const selection = {
			anchor: { path: [0, 0], offset: 7 },
			focus: { path: [0, 0], offset: 7 },
		};

		insertEditorLinkTemplate(editor, "wiki", selection);

		expect(editor.api.string([])).toBe("Before [[]]after");
		expect(editor.selection).toEqual({
			anchor: { path: [0, 1], offset: 2 },
			focus: { path: [0, 1], offset: 2 },
		});
		expect(editor.api.node([0, 1])?.[0]).toMatchObject({
			text: "[[]]",
			wikiLinkDraft: true,
		});
	});

	it("wraps selected text in an external link node and queues edit popover", () => {
		const editor = createSlateEditor({
			plugins: [LinkPlugin],
			value: [{ type: "p", children: [{ text: "Before label after" }] }],
		});
		const selection = {
			anchor: { path: [0, 0], offset: 7 },
			focus: { path: [0, 0], offset: 12 },
		};

		const result = insertEditorLinkTemplate(editor, "external", selection);

		expect(result.externalLinkNode).toBe(true);
		const children = (
			editor.children[0] as { children: Array<Record<string, unknown>> }
		).children;
		const link = children.find((c) => c.type === KEYS.a) as
			| {
					type: string;
					url: string;
					children: unknown;
					agenteroEditId?: string;
			  }
			| undefined;
		expect(link).toMatchObject({
			type: KEYS.a,
			url: "",
			children: [{ text: "label" }],
		});
		expect(typeof link?.agenteroEditId).toBe("string");
		expect(editor.api.string([])).toBe("Before label after");
		expect(peekExternalLinkEditId(editor)).toBe(link?.agenteroEditId);
		clearExternalLinkEditRequest(editor, link!.agenteroEditId!);
		expect(peekExternalLinkEditId(editor)).toBeNull();
	});

	it("inserts a default-label external link node when the caret is collapsed", () => {
		const editor = createSlateEditor({
			plugins: [LinkPlugin],
			value: [{ type: "p", children: [{ text: "Before after" }] }],
		});
		const selection = {
			anchor: { path: [0, 0], offset: 7 },
			focus: { path: [0, 0], offset: 7 },
		};

		insertEditorLinkTemplate(editor, "external", selection);

		const children = (
			editor.children[0] as { children: Array<Record<string, unknown>> }
		).children;
		const link = children.find((c) => c.type === KEYS.a);
		expect(link).toMatchObject({
			type: KEYS.a,
			url: "",
		});
		expect(JSON.stringify(editor.children)).not.toContain("[]()");
		expect(peekExternalLinkEditId(editor)).toBeTruthy();
	});

	it("keeps copy available in read-only notes and blocks mutations", () => {
		expect(
			editorContextMenuCapabilities({
				exportAvailable: true,
				headingRenameAvailable: false,
				readOnly: true,
				selectionExpanded: true,
			}),
		).toEqual({
			copy: true,
			cut: false,
			exportNote: true,
			formatMarkdown: false,
			insertLink: false,
			paste: false,
			renameHeading: false,
		});
	});

	it("enables editing actions while keeping heading rename contextual", () => {
		expect(
			editorContextMenuCapabilities({
				exportAvailable: false,
				headingRenameAvailable: true,
				readOnly: false,
				selectionExpanded: false,
			}),
		).toEqual({
			copy: false,
			cut: false,
			exportNote: false,
			formatMarkdown: true,
			insertLink: true,
			paste: true,
			renameHeading: true,
		});
	});
});
