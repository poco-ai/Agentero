/**
 * Pure caret projection between a rendered block and its Markdown source
 * slice. Callers own DOM measurement and scrolling; this module only decides
 * which character the caret should land on.
 */

import type { TElement } from "platejs";
import type { PlateEditor } from "platejs/react";

import {
	blockPointAtTextOffset,
	blockTextOffsetOfPoint,
	projectBlockSource,
	readBlockTextMap,
	sourceCaretToTextOffset,
	sourcePositionOfTextOffset,
} from "@/lib/markdown/block-caret-map";

export type CaretPoint = { path: number[]; offset: number };

export type SourceCaret = { line: number; column: number };

/** Block source lines between two 1-based line numbers (end exclusive). */
export function sourceLinesOf(
	raw: string,
	startLine: number,
	endLine: number,
): string[] {
	const lines = raw.replace(/\r\n?/g, "\n").split("\n");
	const from = Math.max(0, startLine - 1);
	const to = Math.max(from, endLine - 1);
	return lines.slice(from, to);
}

/** Exact source caret for the Plate caret inside `block`, or null. */
export function sourceCaretInBlock(
	editor: PlateEditor,
	block: TElement,
	blockIndex: number,
	raw: string,
	startLine: number,
	endLine: number,
): SourceCaret | null {
	const focus = editor.selection?.focus;
	if (!focus || focus.path[0] !== blockIndex) return null;
	const map = readBlockTextMap(block);
	if (!map) return null;
	const offset = blockTextOffsetOfPoint(map, focus.path.slice(1), focus.offset);
	if (offset === null) return null;
	const projection = projectBlockSource(sourceLinesOf(raw, startLine, endLine));
	if (!projection || projection.text !== map.text) return null;
	const position = sourcePositionOfTextOffset(projection, offset);
	return { line: startLine + position.line, column: position.column };
}

/** Plate point for a source caret, or null when the block cannot map. */
export function renderedPointAtSource(
	block: TElement,
	blockIndex: number,
	raw: string,
	startLine: number,
	endLine: number,
	line: number,
	column: number,
): CaretPoint | null {
	const map = readBlockTextMap(block);
	if (!map) return null;
	const projection = projectBlockSource(sourceLinesOf(raw, startLine, endLine));
	if (!projection || projection.text !== map.text) return null;
	const offset = sourceCaretToTextOffset(projection, line - startLine, column);
	const point = blockPointAtTextOffset(map, offset);
	return point
		? { path: [blockIndex, ...point.path], offset: point.offset }
		: null;
}
