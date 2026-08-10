import {
	defineInputRule,
	ElementApi,
	KEYS,
	NodeApi,
	PathApi,
	type Point,
	type Range,
	type SlateEditor,
	type TElement,
} from "platejs";
import { selectAfterInlineNode } from "@/lib/markdown/external-link-insert";

/**
 * Incomplete link ending at caret (closing `)` not yet in the document).
 * Label: no `]`; URL: no whitespace / `)`.
 */
const MARKDOWN_LINK_BEFORE_CLOSE_RE = /\[([^\]]+)\]\(([^)\s]+)$/;

/** Complete link ending at caret (closing `)` already present). */
const MARKDOWN_LINK_COMPLETE_RE = /\[([^\]]+)\]\(([^)\s]+)\)$/;

/** Text ends with an unfinished `[label](` opener (label may be empty while typing). */
const MARKDOWN_LINK_OPEN_RE = /\[([^\]]*)\]\($/;

type LinkEl = TElement & { url?: string };

/** ASCII or fullwidth closing paren (IME / fullwidth keyboard). */
export function isClosingParen(text: string): boolean {
	return text === ")" || text === "）";
}

function isCodeOrEquationBlocked(editor: SlateEditor): boolean {
	if (
		editor.api.above({
			match: {
				type: [
					editor.getType(KEYS.codeBlock),
					editor.getType(KEYS.inlineEquation),
					editor.getType(KEYS.equation),
				],
			},
		})
	) {
		return true;
	}
	const marks = editor.api.marks();
	return Boolean(marks && (marks as { code?: boolean }).code);
}

function rangeBeforeEnd(
	editor: SlateEditor,
	end: Point,
	charCount: number,
): Range | null {
	if (charCount <= 0) return null;
	const start = editor.api.before(end, {
		distance: charCount,
		unit: "character",
	});
	if (!start) return null;
	const actual = editor.api.string({ anchor: start, focus: end });
	if (actual.length !== charCount) return null;
	return { anchor: start, focus: end };
}

function blockPrefixBeforeCaret(editor: SlateEditor, end: Point): string {
	const block = editor.api.block({ at: end });
	if (!block) {
		const start = editor.api.before(end, {
			distance: 4096,
			unit: "character",
		});
		return editor.api.string({
			anchor: start ?? { path: end.path, offset: 0 },
			focus: end,
		});
	}
	const blockStart = editor.api.start(block[1]);
	if (!blockStart) return "";
	return editor.api.string({ anchor: blockStart, focus: end });
}

function insertLinkNode(
	editor: SlateEditor,
	deleteRange: Range,
	label: string,
	url: string,
): boolean {
	editor.tf.withoutNormalizing(() => {
		editor.tf.select(deleteRange);
		editor.tf.deleteFragment();
		editor.tf.insertNodes({
			type: editor.getType(KEYS.a),
			url,
			children: [{ text: label }],
		});
		const linkEntry = editor.api.above({
			match: { type: editor.getType(KEYS.a) },
		});
		if (linkEntry) {
			// Same parent text leaf after the link — never api.after() (can jump
			// into TrailingBlock empty paragraph = “cursor on next line”).
			selectAfterInlineNode(editor, linkEntry[1]);
		}
	});
	return true;
}

/**
 * True when the caret sits in an unfinished Markdown link construction:
 * - pure text ending with `[label](`, or
 * - `[label](` text immediately followed by an inline link node (pasted bare URL).
 *
 * Used by paste so a bare URL is inserted as plain text instead of an autolink.
 */
export function isUnfinishedMarkdownLinkContext(editor: SlateEditor): boolean {
	if (!editor.selection || !editor.api.isCollapsed()) return false;
	if (isCodeOrEquationBlocked(editor)) return false;

	if (findOpenParenPlusAutolink(editor)) return true;

	const prefix = blockPrefixBeforeCaret(editor, editor.selection.anchor);
	return MARKDOWN_LINK_OPEN_RE.test(prefix);
}

/**
 * Locate `[label](` plain text immediately before an inline `a` node that holds
 * the URL (Markdown paste of a bare URL creates this structure).
 */
function findOpenParenPlusAutolink(editor: SlateEditor): {
	label: string;
	url: string;
	openText: string;
	openStart: Point;
	linkPath: number[];
} | null {
	const linkType = editor.getType(KEYS.a);
	let linkPath: number[] | null = null;
	let linkNode: LinkEl | null = null;

	const above = editor.api.above({
		match: { type: linkType },
	});
	if (above && ElementApi.isElement(above[0])) {
		linkNode = above[0] as LinkEl;
		linkPath = above[1];
	} else if (editor.selection) {
		// Caret in the empty text leaf after a pasted autolink.
		const textPath = editor.selection.anchor.path;
		if (textPath.length >= 2) {
			const index = textPath[textPath.length - 1] ?? 0;
			if (index > 0) {
				const prevPath = PathApi.previous(textPath);
				if (prevPath) {
					const prev = editor.api.node(prevPath);
					if (
						prev &&
						ElementApi.isElement(prev[0]) &&
						prev[0].type === linkType
					) {
						linkNode = prev[0] as LinkEl;
						linkPath = prev[1];
					}
				}
			}
		}
	}

	if (!linkNode || !linkPath) return null;

	const url = (linkNode.url?.trim() || NodeApi.string(linkNode)).trim();
	if (!url || /\s/.test(url)) return null;

	const linkStart = editor.api.start(linkPath);
	if (!linkStart) return null;

	const block = editor.api.block({ at: linkPath });
	if (!block) return null;
	const blockStart = editor.api.start(block[1]);
	if (!blockStart) return null;

	const before = editor.api.string({
		anchor: blockStart,
		focus: linkStart,
	});
	const openMatch = MARKDOWN_LINK_OPEN_RE.exec(before);
	if (!openMatch) return null;

	const openText = openMatch[0];
	const label = (openMatch[1] ?? "").trim();
	if (!label) return null;

	const openStart = editor.api.before(linkStart, {
		distance: openText.length,
		unit: "character",
	});
	if (!openStart) return null;

	return { label, url, openText, openStart, linkPath };
}

/**
 * Fold `[label](` + pasted autolink into one labeled link.
 * Remove the autolink node first — deleting a range that only ends *inside*
 * the link leaves the element shell and nests the replacement.
 */
function convertOpenParenPlusAutolink(editor: SlateEditor): boolean {
	const found = findOpenParenPlusAutolink(editor);
	if (!found) return false;

	const { label, url, openText, openStart, linkPath } = found;
	const linkType = editor.getType(KEYS.a);

	editor.tf.withoutNormalizing(() => {
		// 1) Drop the autolink element (path becomes invalid after this).
		editor.tf.removeNodes({ at: linkPath });
		// 2) Caret is typically where the link was (right after `[label](`).
		//    Delete the opener text, then insert the real labeled link.
		const afterOpen = editor.api.after(openStart, {
			distance: openText.length,
			unit: "character",
		});
		const openEnd = afterOpen ?? editor.selection?.anchor ?? openStart;
		editor.tf.select({ anchor: openStart, focus: openEnd });
		editor.tf.deleteFragment();
		editor.tf.insertNodes({
			type: linkType,
			url,
			children: [{ text: label }],
		});
		const linkEntry = editor.api.above({
			match: { type: linkType },
		});
		if (linkEntry) {
			selectAfterInlineNode(editor, linkEntry[1]);
		}
	});
	return true;
}

type LinkMatchAtCaret = {
	deleteRange: Range;
	label: string;
	url: string;
};

/**
 * Match `[label](url…)` ending at the caret and resolve the exact range to
 * replace. Shared by both conversion entry points and the input rule, which
 * differ only in the pattern they match.
 */
function matchLinkAtCaret(
	editor: SlateEditor,
	pattern: RegExp,
): LinkMatchAtCaret | null {
	if (!editor.selection || !editor.api.isCollapsed()) return null;
	if (isCodeOrEquationBlocked(editor)) return null;
	// Inside an existing link this would steal the caret's `)`.
	if (editor.api.above({ match: { type: editor.getType(KEYS.a) } })) {
		return null;
	}

	const end = editor.selection.anchor;
	const match = pattern.exec(blockPrefixBeforeCaret(editor, end));
	if (!match) return null;

	const full = match[0];
	const label = match[1] ?? "";
	const url = match[2] ?? "";
	if (!label.trim() || !url.trim()) return null;

	const deleteRange = rangeBeforeEnd(editor, end, full.length);
	if (!deleteRange) return null;
	if (editor.api.string(deleteRange) !== full) return null;

	return { deleteRange, label, url };
}

/**
 * Convert trailing `[label](url` before the caret into a link (caller is about
 * to type the closing paren — do not insert the paren).
 *
 * Also handles the paste-autolink structure: `[label](` + inline `a` node.
 */
export function convertMarkdownLinkBeforeClosingParen(
	editor: SlateEditor,
): boolean {
	if (!editor.selection || !editor.api.isCollapsed()) return false;
	if (isCodeOrEquationBlocked(editor)) return false;

	// Paste bare URL → autolink node after `[label](`.
	if (convertOpenParenPlusAutolink(editor)) return true;

	const match = matchLinkAtCaret(editor, MARKDOWN_LINK_BEFORE_CLOSE_RE);
	if (!match) return false;
	return insertLinkNode(editor, match.deleteRange, match.label, match.url);
}

/**
 * Convert a complete `[label](url)` that already ends at the caret.
 */
export function convertCompleteMarkdownLinkAtCaret(
	editor: SlateEditor,
): boolean {
	const match = matchLinkAtCaret(editor, MARKDOWN_LINK_COMPLETE_RE);
	if (!match) return false;
	return insertLinkNode(editor, match.deleteRange, match.label, match.url);
}

/**
 * Plate input-rule entry (trigger `)`). Prefer overrideEditor on LinkPlugin.
 */
export const markdownLinkInputRule = defineInputRule({
	target: "insertText",
	enabled: ({ editor }) => !isCodeOrEquationBlocked(editor),
	priority: 120,
	trigger: ")",
	resolve: (context) => {
		if (context.text !== ")" || context.options?.at) return;
		return (
			matchLinkAtCaret(context.editor, MARKDOWN_LINK_BEFORE_CLOSE_RE) ??
			undefined
		);
	},
	apply: ({ editor }, match) =>
		insertLinkNode(editor, match.deleteRange, match.label, match.url),
});
