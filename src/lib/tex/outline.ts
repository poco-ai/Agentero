/**
 * Outline of the open TeX buffer, read from the codemirror-lang-latex
 * syntax tree (the same Lezer grammar the editor already uses for
 * highlighting and folding). Sections follow LaTeX Workshop's default
 * hierarchy. `\input` / `\include` / `\subfile` stay file rows — child
 * files are not parsed into this tree.
 */

import { joinPath } from "@/lib/core/path";
import { plainTexTitle } from "@/lib/tex/plain-title";
import { customTexSections } from "@/lib/tex/section-defs";

/**
 * The slice of a Lezer node this walk needs. Declared locally so the
 * outline does not depend on `@lezer/common` (it is not a direct dependency;
 * the editor's syntax tree satisfies this shape).
 */
type OutlineNode = {
	name: string;
	from: number;
	to: number;
	firstChild: OutlineNode | null;
	nextSibling: OutlineNode | null;
};

/** part → subsubsection. Paragraph and below stay out of the outline. */
const SECTION_LEVELS: Record<string, number> = {
	Part: 0,
	Chapter: 0,
	Section: 1,
	SubSection: 2,
	SubSubSection: 3,
};
const SECTION_NODES = new Set(Object.keys(SECTION_LEVELS));

const FILE_NODES = new Set(["Input", "Include", "Subfile"]);

export type TexOutlineItem = {
	id: string;
	kind: "section" | "file" | "figure" | "table" | "label";
	/** Absolute source file for a project-wide outline item. */
	path?: string;
	/** Nesting under ancestor sections. Top-level rows are 0. */
	indent: number;
	/** Heading rank for section rows: part/chapter 0 … subsubsection 3. */
	level?: number;
	title: string;
	/** 1-based line of the command. */
	line: number;
	/** Path argument as written, for file rows. */
	fileArg?: string;
};

export type TexOutlineDoc = {
	lineAt(pos: number): { number: number };
	sliceString(from: number, to: number): string;
};

function childNamed(node: OutlineNode, name: string): OutlineNode | null {
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (child.name === name) return child;
	}
	return null;
}

function descendantNamed(node: OutlineNode, name: string): OutlineNode | null {
	const direct = childNamed(node, name);
	if (direct) return direct;
	for (let child = node.firstChild; child; child = child.nextSibling) {
		const found = descendantNamed(child, name);
		if (found) return found;
	}
	return null;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function displayTitle(text: string): string {
	const plain = plainTexTitle(oneLine(text));
	return plain || oneLine(text);
}

function sectionTitle(node: OutlineNode, doc: TexOutlineDoc): string {
	const command = childNamed(node, "SectioningCommand") ?? node;
	const arg = descendantNamed(command, "LongArg");
	if (arg) {
		const title = displayTitle(doc.sliceString(arg.from, arg.to));
		if (title) return title;
	}
	const ctrl = command.firstChild;
	if (ctrl) return oneLine(doc.sliceString(ctrl.from, ctrl.to));
	return node.name;
}

function fileArgument(node: OutlineNode, doc: TexOutlineDoc): string {
	const literal = descendantNamed(node, "LiteralArgContent");
	if (!literal) return "";
	return doc.sliceString(literal.from, literal.to).trim();
}

function pushItem(
	out: TexOutlineItem[],
	node: OutlineNode,
	doc: TexOutlineDoc,
	indent: number,
	kind: TexOutlineItem["kind"],
	title: string,
	extra?: { level?: number; fileArg?: string },
) {
	out.push({
		id: `${kind}:${node.from}`,
		kind,
		indent,
		...(extra?.level === undefined ? {} : { level: extra.level }),
		title,
		line: doc.lineAt(node.from).number,
		...(extra?.fileArg ? { fileArg: extra.fileArg } : {}),
	});
}

function walk(
	node: OutlineNode,
	doc: TexOutlineDoc,
	indent: number,
	out: TexOutlineItem[],
) {
	if (node.name === "FigureEnvironment" || node.name === "TableEnvironment") {
		const caption = descendantNamed(node, "Caption");
		const arg = caption && descendantNamed(caption, "LongArg");
		const kind = node.name === "FigureEnvironment" ? "figure" : "table";
		pushItem(
			out,
			node,
			doc,
			indent,
			kind,
			arg
				? displayTitle(doc.sliceString(arg.from, arg.to))
				: `\\begin{${kind}}`,
		);
		for (let child = node.firstChild; child; child = child.nextSibling) {
			walk(child, doc, indent + 1, out);
		}
		return;
	}
	if (node.name === "Label") {
		const arg =
			descendantNamed(node, "LiteralArgContent") ??
			descendantNamed(node, "ShortArg");
		if (arg)
			pushItem(
				out,
				node,
				doc,
				indent,
				"label",
				doc.sliceString(arg.from, arg.to).trim(),
			);
		return;
	}
	if (SECTION_NODES.has(node.name)) {
		pushItem(out, node, doc, indent, "section", sectionTitle(node, doc), {
			level: SECTION_LEVELS[node.name],
		});
		// Only the body. The title argument can itself contain `\input`,
		// and that belongs in the heading text, not as its own row.
		const content = childNamed(node, "Content");
		if (content) walk(content, doc, indent + 1, out);
		return;
	}
	if (FILE_NODES.has(node.name)) {
		const fileArg = fileArgument(node, doc);
		if (fileArg) {
			pushItem(out, node, doc, indent, "file", fileArg, { fileArg });
		}
		return;
	}
	for (let child = node.firstChild; child; child = child.nextSibling) {
		walk(child, doc, indent, out);
	}
}

function indentFor(
	items: readonly TexOutlineItem[],
	before: number,
	level: number,
): number {
	for (let index = before - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item?.kind === "section" && (item.level ?? 0) < level)
			return item.indent + 1;
	}
	return 0;
}

