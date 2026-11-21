import { splitHighlightText } from "@/lib/markdown/highlight-scan";

/**
 * Markdown has no native underline/highlight syntax. The note editor persists
 * them as MDX elements (`<mark>`, `<u>`, `<sub>`, `<sup>`, `<kbd>`) and
 * `@platejs/markdown` maps the same names to Plate marks, so these two remark
 * passes make both spellings readable in the editor:
 *
 * - `remarkHighlightMark` turns `==文字==` prose into highlight marks on open
 *   (#1168/#1170); before it, a saved `==…==` reopened as literal text and was
 *   escaped as `\==` on the next save.
 * - `remarkRecoverInlineHtmlMarks` degrades inline HTML marks to real mdast
 *   marks when the document is re-parsed without MDX (the recovery path for a
 *   malformed tag). Plate otherwise flattens `<mark>x</mark>` into literal
 *   text, so the next save escapes the tags.
 */

type MdNode = {
	type: string;
	value?: string;
	children?: MdNode[];
};

type BareTag = {
	closing: boolean;
	name: string;
	selfClosing: boolean;
};

/** mdast type of each supported inline HTML mark (same name as the tag). */
const INLINE_MARK_TAGS = new Set(["u", "mark", "sub", "sup", "kbd"]);

/** A complete bare tag: no attributes, so nothing is dropped by recovery. */
const BARE_TAG = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)\s*(\/?)>$/;

/**
 * Containers whose children are inline content. Recovery only wraps inline
 * siblings; block containers are skipped so a stray `<mark>` HTML *block* can
 * never swallow a following paragraph.
 */
const PHRASING_CONTAINERS = new Set([
	"paragraph",
	"heading",
	"tableCell",
	"emphasis",
	"strong",
	"delete",
	"link",
	"linkReference",
	"mark",
	"u",
	"sub",
	"sup",
	"kbd",
	"underline",
	"subscript",
	"superscript",
	"mdxJsxTextElement",
]);

function highlightRuns(value: string): MdNode[] {
	return splitHighlightText(value).map((run) =>
		run.highlight
			? { type: "mark", children: [{ type: "text", value: run.text }] }
			: { type: "text", value: run.text },
	);
}

function transformHighlight(node: MdNode): void {
	if (!node.children) return;
	node.children = node.children.flatMap((child) => {
		if (
			child.type === "text" &&
			typeof child.value === "string" &&
			child.value.includes("==")
		) {
			return highlightRuns(child.value);
		}
		transformHighlight(child);
		return [child];
	});
}

/**
 * Parse `==文字==` in text nodes as highlight. Only `text` nodes carry prose;
 * code / inline code / math / raw html are leaf `value` nodes, so the
 * children walk never touches them.
 */
export function remarkHighlightMark() {
	return (tree: MdNode) => {
		transformHighlight(tree);
	};
}

function readBareTag(node: MdNode): BareTag | null {
	if (node.type !== "html" || typeof node.value !== "string") return null;
	const match = BARE_TAG.exec(node.value);
	if (!match) return null;
	return {
		closing: match[1] === "/",
		name: (match[2] ?? "").toLowerCase(),
		selfClosing: match[3] === "/",
	};
}

/** Index of the `</name>` html node matching the opener at `from - 1`. */
function findClosingTag(
	children: MdNode[],
	from: number,
	name: string,
): number {
	let depth = 1;
	for (let index = from; index < children.length; index += 1) {
		const tag = readBareTag(children[index] as MdNode);
		if (!tag || tag.name !== name) continue;
		if (tag.closing) {
			depth -= 1;
			if (depth === 0) return index;
		} else if (!tag.selfClosing) {
			depth += 1;
		}
	}
	return -1;
}

/**
 * Wrap the siblings between `<tag>` and its matching `</tag>` into an mdast
 * mark. Nested supported tags recurse; unmatched tags stay literal HTML.
 */
function recoverInlineChildren(children: MdNode[]): MdNode[] {
	const output: MdNode[] = [];
	for (let index = 0; index < children.length; index += 1) {
		const child = children[index] as MdNode;
		const tag = readBareTag(child);
		if (!tag) {
			output.push(child);
			continue;
		}
		if (tag.name === "br" && !tag.closing) {
			output.push({ type: "break" });
			continue;
		}
		if (tag.closing || tag.selfClosing || !INLINE_MARK_TAGS.has(tag.name)) {
			output.push(child);
			continue;
		}
		const closing = findClosingTag(children, index + 1, tag.name);
		if (closing < 0) {
			output.push(child);
			continue;
		}
		output.push({
			type: tag.name,
			children: recoverInlineChildren(children.slice(index + 1, closing)),
		});
		index = closing;
	}
	return output;
}

function recoverTree(node: MdNode): void {
	if (!node.children) return;
	if (PHRASING_CONTAINERS.has(node.type)) {
		node.children = recoverInlineChildren(node.children);
	}
	for (const child of node.children) recoverTree(child);
}

/**
 * Recover inline HTML marks in a remark tree parsed without `remarkMdx`.
 *
 * Without MDX, `<u>x</u>` / `<mark>x</mark>` / `<sub>` / `<sup>` / `<kbd>` are
 * raw `html` mdast nodes that Plate flattens to literal text — and the next
 * save escapes the tags. Only the no-MDX fallback pipeline uses this plugin;
 * the normal pipeline parses the same tags as MDX elements.
 */
export function remarkRecoverInlineHtmlMarks() {
	return (tree: MdNode) => {
		recoverTree(tree);
	};
}
