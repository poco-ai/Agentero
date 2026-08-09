import type { Point, TRange, Value } from "platejs";
import type { PlateEditor } from "platejs/react";
import { joinFrontmatter, splitFrontmatter } from "@/lib/markdown/frontmatter";

const CONTEXT_RADIUS = 16;

type TextLeaf = {
	path: number[];
	text: string;
};

export type MarkdownPointBookmark = {
	path: number[];
	offset: number;
	blockIndex: number;
	blockOffset: number;
	before: string;
	after: string;
};

export type MarkdownSelectionBookmark = {
	anchor: MarkdownPointBookmark;
	focus: MarkdownPointBookmark;
};

export type MarkdownFormatPreparation<T> =
	| { status: "stale" }
	| { status: "unchanged" }
	| { status: "ready"; markdown: string; value: T };

/**
 * Prepare a whole-document format result without mutating the editor. The
 * current-source callback is checked on both sides of deserialization so an
 * old async result can never replace newer input.
 */
export async function prepareMarkdownFormat<T>({
	currentSource,
	deserialize,
	formatSource,
	snapshot,
}: {
	currentSource: () => string;
	deserialize: (body: string) => T;
	formatSource: (source: string) => Promise<string>;
	snapshot: string;
}): Promise<MarkdownFormatPreparation<T>> {
	const formatted = await formatSource(snapshot);
	if (currentSource() !== snapshot) return { status: "stale" };

	const original = splitFrontmatter(snapshot);
	const formattedDoc = splitFrontmatter(formatted);
	// Frontmatter is kept outside Plate history. Preserve it byte-exact so the
	// complete formatter mutation remains representable by one editor Undo.
	const markdown = joinFrontmatter(original.frontmatter, formattedDoc.body);
	if (markdown === snapshot) return { status: "unchanged" };

	const value = deserialize(formattedDoc.body || " ");
	if (currentSource() !== snapshot) return { status: "stale" };
	return { status: "ready", markdown, value };
}

function textLeaves(value: Value, blockIndex: number): TextLeaf[] {
	const block = value[blockIndex] as unknown;
	if (!block || typeof block !== "object") return [];
	const leaves: TextLeaf[] = [];

	const visit = (node: unknown, path: number[]) => {
		if (!node || typeof node !== "object") return;
		const candidate = node as { children?: unknown[]; text?: unknown };
		if (typeof candidate.text === "string") {
			leaves.push({ path, text: candidate.text });
			return;
		}
		candidate.children?.forEach((child, index) => {
			visit(child, [...path, index]);
		});
	};

	visit(block, [blockIndex]);
	return leaves;
}

function samePath(left: number[], right: number[]) {
	return (
		left.length === right.length &&
		left.every((segment, index) => segment === right[index])
	);
}

function blockText(leaves: TextLeaf[]) {
	return leaves.map((leaf) => leaf.text).join("");
}

function capturePoint(value: Value, point: Point): MarkdownPointBookmark {
	const blockIndex = point.path[0] ?? 0;
	const leaves = textLeaves(value, blockIndex);
	const leafIndex = leaves.findIndex((leaf) => samePath(leaf.path, point.path));
	const precedingLength = leaves
		.slice(0, Math.max(0, leafIndex))
		.reduce((sum, leaf) => sum + leaf.text.length, 0);
	const leaf = leafIndex >= 0 ? leaves[leafIndex] : undefined;
	const offset = Math.max(0, Math.min(point.offset, leaf?.text.length ?? 0));
	const blockOffset =
		leafIndex >= 0
			? precedingLength + offset
			: Math.max(0, Math.min(point.offset, blockText(leaves).length));
	const text = blockText(leaves);

	return {
		path: [...point.path],
		offset,
		blockIndex,
		blockOffset,
		before: text.slice(Math.max(0, blockOffset - CONTEXT_RADIUS), blockOffset),
		after: text.slice(blockOffset, blockOffset + CONTEXT_RADIUS),
	};
}

