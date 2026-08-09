import { RangeApi, type TRange } from "platejs";
import type { PlateEditor } from "platejs/react";
import { insertExternalLinkNode } from "@/lib/markdown/external-link-insert";

export type EditorLinkTemplateKind = "wiki" | "external";

export type EditorLinkTemplate = {
	text: string;
	selectionStart: number;
	selectionEnd: number;
	wikiLinkDraft: boolean;
	/** External inserts create a real link node (not raw `[]()` text). */
	externalLinkNode?: boolean;
};

export type EditorContextMenuCapabilities = {
	copy: boolean;
	cut: boolean;
	exportNote: boolean;
	formatMarkdown: boolean;
	insertLink: boolean;
	paste: boolean;
	renameHeading: boolean;
};

export function editorContextMenuCapabilities({
	exportAvailable,
	headingRenameAvailable,
	readOnly,
	selectionExpanded,
}: {
	/** Desktop note export (PDF/PNG). False in browser preview. */
	exportAvailable: boolean;
	headingRenameAvailable: boolean;
	readOnly: boolean;
	selectionExpanded: boolean;
}): EditorContextMenuCapabilities {
	return {
		copy: selectionExpanded,
		cut: !readOnly && selectionExpanded,
		exportNote: exportAvailable,
		formatMarkdown: !readOnly,
		insertLink: !readOnly,
		paste: !readOnly,
		renameHeading: headingRenameAvailable,
	};
}

/**
 * Build the literal Markdown inserted by the editor context menu (wiki only
 * for raw text). External links insert a real link node — see
 * {@link insertExternalLinkNode}.
 *
 * A selected single-line label is preserved and remains selected after the
 * insertion. With a collapsed caret, the selection lands in the empty target
 * (`[[|]]`), ready for typing.
 */
export function editorLinkTemplate(
	kind: EditorLinkTemplateKind,
	selectedText = "",
): EditorLinkTemplate {
	if (kind === "wiki") {
		return {
			text: `[[${selectedText}]]`,
			selectionStart: 2,
			selectionEnd: 2 + selectedText.length,
			wikiLinkDraft: true,
		};
	}
	// Kept for callers that only need the conceptual shape; insert path no
	// longer writes this as plain text.
	return {
		text: `[${selectedText}]()`,
		selectionStart: 1,
		selectionEnd: 1 + selectedText.length,
		wikiLinkDraft: false,
		externalLinkNode: true,
	};
}

/**
 * Replace the supplied editor selection with a link:
 * - wiki → `[[…]]` draft text (completion opens)
 * - external → real `a` node + edit popover (slash / context menu)
 */
export function insertEditorLinkTemplate(
	editor: Pick<PlateEditor, "api" | "selection" | "tf" | "getType">,
	kind: EditorLinkTemplateKind,
	selection: TRange,
): EditorLinkTemplate {
	if (kind === "external") {
		const result = insertExternalLinkNode(editor as PlateEditor, selection, {
			openEdit: true,
		});
		return {
			text: `[${result.label}](${result.url})`,
			selectionStart: 1,
			selectionEnd: 1 + result.label.length,
			wikiLinkDraft: false,
			externalLinkNode: true,
		};
	}

	const selectedText = RangeApi.isCollapsed(selection)
		? ""
		: editor.api.string(selection);
	const template = editorLinkTemplate("wiki", selectedText);
	editor.tf.select(selection);
	editor.tf.withoutNormalizing(() => {
		if (!RangeApi.isCollapsed(selection)) {
			editor.tf.deleteFragment();
		}
		editor.tf.insertNodes({
			text: template.text,
			wikiLinkDraft: true,
		});
		const suffixLength = template.text.length - template.selectionEnd;
		if (suffixLength > 0) {
			editor.tf.move({ distance: suffixLength, reverse: true });
		}
		const selectedLength = template.selectionEnd - template.selectionStart;
		const focus = editor.selection?.anchor;
		const anchor =
			focus && selectedLength > 0
				? editor.api.before(focus, {
						distance: selectedLength,
						unit: "character",
					})
				: null;
		if (anchor && focus) {
			editor.tf.select({ anchor, focus });
		}
	});
	return template;
}
