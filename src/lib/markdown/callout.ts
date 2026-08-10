import {
	convertChildrenDeserialize,
	convertNodesSerialize,
	type MdRules,
	parseAttributes,
	propsToAttributes,
} from "@platejs/markdown";
import type { SlateEditor, TElement } from "platejs";

type MdNode = {
	type: string;
	value?: string;
	children?: MdNode[];
	calloutType?: string;
	calloutTypeRaw?: string;
	title?: string;
	attributes?: unknown[];
	position?: {
		start?: { offset?: number };
	};
};

type RemarkFile = {
	value?: unknown;
};

type CalloutMarker = {
	type: string;
	typeRaw: string;
	title?: string;
};

const CALLOUT_MARKER_RE = /^\[!([A-Za-z0-9_-]+)\](?:[ \t]+(.*?))?[ \t]*$/;

export function parseCalloutMarker(line: string): CalloutMarker | null {
	const match = line.match(CALLOUT_MARKER_RE);
	if (!match) return null;
	const typeRaw = match[1];
	const title = match[2]?.trim();
	return {
		type: typeRaw.toLowerCase(),
		typeRaw,
		...(title ? { title } : {}),
	};
}

function calloutFromBlockquote(node: MdNode, source: string): MdNode | null {
	if (node.type !== "blockquote") return null;
	const firstParagraph = node.children?.[0];
	const firstText = firstParagraph?.children?.[0];
	if (
		firstParagraph?.type !== "paragraph" ||
		firstText?.type !== "text" ||
		typeof firstText.value !== "string"
	) {
		return null;
	}
	const sourceOffset = firstText.position?.start?.offset;
	if (
		sourceOffset !== undefined &&
		source.slice(sourceOffset, sourceOffset + 2) === "\\["
	) {
		return null;
	}

	const newline = firstText.value.indexOf("\n");
	const header =
		newline < 0 ? firstText.value : firstText.value.slice(0, newline);
	const marker = parseCalloutMarker(header);
	if (!marker) return null;

	const body = [...(node.children ?? [])];
	if (newline < 0) {
		const paragraphChildren = firstParagraph.children ?? [];
		if (paragraphChildren.length === 1) {
			body.shift();
		} else if (paragraphChildren[1]?.type === "break") {
			const bodyChildren = paragraphChildren.slice(2);
			if (bodyChildren.length) {
				body[0] = { ...firstParagraph, children: bodyChildren };
			} else {
				body.shift();
			}
		} else {
			return null;
		}
	} else {
		const bodyPrefix = firstText.value.slice(newline + 1);
		const paragraphChildren = [...(firstParagraph.children ?? [])];
		if (bodyPrefix) {
			paragraphChildren[0] = { ...firstText, value: bodyPrefix };
		} else {
			paragraphChildren.shift();
		}
		if (paragraphChildren.length) {
			body[0] = { ...firstParagraph, children: paragraphChildren };
		} else {
			body.shift();
		}
	}

	return {
		type: "callout",
		calloutType: marker.type,
		calloutTypeRaw: marker.typeRaw,
		...(marker.title ? { title: marker.title } : {}),
		children: body,
	};
}

function transformTree(
	node: MdNode,
	transform: (child: MdNode) => MdNode | null,
): void {
	if (!node.children) return;
	node.children = node.children.map((child) => {
		const replacement = transform(child);
		if (replacement) return replacement;
		transformTree(child, transform);
		return child;
	});
}

/**
 * Translate Obsidian blockquote markers into a portable mdast callout.
 * Serialization emits blockquote mdast directly from the callout rule below.
 */
export function remarkObsidianCallout() {
	return (tree: MdNode, file: RemarkFile) => {
		const source =
			typeof file?.value === "string"
				? file.value
				: file?.value
					? String(file.value)
					: "";
		transformTree(tree, (node) => calloutFromBlockquote(node, source));
	};
}

export const obsidianCalloutRules = {
	callout: {
		deserialize: (node, deco, options) => {
			const children = convertChildrenDeserialize(
				node.children ?? [],
				deco,
				options,
			);
			if (!node.calloutType && node.attributes) {
				return {
					type: "callout",
					...parseAttributes(node.attributes),
					children: children.length
						? children
						: [{ type: "p", children: [{ text: "" }] }],
				};
			}
			return {
				type: "callout",
				calloutType: node.calloutType,
				calloutTypeRaw: node.calloutTypeRaw,
				title: node.title,
				children: children.length
					? children
					: [{ type: "p", children: [{ text: "" }] }],
			};
		},
		serialize: (node, options) => {
			if (!node.calloutType && !node.calloutTypeRaw) {
				const { children, type: _type, ...props } = node;
				return {
					type: "mdxJsxFlowElement",
					name: "callout",
					attributes: propsToAttributes(props),
					children: convertNodesSerialize(children, options),
				};
			}
			const typeRaw = node.calloutTypeRaw || node.calloutType || "note";
			const title = node.title ? ` ${node.title}` : "";
			return {
				type: "blockquote",
				children: [
					{
						type: "paragraph",
						children: [{ type: "html", value: `[!${typeRaw}]${title}` }],
					},
					...convertNodesSerialize(node.children, options),
				],
			};
		},
	},
} satisfies MdRules;

export function updateCalloutMetadata(
	editor: SlateEditor,
	element: TElement,
	metadata: { title: string; typeRaw: string },
): boolean {
	const marker = parseCalloutMarker(`[!${metadata.typeRaw.trim()}]`);
	const path = editor.api.findPath(element);
	if (!marker || !path) return false;

	editor.tf.setNodes(
		{
			calloutType: marker.type,
			calloutTypeRaw: marker.typeRaw,
			title: metadata.title.trim() || undefined,
		},
		{ at: path },
	);
	return true;
}
