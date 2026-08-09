"use client";

import {
	KEYS,
	PathApi,
	RangeApi,
	type SlateEditor,
	type TElement,
} from "platejs";
import { createPlatePlugin } from "platejs/react";
import { CalloutElement } from "@/components/editor/nodes/block/callout-node";
import { parseCalloutMarker } from "@/lib/markdown/callout";

export const CalloutPlugin = createPlatePlugin({
	key: KEYS.callout,
	node: { isElement: true },
})
	.withComponent(CalloutElement)
	.overrideEditor(({ editor, tf: { insertBreak } }) => ({
		transforms: {
			insertBreak() {
				if (insertCalloutParagraphBreak(editor)) return;
				insertBreak();
			},
			selectAll() {
				const documentRange = editor.api.range([]);
				if (!documentRange) return true;
				if (
					!editor.selection ||
					!RangeApi.equals(editor.selection, documentRange)
				) {
					editor.tf.select(documentRange);
				}
				return true;
			},
		},
	}));

/**
 * Keep a normal paragraph break inside its owning callout. Other child blocks
 * (lists, nested quotes, etc.) retain their plugin-specific Enter behavior.
 */
export function insertCalloutParagraphBreak(editor: SlateEditor): boolean {
	const selection = editor.selection;
	if (!selection) return false;

	const callout = editor.api.above({
		match: { type: editor.getType(KEYS.callout) },
	});
	const paragraph = editor.api.above({
		match: { type: editor.getType(KEYS.p) },
	});
	if (
		!callout ||
		!paragraph ||
		!PathApi.isParent(callout[1], paragraph[1]) ||
		(paragraph[0] as TElement & { listStyleType?: string }).listStyleType
	) {
		return false;
	}

	editor.tf.splitNodes({
		always: true,
		at: selection,
		match: { type: editor.getType(KEYS.p) },
	});
	return true;
}

/**
 * Convert a complete marker in the current blockquote into a callout body.
 * The marker becomes element metadata and the selection moves into a fresh
 * paragraph, so the same Enter keystroke continues the user's flow.
 */
export function convertBlockquoteMarkerToCallout(editor: SlateEditor): boolean {
	const selection = editor.selection;
	if (!selection || !RangeApi.isCollapsed(selection)) return false;
	const blockquote = editor.api.above({
		match: { type: editor.getType(KEYS.blockquote) },
	});
	if (!blockquote || !editor.api.isEnd(selection.anchor, blockquote[1])) {
		return false;
	}

	const marker = parseCalloutMarker(editor.api.string(blockquote[1]));
	if (!marker) return false;
	const bodyPoint = { path: [...blockquote[1], 0, 0], offset: 0 };
	editor.tf.withoutNormalizing(() => {
		editor.tf.replaceNodes(
			{
				type: editor.getType(KEYS.callout),
				calloutType: marker.type,
				calloutTypeRaw: marker.typeRaw,
				...(marker.title ? { title: marker.title } : {}),
				children: [
					{
						type: editor.getType(KEYS.p),
						children: [{ text: "" }],
					},
				],
			},
			{ at: blockquote[1] },
		);
		editor.tf.select({ anchor: bodyPoint, focus: bodyPoint });
	});
	return true;
}
