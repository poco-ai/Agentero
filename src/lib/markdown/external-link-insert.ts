import {
	KEYS,
	PathApi,
	RangeApi,
	type SlateEditor,
	type TRange,
} from "platejs";
import i18n from "@/i18n";

/**
 * Pending auto-open of the external-link edit popover.
 * Keyed by a per-insert id stored on the link node (`agenteroEditId`), not by
 * path — paths / effect remounts must not drop the request.
 */
const pendingEditIdByEditor = new WeakMap<SlateEditor, string>();

export function peekExternalLinkEditId(editor: SlateEditor): string | null {
	return pendingEditIdByEditor.get(editor) ?? null;
}

/** Clear a pending auto-open once the popover has actually opened. */
export function clearExternalLinkEditRequest(
	editor: SlateEditor,
	editId: string,
): void {
	if (pendingEditIdByEditor.get(editor) === editId) {
		pendingEditIdByEditor.delete(editor);
	}
}

type InsertExternalLinkResult = {
	label: string;
	url: string;
	path: number[] | null;
	editId: string | null;
};

/**
 * Place the caret in the **same parent block**, immediately after an inline
 * node. Always materializes a text sibling in that parent — never relies on
 * `api.after()`, which can jump into a TrailingBlock empty paragraph.
 */
export function selectAfterInlineNode(
	editor: SlateEditor,
	inlinePath: number[],
): void {
	const nextPath = PathApi.next(inlinePath);
	const nextEntry = editor.api.node(nextPath);
	const nextIsText =
		nextEntry != null &&
		typeof nextEntry[0] === "object" &&
		nextEntry[0] !== null &&
		"text" in nextEntry[0];

	if (!nextIsText) {
		editor.tf.insertNodes({ text: "" }, { at: nextPath });
	}

	editor.tf.select({
		anchor: { path: nextPath, offset: 0 },
		focus: { path: nextPath, offset: 0 },
	});
}

function newEditId(): string {
	return `ext-link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Insert a real inline link node (not raw `[]()` text) and optionally queue the
 * edit popover. Used by slash “external link” and the editor context menu.
 */
export function insertExternalLinkNode(
	editor: SlateEditor,
	selection: TRange,
	options?: {
		/** Open the label/URL popover after insert (default true). */
		openEdit?: boolean;
		label?: string;
		url?: string;
	},
): InsertExternalLinkResult {
	const openEdit = options?.openEdit ?? true;
	const selectedText = RangeApi.isCollapsed(selection)
		? ""
		: editor.api.string(selection);
	const label =
		options?.label ??
		(selectedText.trim() || i18n.t("editor:externalLink.defaultLabel"));
	const url = options?.url ?? "";

	let path: number[] | null = null;
	const linkType = editor.getType(KEYS.a);
	const editId = openEdit ? newEditId() : null;

	editor.tf.select(selection);
	editor.tf.withoutNormalizing(() => {
		if (!RangeApi.isCollapsed(selection)) {
			editor.tf.deleteFragment();
		}
		editor.tf.insertNodes({
			type: linkType,
			url,
			children: [{ text: label }],
			// Transient UI flag — not part of Markdown serialization.
			...(editId ? { agenteroEditId: editId } : {}),
		});
		const entry = editor.api.above({
			match: { type: linkType },
		});
		if (entry) {
			path = entry[1];
			selectAfterInlineNode(editor, entry[1]);
		}
	});

	if (editId) {
		pendingEditIdByEditor.set(editor, editId);
	}

	return { label, url, path, editId };
}
