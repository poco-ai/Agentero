import { MarkdownPlugin } from "@platejs/markdown";
import { createSlatePlugin, KEYS, type SlateEditor } from "platejs";
import { prepareMarkdownForDeserialize } from "@/lib/markdown/deserialize";
import { isUnfinishedMarkdownLinkContext } from "@/lib/markdown/link-input-rule";

function isMarkdownPasteBlocked(editor: SlateEditor) {
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

/**
 * Parse clipboard text as Markdown before Plate's HTML parser can claim a
 * payload that contains both text/plain and text/html.
 *
 * Exception: when the caret is mid `[label](…)` construction, insert plain
 * text so a bare URL is not turned into an autolink node that breaks the
 * surrounding Markdown link syntax.
 */
export const MarkdownPastePlugin = createSlatePlugin({
	key: "markdownPaste",
}).overrideEditor(({ editor, tf: { insertData } }) => ({
	transforms: {
		insertData(dataTransfer) {
			const markdown = dataTransfer.getData("text/plain");
			if (
				!markdown ||
				dataTransfer.files.length > 0 ||
				isMarkdownPasteBlocked(editor)
			) {
				return insertData(dataTransfer);
			}

			// Unfinished `[label](` — keep paste as literal characters so typing
			// `)` can convert the whole thing into one link node.
			// Only for single-line payloads (multi-line stays Markdown).
			if (!markdown.includes("\n") && isUnfinishedMarkdownLinkContext(editor)) {
				editor.tf.insertText(markdown);
				return;
			}

			const fragment = editor
				.getApi(MarkdownPlugin)
				.markdown.deserialize(prepareMarkdownForDeserialize(markdown));
			if (fragment.length === 0) return insertData(dataTransfer);

			editor.tf.insertFragment(fragment);

			const inlineEquationEntry = editor.api.above({
				match: { type: editor.getType(KEYS.inlineEquation) },
			});
			const afterEquation = inlineEquationEntry
				? editor.api.after(inlineEquationEntry[1])
				: undefined;
			if (afterEquation) editor.tf.select(afterEquation);
		},
	},
}));
