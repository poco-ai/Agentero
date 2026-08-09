import {
	getCodeLineEntry,
	isCodeBlockEmpty,
	unwrapCodeBlock,
} from "@platejs/code-block";
import { ElementApi, KEYS, PathApi, type SlateEditor } from "platejs";

/**
 * Plate's code-block `deleteBackward` uses `editor.api.previous({ match: code_line })`,
 * which walks the whole document. On an empty first line that jumps the caret into
 * another code block instead of removing the empty one (issue #178).
 *
 * Restrict "previous line" to the sibling within the same code block, and unwrap
 * when the whole block is empty.
 *
 * @returns true when the event was handled (caller should not continue).
 */
export function handleCodeBlockDeleteBackward(editor: SlateEditor): boolean {
	if (!editor.selection || editor.api.isExpanded()) return false;

	const entry = getCodeLineEntry(editor, {});
	if (!entry) return false;

	const { codeLine } = entry;
	const [, codeLinePath] = codeLine;
	if (!editor.api.isStart(editor.selection.anchor, codeLinePath)) return false;

	const previousPath = PathApi.previous(codeLinePath);
	const previousSibling = previousPath
		? editor.api.node(previousPath)
		: undefined;
	const previousIsCodeLine =
		!!previousSibling &&
		ElementApi.isElement(previousSibling[0]) &&
		previousSibling[0].type === editor.getType(KEYS.codeLine);
	const codeLineText = editor.api.string(codeLinePath);

	// Non-first line in this block: only collapse empty lines into the previous sibling.
	if (previousIsCodeLine && previousPath) {
		if (codeLineText.length > 0) return false;
		const previousLineEnd = editor.api.end(previousPath);
		editor.tf.removeNodes({ at: codeLinePath });
		if (previousLineEnd) editor.tf.select(previousLineEnd);
		return true;
	}

	// First line of this code block.
	if (codeLineText.length > 0) {
		// Match plate: do not leave a non-empty first line via backspace-at-start.
		return true;
	}

	if (isCodeBlockEmpty(editor)) {
		unwrapCodeBlock(editor);
		return true;
	}

	// Empty first line of a multi-line block — drop only that line (stay in block).
	editor.tf.removeNodes({ at: codeLinePath });
	const nextStart = editor.api.start(codeLinePath);
	if (nextStart) editor.tf.select(nextStart);
	return true;
}