/** Document-order outline. `root` is the parse tree's top node. */
export function texOutlineFromTree(
	root: OutlineNode,
	doc: TexOutlineDoc,
): TexOutlineItem[] {
	const items: TexOutlineItem[] = [];
	walk(root, doc, 0, items);
	const source = doc.sliceString(0, root.to);
	for (const section of customTexSections(source)) {
		let index = items.findIndex((item) => item.line > section.line);
		if (index < 0) index = items.length;
		const duplicate = items.some(
			(item) => item.kind === "section" && item.line === section.line,
		);
		if (duplicate) continue;
		items.splice(index, 0, {
			id: `section:${section.from}`,
			kind: "section",
			indent: indentFor(items, index, section.level),
			level: section.level,
			title: section.title,
			line: section.line,
		});
	}
	return items;
}

/**
 * The last section at or above the cursor. File rows do not take the
 * highlight — the cursor is "in" the enclosing section.
 */
export function activeOutlineSectionId(
	items: readonly TexOutlineItem[],
	cursorLine: number,
	path?: string,
): string | null {
	let id: string | null = null;
	for (const item of items) {
		if (
			item.kind === "section" &&
			item.line <= cursorLine &&
			(!path || !item.path || item.path === path)
		)
			id = item.id;
	}
	return id;
}

/**
 * Resolve an `\input` / `\include` / `\subfile` argument against the
 * file that contains the command. A missing extension becomes `.tex`.
 * The parent keeps its own separator so Windows paths stay consistent.
 */
export function resolveTexInputPath(texFile: string, arg: string): string {
	const cleaned = arg.trim().replace(/^["']|["']$/g, "");
	if (!cleaned) return "";
	const withExt = /\.[A-Za-z0-9]+$/.test(cleaned) ? cleaned : `${cleaned}.tex`;
	if (
		withExt.startsWith("/") ||
		withExt.startsWith("\\") ||
		/^[A-Za-z]:[\\/]/.test(withExt)
	) {
		return withExt;
	}
	const slash = Math.max(texFile.lastIndexOf("/"), texFile.lastIndexOf("\\"));
	const parent =
		slash < 0 ? "" : slash === 0 ? texFile[0] : texFile.slice(0, slash);
	return joinPath(parent, withExt);
}
