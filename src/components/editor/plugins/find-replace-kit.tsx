"use client";

import { FindReplacePlugin } from "@platejs/find-replace";
import type {
	Path,
	Point,
	SlateEditor,
	TElement,
	TNode,
	TRange,
} from "platejs";
import { ElementApi, NodeApi, PathApi } from "platejs";
import { createPlatePlugin } from "platejs/react";
import {
	SearchHighlightActiveLeaf,
	SearchHighlightLeaf,
} from "@/components/editor/nodes/leaf";

/** Lowest-level block: contains text / inline children only. */
function isLeafBlock(editor: SlateEditor, node: TNode): node is TElement {
	return (
		ElementApi.isElement(node) &&
		editor.api.isBlock(node) &&
		!node.children.some(
			(child) => ElementApi.isElement(child) && editor.api.isBlock(child),
		)
	);
}

/**
 * Case-insensitive matches inside one leaf block, across adjacent leaves and
 * inline elements (links, wikilinks) — the stock plugin decorate skips blocks
 * containing inline elements, so both decoration and navigation use this.
 */
function blockSearchMatches(
	block: TElement,
	blockPath: Path,
	search: string,
): TRange[] {
	const texts = [...NodeApi.texts(block)];
	if (texts.length === 0) return [];
	const bounds: { path: Path; start: number; end: number }[] = [];
	let pos = 0;
	for (const [text, relativePath] of texts) {
		bounds.push({
			end: pos + text.text.length,
			path: [...blockPath, ...relativePath],
			start: pos,
		});
		pos += text.text.length;
	}
	const content = texts
		.map(([text]) => text.text)
		.join("")
		.toLowerCase();
	const query = search.toLowerCase();
	const pointAt = (offset: number): Point => {
		const segment =
			bounds.find((b) => offset <= b.end) ?? bounds[bounds.length - 1];
		return { offset: offset - segment.start, path: segment.path };
	};
	const matches: TRange[] = [];
	let index = content.indexOf(query);
	while (index !== -1) {
		matches.push({
			anchor: pointAt(index),
			focus: pointAt(index + query.length),
		});
		index = content.indexOf(query, index + query.length);
	}
	return matches;
}

/** All matches of `search` in document order. */
export function findSearchMatches(
	editor: SlateEditor,
	search: string,
): TRange[] {
	if (!search) return [];
	const matches: TRange[] = [];
	for (const [node, path] of editor.api.nodes<TElement>({
		at: [],
		match: (n) => isLeafBlock(editor, n),
	})) {
		matches.push(...blockSearchMatches(node, path, search));
	}
	return matches;
}

/** Distinct decoration for the current match while navigating. */
export const ActiveSearchHighlightPlugin = createPlatePlugin({
	decorate: ({ editor, entry: [node, path], getOptions, type }) => {
		const { activeMatch } = getOptions();
		if (
			!activeMatch ||
			!isLeafBlock(editor, node) ||
			!PathApi.isAncestor(path, activeMatch.anchor.path)
		) {
			return [];
		}
		return [{ ...activeMatch, [type]: true }];
	},
	key: "search_highlight_active",
	node: { component: SearchHighlightActiveLeaf, isLeaf: true },
	options: { activeMatch: null as TRange | null },
});

export const FindReplaceKit = [
	FindReplacePlugin.configure({
		decorate: ({ editor, entry: [node, path], getOptions, type }) => {
			const { search } = getOptions();
			if (!search || !isLeafBlock(editor, node)) return [];
			return blockSearchMatches(node, path, search).map((range) => ({
				...range,
				[type]: true,
			}));
		},
		node: { component: SearchHighlightLeaf },
	}),
	ActiveSearchHighlightPlugin,
];

export { FindReplacePlugin };
