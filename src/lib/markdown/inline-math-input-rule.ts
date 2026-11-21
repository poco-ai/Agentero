import {
	defineInputRule,
	KEYS,
	matchDelimitedInline,
	type Point,
	type SlateEditor,
} from "platejs";
import { isLiteralTextContext } from "@/lib/markdown/input-context";

const INLINE_FOLLOW_RE = /[^$]/;

function isEscapedDelimiter(editor: SlateEditor, point: Point) {
	let backslashCount = 0;
	let cursor = point;

	while (true) {
		const before = editor.api.before(cursor, {
			distance: 1,
			unit: "character",
		});
		if (!before) break;

		const character = editor.api.string({
			anchor: before,
			focus: cursor,
		});
		if (character !== "\\") break;

		backslashCount += 1;
		cursor = before;
	}

	return backslashCount % 2 === 1;
}

type DelimitedInlineContext = Parameters<typeof matchDelimitedInline>[0];
type DelimitedInlineOptions = Parameters<typeof matchDelimitedInline>[1];

/**
 * Plate counts the matched text in UTF-16 code units but moves back by
 * grapheme. Use offsets so astral or combining characters cannot delete
 * the text before the opening delimiter.
 */
function matchInlineEquation(
	context: DelimitedInlineContext,
	options: DelimitedInlineOptions,
) {
	const match = matchDelimitedInline(context, options);
	const focus = context.editor.selection?.anchor;
	if (!match || !focus) return;
	const anchor = context.editor.api.before(focus, {
		distance: match.content.length + options.open.length,
		unit: "offset",
	});
	if (!anchor) return;
	return { ...match, deleteRange: { anchor, focus } };
}

/**
 * Converts unescaped `$expression$` and `\(expression\)` while allowing
 * delimiters next to text. Leave the caret in the following text node.
 */
export const inlineMathInputRule = defineInputRule({
	target: "insertText",
	enabled: ({ editor }) => !isLiteralTextContext(editor),
	priority: 100,
	trigger: ["$", ")"],
	resolve: (context) => {
		if (context.options?.at) return;
		const closingPoint = context.editor.selection?.anchor;
		if (context.text === ")") {
			// The backslash of the closing delimiter is already in the editor;
			// the input rule runs before the final ")" is inserted.
			if (!closingPoint || !isEscapedDelimiter(context.editor, closingPoint))
				return;
			const match = matchInlineEquation(context, {
				open: "\\(",
				requireClosingDelimiter: false,
			});
			if (
				!match ||
				isEscapedDelimiter(context.editor, match.deleteRange.anchor)
			)
				return;
			const content = match.content.slice(0, -1);
			if (content && content.trim() === content)
				return { ...match, content, kind: "equation" as const };
			return;
		}
		if (context.text !== "$") return;
		if (closingPoint && isEscapedDelimiter(context.editor, closingPoint)) {
			const escapeStart = context.editor.api.before(closingPoint, {
				distance: 1,
				unit: "character",
			});
			if (!escapeStart) return;

			return {
				kind: "literalDollar" as const,
				deleteRange: {
					anchor: escapeStart,
					focus: closingPoint,
				},
			};
		}

		const match = matchInlineEquation(context, {
			followRe: INLINE_FOLLOW_RE,
			open: "$",
			requireClosingDelimiter: false,
			trim: "reject",
		});
		if (
			match &&
			!isEscapedDelimiter(context.editor, match.deleteRange.anchor)
		) {
			return { ...match, kind: "equation" as const };
		}
	},
	apply: ({ editor }, match) => {
		if (match.kind === "literalDollar") {
			editor.tf.delete({ at: match.deleteRange });
			editor.tf.select(match.deleteRange.anchor);
			editor.tf.insertNodes({ text: "$" });
			return true;
		}

		editor.tf.delete({ at: match.deleteRange });
		editor.tf.select(match.deleteRange.anchor);
		editor.tf.insertNodes({
			children: [{ text: "" }],
			texExpression: match.content,
			type: editor.getType(KEYS.inlineEquation),
		});

		const equationEntry = editor.api.above({
			match: { type: editor.getType(KEYS.inlineEquation) },
		});
		const afterEquation = equationEntry
			? editor.api.after(equationEntry[1])
			: undefined;
		if (afterEquation) editor.tf.select(afterEquation);

		return true;
	},
});
