import {
	defineInputRule,
	KEYS,
	matchDelimitedInline,
	type Point,
	type SlateEditor,
} from "platejs";

const INLINE_FOLLOW_RE = /[\s)\]}:;,.!?'"`]/;

function isEquationInputBlocked(editor: SlateEditor) {
	return editor.api.some({
		match: {
			type: [
				editor.getType(KEYS.codeBlock),
				editor.getType(KEYS.equation),
				editor.getType(KEYS.inlineEquation),
			],
		},
	});
}

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

/**
 * Converts unescaped `$expression$` while allowing the opening delimiter next
 * to text. Keep the caret in the following text node so typing can continue.
 */
export const inlineMathInputRule = defineInputRule({
	target: "insertText",
	enabled: ({ editor }) => !isEquationInputBlocked(editor),
	priority: 100,
	trigger: "$",
	resolve: (context) => {
		if (context.text !== "$" || context.options?.at) return;
		const closingPoint = context.editor.selection?.anchor;
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

		const match = matchDelimitedInline(context, {
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