export function captureMarkdownSelectionBookmark(
	value: Value,
	selection: TRange | null,
): MarkdownSelectionBookmark | null {
	if (!selection) return null;
	return {
		anchor: capturePoint(value, selection.anchor),
		focus: capturePoint(value, selection.focus),
	};
}

function pointAtBlockOffset(
	value: Value,
	blockIndex: number,
	offset: number,
): Point | null {
	const leaves = textLeaves(value, blockIndex);
	if (!leaves.length) return null;
	let remaining = Math.max(0, offset);
	for (const leaf of leaves) {
		if (remaining <= leaf.text.length) {
			return {
				path: [...leaf.path],
				offset: remaining,
			};
		}
		remaining -= leaf.text.length;
	}
	const last = leaves.at(-1);
	return last ? { path: [...last.path], offset: last.text.length } : null;
}

function matchingOffsets(
	text: string,
	before: string,
	after: string,
): number[] {
	if (!before && !after) return [];
	const offsets: number[] = [];
	for (let offset = 0; offset <= text.length; offset += 1) {
		if (
			text.slice(Math.max(0, offset - before.length), offset) === before &&
			text.slice(offset, offset + after.length) === after
		) {
			offsets.push(offset);
		}
	}
	return offsets;
}

function resolvePoint(
	value: Value,
	bookmark: MarkdownPointBookmark,
): Point | null {
	let contextual:
		| {
				blockIndex: number;
				offset: number;
				score: number;
		  }
		| undefined;

	for (let blockIndex = 0; blockIndex < value.length; blockIndex += 1) {
		const text = blockText(textLeaves(value, blockIndex));
		for (const offset of matchingOffsets(
			text,
			bookmark.before,
			bookmark.after,
		)) {
			const score =
				Math.abs(blockIndex - bookmark.blockIndex) * 1_000_000 +
				Math.abs(offset - bookmark.blockOffset);
			if (!contextual || score < contextual.score) {
				contextual = { blockIndex, offset, score };
			}
		}
	}
	if (contextual) {
		return pointAtBlockOffset(value, contextual.blockIndex, contextual.offset);
	}

	const sameLeaf = textLeaves(value, bookmark.path[0] ?? 0).find((leaf) =>
		samePath(leaf.path, bookmark.path),
	);
	if (sameLeaf) {
		return {
			path: [...sameLeaf.path],
			offset: Math.min(bookmark.offset, sameLeaf.text.length),
		};
	}

	const sameBlock = pointAtBlockOffset(
		value,
		bookmark.blockIndex,
		bookmark.blockOffset,
	);
	if (sameBlock) return sameBlock;

	for (let blockIndex = value.length - 1; blockIndex >= 0; blockIndex -= 1) {
		const leaves = textLeaves(value, blockIndex);
		const last = leaves.at(-1);
		if (last) return { path: [...last.path], offset: last.text.length };
	}
	return null;
}

export function restoreMarkdownSelectionBookmark(
	value: Value,
	bookmark: MarkdownSelectionBookmark | null,
): TRange | null {
	if (!bookmark) return null;
	const anchor = resolvePoint(value, bookmark.anchor);
	const focus = resolvePoint(value, bookmark.focus);
	return anchor && focus ? { anchor, focus } : null;
}

/**
 * Replace the complete editor value as one history batch and restore the
 * closest logical selection within that same undoable operation.
 */
export function replaceMarkdownEditorValue(
	editor: PlateEditor,
	nextValue: Value,
	bookmark: MarkdownSelectionBookmark | null,
): TRange | null {
	let nextSelection: TRange | null = null;
	editor.tf.withNewBatch(() => {
		editor.tf.setValue(nextValue);
		nextSelection = restoreMarkdownSelectionBookmark(editor.children, bookmark);
		if (nextSelection) editor.tf.select(nextSelection);
	});
	return nextSelection;
}
