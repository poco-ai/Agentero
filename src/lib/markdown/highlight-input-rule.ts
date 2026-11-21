import {
	defineInputRule,
	KEYS,
	matchDelimitedInline,
	type SlateEditor,
} from "platejs";
import { isLiteralTextContext } from "@/lib/markdown/input-context";

/**
 * `==文字==` highlight input rule.
 *
 * Plate's built-in `HighlightRules` reuses `createMarkInputRule`, which only
 * accepts an opening delimiter at the start of the block or after whitespace,
 * so CJK prose without spaces (`前面==高亮==`) stayed literal (#1170).
 * `matchDelimitedInline` has no such boundary requirement while still rejecting
 * content padded with whitespace (`==高亮 ==`). Longer `=` runs are not fences,
 * matching `highlight-scan`.
 *
 * The rule fires on the second `=` of the closing pair. Input rules resolve
 * before the trigger character is inserted, so the already-typed `=` closes the
 * highlight (`close: "="` + `requireClosingDelimiter: false`) and the trigger
 * would have been the second half of `==`.
 */
export const highlightInputRule = defineInputRule({
	target: "insertText",
	enabled: ({ editor }) => !isLiteralTextContext(editor),
	priority: 100,
	trigger: "=",
	resolve: (context) => {
		if (context.text !== "=" || context.options?.at) return;
		// The first half of the closing `==` must already be in the text.
		if (!context.getBlockStartText()?.endsWith(context.text)) return;
		const match = matchDelimitedInline(context, {
			close: "=",
			open: "==",
			requireClosingDelimiter: false,
			trim: "allow",
		});
		if (!match) return;
		// `match.content` still carries the already-typed `=`; the highlight
		// content is what precedes it.
		const content = match.content.slice(0, -context.text.length);
		if (!content || content.trim() !== content) return;
		// A third `=` before the opening fence is a longer run, not a highlight.
		if (charBefore(context.editor, match.deleteRange.anchor) === "=") return;
		return { content, deleteRange: match.deleteRange };
	},
	apply: ({ editor }, match) => {
		const { anchor: openerStart } = match.deleteRange;
		const caret = editor.selection?.anchor;
		if (!caret) return false;
		const contentStart = editor.api.after(openerStart, {
			distance: 2,
			unit: "character",
		});
		// The typed `=` is the first half of the closing fence.
		const contentEnd = editor.api.before(caret, {
			distance: 1,
			unit: "character",
		});
		if (!contentStart || !contentEnd) return false;

		const highlight = editor.getType(KEYS.highlight);
		// Mark the matched text in place so surrounding marks (bold, link) and
		// inline nodes survive, then drop both fences.
		editor.tf.delete({ at: { anchor: contentEnd, focus: caret } });
		editor.tf.select({ anchor: contentStart, focus: contentEnd });
		editor.tf.addMark(highlight, true);
		editor.tf.collapse({ edge: "end" });
		// Keep typing outside the highlight, like the built-in mark rules.
		editor.tf.removeMarks([highlight], { shouldChange: false });
		editor.tf.delete({ at: { anchor: openerStart, focus: contentStart } });
		return true;
	},
});

function charBefore(
	editor: SlateEditor,
	at: { path: number[]; offset: number },
) {
	const before = editor.api.before(at, { distance: 1, unit: "character" });
	if (!before) return undefined;
	return editor.api.string({ anchor: before, focus: at });
}
