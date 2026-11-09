import { MarkdownPlugin } from "@platejs/markdown";
import { KEYS, RangeApi, type SlateEditor, type TRange } from "platejs";
import { stripInlinePlaceholders } from "@/lib/markdown/serialize";

/**
 * Math nodes are void: their TeX source lives in `texExpression`, not in any
 * text leaf. The default Slate clipboard path copies `text/plain` from the
 * rendered DOM, so a selection that includes formulas pastes KaTeX glyph soup
 * (and loses the LaTeX source) instead of `$…$`.
 *
 * These helpers let the Markdown editor copy selections that touch math as
 * Markdown source instead — text and formulas together, exactly as they are on
 * disk.
 */

type MathNodeLike = {
	type?: unknown;
	texExpression?: unknown;
};

function texSource(node: unknown): string | null {
	if (!node || typeof node !== "object") return null;
	const tex = (node as MathNodeLike).texExpression;
	if (typeof tex !== "string") return null;
	const trimmed = tex.trim();
	return trimmed ? trimmed : null;
}

/** Markdown source for one equation node, preserving inline vs display form. */
export function mathNodeMarkdown(node: unknown): string | null {
	const tex = texSource(node);
	if (!tex) return null;
	const type = (node as MathNodeLike).type;
	return type === KEYS.inlineEquation ? `$${tex}$` : `$$\n${tex}\n$$`;
}

/** Markdown for a non-collapsed selection (block structure + inline marks). */
export function serializeSelectionAsMarkdown(
	editor: SlateEditor,
	selection: TRange | null = editor.selection,
): string {
	if (!selection || RangeApi.isCollapsed(selection)) return "";
	const fragment = editor.api.fragment(selection);
	if (!fragment || fragment.length === 0) return "";
	return stripInlinePlaceholders(
		editor.getApi(MarkdownPlugin).markdown.serialize({ value: fragment }),
	);
}

function selectionHasMath(editor: SlateEditor, selection: TRange): boolean {
	for (const [node] of editor.api.nodes({ at: selection })) {
		if (texSource(node)) return true;
	}
	return false;
}

type MathClipboardPayload = {
	markdown: string;
	/** Set when the caret sits inside a void math node (copy/cut whole node). */
	path?: number[];
};

/**
 * Clipboard Markdown for a selection that includes math, or null when the
 * default plain-text copy should be kept.
 *
 * - expanded selection containing at least one equation → serialize the
 *   selection as Markdown (`$…$` / `$$…$$` preserved);
 * - collapsed caret on/inside an equation → the equation's own Markdown.
 */
export function mathClipboardPayload(
	editor: SlateEditor,
	selection: TRange | null = editor.selection,
): MathClipboardPayload | null {
	if (!selection) return null;
	if (RangeApi.isCollapsed(selection)) {
		const entry = editor.api.above({
			at: selection,
			match: (node) => texSource(node) !== null,
			// Void inline equations are skipped by default ancestor queries.
			voids: true,
		});
		if (!entry) return null;
		const markdown = mathNodeMarkdown(entry[0]);
		return markdown ? { markdown, path: entry[1] } : null;
	}
	if (!selectionHasMath(editor, selection)) return null;
	const markdown = serializeSelectionAsMarkdown(editor, selection);
	return markdown ? { markdown } : null;
}
