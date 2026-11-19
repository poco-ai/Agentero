/**
 * `==highlight==` → `<mark>` for the Streamdown render surfaces.
 *
 * The shared scanner (`highlight-scan.ts`) already drives the note editor, but
 * a Streamdown render has no mark syntax: the delimiters reach the reader
 * literally (#1168). Rewriting each highlight run into `html` mdast nodes lets
 * the surface's `allowedTags` pipeline (`<mark>` allowed) paint it through the
 * same raw → sanitize path as model-authored `<u>` / `<mark>`, so agent
 * replies, PDF ask cards and Plaza details no longer show `==`.
 *
 * Only text nodes are rewritten, so inline/fenced code and existing HTML keep
 * their source. A run cannot span adjacent nodes (`==a *b* c==` stays literal),
 * matching the scanner's note-editor behavior; `<mark>` covers mixed content.
 */

import { splitHighlightText } from "@/lib/markdown/highlight-scan";

type MarkdownNode = {
	type: string;
	value?: string;
	children?: MarkdownNode[];
};

function rewriteChildren(node: MarkdownNode): void {
	const children = node.children;
	if (!children) return;
	const next: MarkdownNode[] = [];
	for (const child of children) {
		if (child.type === "text" && typeof child.value === "string") {
			const runs = splitHighlightText(child.value);
			if (runs.length === 0) continue;
			if (!runs.some((run) => run.highlight)) {
				// Keep the original node (and its position data) when untouched.
				next.push(child);
				continue;
			}
			for (const run of runs) {
				if (!run.highlight) {
					next.push({ type: "text", value: run.text });
					continue;
				}
				next.push({ type: "html", value: "<mark>" });
				next.push({ type: "text", value: run.text });
				next.push({ type: "html", value: "</mark>" });
			}
			continue;
		}
		rewriteChildren(child);
		next.push(child);
	}
	node.children = next;
}

/**
 * Remark plugin that replaces `==…==` runs inside text nodes with raw
 * `<mark>` markers. It is a no-op for trees without delimiters, so unrelated
 * blocks stay byte-identical.
 */
export function remarkHighlightToHtml() {
	return (tree: MarkdownNode): void => {
		rewriteChildren(tree);
	};
}
