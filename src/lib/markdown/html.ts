import type { MdRules } from "@platejs/markdown";

type MdNode = {
	type: string;
	name?: string;
	value?: string;
	lang?: string;
	children?: MdNode[];
	attributes?: { type?: string; name?: string; value?: unknown }[];
	position?: {
		start?: { offset?: number };
		end?: { offset?: number };
	};
};

type RemarkFile = { value?: unknown };

export const HTML_BLOCK_KEY = "html_block";

/** Tags kept verbatim as HTML instead of being flattened into escaped text. */
const PRESERVED_TAGS = new Set(["div", "center", "iframe"]);

const MDX_ELEMENT_TYPES = new Set(["mdxJsxFlowElement", "mdxJsxTextElement"]);

/**
 * `@platejs/markdown` rewrites `class`/`for` to their JSX spellings before
 * parsing, so undo that when recovering the original source slice.
 */
function toHtmlSource(jsx: string): string {
	return jsx
		.replace(/(\s)className=/g, "$1class=")
		.replace(/(\s)htmlFor=/g, "$1for=");
}

function hasAttribute(node: MdNode, name: string): boolean {
	return (node.attributes ?? []).some((attr) => attr.name === name);
}

function isPreserved(node: MdNode): boolean {
	if (!MDX_ELEMENT_TYPES.has(node.type)) return false;
	const name = node.name ?? "";
	if (PRESERVED_TAGS.has(name)) return true;
	// A bare `<p>` is redundant with Markdown; `<p align>` carries layout.
	return name === "p" && hasAttribute(node, "align");
}

/** A `<p>` with no layout attribute is just a paragraph. */
function isRedundantParagraphTag(node: MdNode): boolean {
	return (
		MDX_ELEMENT_TYPES.has(node.type) &&
		node.name === "p" &&
		!hasAttribute(node, "align")
	);
}

function htmlBlock(node: MdNode, source: string): MdNode | null {
	const start = node.position?.start?.offset;
	const end = node.position?.end?.offset;
	if (start === undefined || end === undefined) return null;
	const raw = source.slice(start, end);
	if (!raw) return null;
	return { type: HTML_BLOCK_KEY, value: toHtmlSource(raw) };
}

/**
 * Remark parses `<div align="center">x</div>` written on one line as an inline
 * JSX element inside a paragraph. Unwrap that paragraph so the HTML lands as a
 * block instead of an element nested inside a paragraph.
 */
function soleMdxChild(node: MdNode): MdNode | null {
	if (node.type !== "paragraph") return null;
	const meaningful = (node.children ?? []).filter(
		(child) => child.type !== "text" || (child.value ?? "").trim() !== "",
	);
	if (meaningful.length !== 1) return null;
	const only = meaningful[0];
	return MDX_ELEMENT_TYPES.has(only.type) ? only : null;
}

function expand(node: MdNode, source: string): MdNode[] | null {
	const inlineOnly = soleMdxChild(node);
	if (inlineOnly) {
		if (isPreserved(inlineOnly)) {
			const block = htmlBlock(inlineOnly, source);
			return block ? [block] : null;
		}
		if (isRedundantParagraphTag(inlineOnly)) {
			return [{ type: "paragraph", children: inlineOnly.children ?? [] }];
		}
		return null;
	}
	if (isPreserved(node)) {
		const block = htmlBlock(node, source);
		return block ? [block] : null;
	}
	if (node.type === "mdxJsxFlowElement" && isRedundantParagraphTag(node)) {
		return node.children ?? [];
	}
	return null;
}

function transformTree(node: MdNode, source: string): void {
	if (!node.children) return;
	node.children = node.children.flatMap((child) => {
		if (child.type === "code" && child.lang?.toLowerCase() === "html") {
			child.value = toHtmlSource(child.value ?? "");
		}
		const next = expand(child, source);
		if (next) return next;
		transformTree(child, source);
		return [child];
	});
}

/**
 * Keep layout-carrying HTML (`<div>`, `<center>`, `<iframe>`, `<p align>`) as a
 * verbatim source slice so saving never escapes it, and unwrap a plain `<p>`
 * into a real paragraph instead of nesting it inside one.
 */
export function remarkPreserveHtml() {
	return (tree: MdNode, file: RemarkFile) => {
		const source = typeof file?.value === "string" ? file.value : "";
		if (!source) return;
		transformTree(tree, source);
	};
}

export const htmlRules = {
	[HTML_BLOCK_KEY]: {
		deserialize: (node: MdNode) => ({
			type: HTML_BLOCK_KEY,
			html: node.value ?? "",
			children: [{ text: "" }],
		}),
		serialize: (node: { html?: string }) => ({
			type: "html",
			value: node.html ?? "",
		}),
	},
} as unknown as MdRules;
