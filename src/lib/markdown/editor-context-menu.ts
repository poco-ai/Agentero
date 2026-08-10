import { RangeApi, type TRange } from "platejs";
import type { PlateEditor } from "platejs/react";
import { insertExternalLinkNode } from "@/lib/markdown/external-link-insert";

export type EditorLinkTemplateKind = "wiki" | "external";

export type EditorLinkTemplate = {
	/** True when the insert produced `[[…]]` draft text the completion menu owns. */
	wikiLinkDraft: boolean;
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
		insertExternalLinkNode(editor as PlateEditor, selection, {
			openEdit: true,
		});
		return { wikiLinkDraft: false };
	}

	const selectedText = RangeApi.isCollapsed(selection)
		? ""
		: editor.api.string(selection);
	editor.tf.select(selection);
	editor.tf.withoutNormalizing(() => {
		if (!RangeApi.isCollapsed(selection)) {
			editor.tf.deleteFragment();
		}
		editor.tf.insertNodes({
			text: `[[${selectedText}]]`,
			wikiLinkDraft: true,
		});
		// The caret lands after the node; step back over the two closing brackets
		// so a collapsed insert reads `[[|]]`.
		editor.tf.move({ distance: 2, reverse: true });
		const focus = editor.selection?.anchor;
		// A preserved label stays selected, ready to be overtyped.
		const anchor =
			focus && selectedText
				? editor.api.before(focus, {
						distance: selectedText.length,
						unit: "character",
					})
				: null;
		if (anchor && focus) {
			editor.tf.select({ anchor, focus });
		}
	});
	return { wikiLinkDraft: true };
}
