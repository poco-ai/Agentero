import { ElementApi, KEYS, NodeApi } from "platejs";
import { createPlatePlugin } from "platejs/react";

import { LinkElement } from "@/components/editor/nodes/inline/link-node";
import {
	convertCompleteMarkdownLinkAtCaret,
	convertMarkdownLinkBeforeClosingParen,
	isClosingParen,
	markdownLinkInputRule,
} from "@/lib/markdown/link-input-rule";

/**
 * Inline link nodes produced by MarkdownPlugin (`type: a`).
 *
 * Conversion paths (belt and suspenders — real editor has many insertText
 * entry points and IME/fullwidth parens):
 * 1. Input rule on ASCII `)`
 * 2. overrideEditor.insertText for ASCII / fullwidth `）` and post-insert
 *    complete-link cleanup
 * 3. Empty-link normalize so delete does not leave a stale shell
 */
export const LinkPlugin = createPlatePlugin({
	key: KEYS.a,
	node: {
		isElement: true,
		isInline: true,
	},
	inputRules: [markdownLinkInputRule],
})
	.withComponent(LinkElement)
	.overrideEditor(
		({ editor, tf: { normalizeNode, deleteBackward, insertText } }) => ({
			transforms: {
				insertText(text, options) {
					// Typing the closing paren: convert without inserting `)`.
					if (
						isClosingParen(text) &&
						!options?.at &&
						convertMarkdownLinkBeforeClosingParen(editor)
					) {
						return;
					}

					insertText(text, options);

					// If a complete `[label](url)` already ends at the caret
					// (e.g. fullwidth paren was inserted as a multi-code unit, or
					// a previous path inserted `)` without converting), fold it.
					if (!options?.at) {
						convertCompleteMarkdownLinkAtCaret(editor);
					}
				},
				normalizeNode(entry) {
					const [node, path] = entry;
					if (
						ElementApi.isElement(node) &&
						node.type === editor.getType(KEYS.a) &&
						NodeApi.string(node) === ""
					) {
						editor.tf.removeNodes({ at: path });
						return;
					}
					normalizeNode(entry);
				},
				deleteBackward(unit) {
					deleteBackward(unit);
					const link = editor.api.above({
						match: { type: editor.getType(KEYS.a) },
					});
					if (link && NodeApi.string(link[0]) === "") {
						editor.tf.removeNodes({ at: link[1] });
					}
				},
			},
		}),
	);
