import { expandListItemsWithChildren } from "@platejs/list";
import { MarkdownPlugin } from "@platejs/markdown";
import { BlockSelectionPlugin } from "@platejs/selection/react";
import {
	ElementApi,
	getPluginByType,
	KEYS,
	NodeApi,
	PathApi,
	RangeApi,
	type SlateEditor,
	type TElement,
} from "platejs";
import { COLUMN_GROUP_KEY } from "@/lib/markdown/columns";
import { IMAGE_GROUP_KEY } from "@/lib/markdown/image-group";
import { stripInlinePlaceholders } from "@/lib/markdown/serialize";

/** Zero-width / whitespace that Slate uses to keep an empty text leaf alive. */
const INVISIBLE_RE = /\s|\u200B|\u200C|\u200D|\uFEFF/g;

/**
 * Markdown blank line: an empty paragraph (including TrailingBlock).
 * These stay in the tree for caret and spacing, but are not content blocks.
 */
export function isBlankParagraph(element: TElement): boolean {
	if (element.type !== KEYS.p) return false;
	if (
		element.children.some(
			(child) => "type" in child && Boolean((child as { type?: string }).type),
		)
	) {
		return false;
	}
	return NodeApi.string(element).replace(INVISIBLE_RE, "") === "";
}

export function selectedBlockIds(
	editor: Pick<SlateEditor, "getOption">,
): Set<string> {
	return editor.getOption(BlockSelectionPlugin, "selectedIds") ?? new Set();
}

export function hasSelectedBlocks(
	editor: Pick<SlateEditor, "getOption">,
): boolean {
	return selectedBlockIds(editor).size > 0;
}

export function serializeBlocksAsMarkdown(
	editor: SlateEditor,
	nodes: TElement[],
): string {
	if (nodes.length === 0) return "";
	return stripInlinePlaceholders(
		editor.getApi(MarkdownPlugin).markdown.serialize({ value: nodes }),
	);
}

export function selectedBlockNodes(editor: SlateEditor): TElement[] {
	return editor
		.getApi(BlockSelectionPlugin)
		.blockSelection.getNodes({ sort: true })
		.map(([node]) => node);
}

export function serializeSelectedBlocksAsMarkdown(editor: SlateEditor): string {
	return serializeBlocksAsMarkdown(editor, selectedBlockNodes(editor));
}

export function isEditorClipboardTarget(
	target: EventTarget | null,
	editorContainer: HTMLElement | null,
): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.classList.contains("slate-shadow-input")) return true;
	if (editorContainer?.contains(target)) return true;
	return Boolean(target.closest("[data-slate-editor]"));
}

/** Select this top-level block (and indent-list children) for menu / drag. */
export function selectElementAsBlocks(
	editor: SlateEditor,
	element: TElement,
): TElement[] {
	const path = editor.api.findPath(element);
	if (!path) return [];
	const blocks = expandListItemsWithChildren(editor, [[element, path]]).map(
		([node]) => node,
	);
	const ids = blocks
		.map((block) => block.id)
		.filter((id): id is string => typeof id === "string");
	if (ids.length === 0) return [];
	editor.getApi(BlockSelectionPlugin).blockSelection.set(ids);
	return blocks;
}

export function duplicateSelectedBlocks(editor: SlateEditor): void {
	editor.getTransforms(BlockSelectionPlugin).blockSelection.duplicate();
}

export function removeSelectedBlocks(editor: SlateEditor): void {
	editor.getTransforms(BlockSelectionPlugin).blockSelection.removeNodes();
}

export function isElementBlockSelected(
	editor: Pick<SlateEditor, "getOption">,
	element: TElement,
): boolean {
	const id = element.id;
	return typeof id === "string" && selectedBlockIds(editor).has(id);
}

/**
 * Keep a multi-block selection when the handle belongs to one of the
 * selected blocks; otherwise select just this block.
 */
export function resolveHandleBlocks(
	editor: SlateEditor,
	element: TElement,
): TElement[] {
	if (isElementBlockSelected(editor, element)) {
		const nodes = selectedBlockNodes(editor);
		if (nodes.length > 0) return nodes;
	}
	return selectElementAsBlocks(editor, element);
}

function insertParagraphAfterPath(editor: SlateEditor, path: number[]): void {
	const at = PathApi.next(path);
	editor.tf.insertNodes(
		{ type: editor.getType(KEYS.p), children: [{ text: "" }] },
		{ at },
	);
	editor.tf.select({ path: [...at, 0], offset: 0 });
	editor.tf.focus();
}

/**
 * True when `selection` already covers every edge of the top-level block at
 * `path`. A collapsed caret does not count — an empty block's range is itself
 * collapsed, so equality would skip straight to selecting the whole note.
 */
function selectionCoversTopBlock(editor: SlateEditor, path: number[]): boolean {
	const selection = editor.selection;
	const blockRange = editor.api.range(path);
	if (!selection || !blockRange) return false;
	if (RangeApi.isCollapsed(selection)) return false;
	if (RangeApi.equals(selection, blockRange)) return true;
	const [start, end] = RangeApi.edges(blockRange);
	const [selStart, selEnd] = RangeApi.edges(selection);
	if (selStart.path[0] !== path[0] || selEnd.path[0] !== path[0]) return false;
	return (
		RangeApi.includes(selection, start) && RangeApi.includes(selection, end)
	);
}

/**
 * Cmd+A: select this top-level block first, and the whole note only when that
 * block is already fully selected.
 *
 * Plate's block-selection `selectAll` treats any caret inside one nested block
 * (`code_line` under Mermaid / code) as "the block is selected" and immediately
 * selects every block. Callers pass the block path (or the highest block at
 * the caret).
 */
export function selectTopLevelBlockThenAll(
	editor: SlateEditor,
	path: number[],
): boolean {
	if (path.length === 0) return false;
	const topPath = path.slice(0, 1);
	const entry = editor.api.node(topPath);
	if (!entry) return false;
	const blockRange = editor.api.range(topPath);
	if (!blockRange) return false;
	const node = entry[0];
	const blockSelected =
		ElementApi.isElement(node) &&
		isElementBlockSelected(editor, node) &&
		selectedBlockIds(editor).size >= 1;
	if (selectionCoversTopBlock(editor, topPath) || blockSelected) {
		editor.getApi(BlockSelectionPlugin).blockSelection.selectAll();
		return true;
	}
	const api = editor.getApi(BlockSelectionPlugin).blockSelection;
	api.deselect();
	// An empty block has nowhere for a text range to grow. Mark the block id
	// so the next Cmd+A can tell this step from the still-collapsed caret.
	if (
		RangeApi.isCollapsed(blockRange) &&
		ElementApi.isElement(node) &&
		typeof node.id === "string"
	) {
		api.set([node.id]);
		return true;
	}
	editor.tf.select(blockRange);
	return true;
}

/** Cmd+A from the caret: current top-level block, then every block. */
export function selectCurrentBlockThenAll(editor: SlateEditor): boolean {
	if (!editor.selection) return false;
	const top = editor.api.block({ highest: true });
	if (!top) return false;
	return selectTopLevelBlockThenAll(editor, top[1]);
}

export type BlockChatLineSpan = {
	lineFrom: number;
	lineTo: number;
};

/**
 * Pin payload for one note block (or a multi-block selection) in the Agent
 * composer. Empty markdown or a missing note path does not produce a quote.
 */
export function blockChatSelectionInput(
	markdown: string,
	sourcePath: string,
	lines: BlockChatLineSpan | null,
): {
	text: string;
	sourcePath: string;
	origin: "markdown";
	lineFrom?: number;
	lineTo?: number;
} | null {
	const text = markdown.trim();
	const path = sourcePath.trim();
	if (!text || !path) return null;
	return {
		text,
		sourcePath: path,
		origin: "markdown",
		...(lines ? { lineFrom: lines.lineFrom, lineTo: lines.lineTo } : {}),
	};
}

/** Enter with the caret on a horizontal rule: break out into a paragraph below. */
export function insertBreakAfterHorizontalRule(editor: SlateEditor): boolean {
	if (!editor.selection) return false;
	const hr = editor.api.above({
		match: { type: editor.getType(KEYS.hr) },
	});
	if (!hr) return false;
	insertParagraphAfterPath(editor, hr[1]);
	return true;
}

/**
 * Enter while void-like blocks (hr / image / image group) are block-selected:
 * the selection plugin only re-focuses the void, so break out into a paragraph
 * below the last selected block instead.
 */
export function insertBreakAfterSelectedVoidBlocks(
	editor: SlateEditor,
): boolean {
	const nodes = selectedBlockNodes(editor);
	if (nodes.length === 0) return false;
	const firstType = nodes[0].type;
	// 图片组与分栏组都是容器,但块选后的 Enter 语义与 void 相同：在末尾插入新段落。
	const isVoidLike =
		firstType === IMAGE_GROUP_KEY ||
		firstType === COLUMN_GROUP_KEY ||
		Boolean(getPluginByType(editor, firstType)?.node.isVoid);
	if (!isVoidLike) return false;
	const lastPath = editor.api.findPath(nodes[nodes.length - 1]);
	if (!lastPath) return false;
	editor.getApi(BlockSelectionPlugin).blockSelection.deselect();
	insertParagraphAfterPath(editor, lastPath);
	return true;
}
