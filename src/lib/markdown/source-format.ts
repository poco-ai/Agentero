import {
	ChangeSet,
	EditorSelection,
	type EditorState,
	type Text,
	type TransactionSpec,
} from "@codemirror/state";

export type MarkdownSourceFormat =
	| "bold"
	| "italic"
	| "underline"
	| "strikethrough"
	| "code"
	| "highlight"
	| "heading1"
	| "heading2"
	| "heading3"
	| "quote"
	| "bulletList"
	| "orderedList"
	| "todoList";

type InlineMark = { open: string; close: string };

const inlineMarks: Partial<Record<MarkdownSourceFormat, InlineMark>> = {
	bold: { open: "**", close: "**" },
	italic: { open: "*", close: "*" },
	underline: { open: "<u>", close: "</u>" },
	strikethrough: { open: "~~", close: "~~" },
	code: { open: "`", close: "`" },
	highlight: { open: "==", close: "==" },
};

type LineFormat = {
	prefix: string;
	kind: "heading" | "quote" | "bullet" | "ordered" | "todo";
	level?: number;
};

const lineFormats: Partial<Record<MarkdownSourceFormat, LineFormat>> = {
	heading1: { prefix: "# ", kind: "heading", level: 1 },
	heading2: { prefix: "## ", kind: "heading", level: 2 },
	heading3: { prefix: "### ", kind: "heading", level: 3 },
	quote: { prefix: "> ", kind: "quote" },
	bulletList: { prefix: "- ", kind: "bullet" },
	orderedList: { prefix: "1. ", kind: "ordered" },
	todoList: { prefix: "- [ ] ", kind: "todo" },
};

/** Keymap entries for the formatting commands shared with the toolbar. */
export const sourceFormatKeymap: readonly {
	key: string;
	format: MarkdownSourceFormat;
}[] = [
	{ key: "Mod-b", format: "bold" },
	{ key: "Mod-i", format: "italic" },
	{ key: "Mod-u", format: "underline" },
	{ key: "Mod-Shift-x", format: "strikethrough" },
];

type ExistingPrefix = {
	kind: LineFormat["kind"];
	prefix: string;
	level?: number;
};

const todoPrefix = /^[-*+]\s+\[[ xX]\]\s+/;
const headingPrefix = /^(#{1,6})\s+/;
const quotePrefix = /^>\s?/;
const orderedPrefix = /^\d+[.)]\s+/;
const bulletPrefix = /^[-*+]\s+/;

function prefixAt(line: string): ExistingPrefix | null {
	let match = todoPrefix.exec(line);
	if (match) return { kind: "todo", prefix: match[0] };
	match = headingPrefix.exec(line);
	if (match)
		return { kind: "heading", prefix: match[0], level: match[1].length };
	match = quotePrefix.exec(line);
	if (match) return { kind: "quote", prefix: match[0] };
	match = orderedPrefix.exec(line);
	if (match) return { kind: "ordered", prefix: match[0] };
	match = bulletPrefix.exec(line);
	if (match) return { kind: "bullet", prefix: match[0] };
	return null;
}

function markersAround(
	doc: Text,
	from: number,
	to: number,
	mark: InlineMark,
): boolean {
	const before =
		from >= mark.open.length
			? doc.sliceString(from - mark.open.length, from)
			: "";
	const after =
		to + mark.close.length <= doc.length
			? doc.sliceString(to, to + mark.close.length)
			: "";
	return before === mark.open && after === mark.close;
}

function selectionHasMarkers(selected: string, mark: InlineMark): boolean {
	if (
		selected.length < mark.open.length + mark.close.length ||
		!selected.startsWith(mark.open) ||
		!selected.endsWith(mark.close)
	)
		return false;
	// `*` must not match the outer half of a `**` pair.
	if (mark.open.length === 1 && selected.startsWith(mark.open + mark.open))
		return false;
	if (mark.close.length === 1 && selected.endsWith(mark.close + mark.close))
		return false;
	return true;
}

function inlineTransaction(
	state: EditorState,
	mark: InlineMark,
): TransactionSpec {
	const doc = state.doc;
	const { from, to } = state.selection.main;
	const selected = doc.sliceString(from, to);

	if (selectionHasMarkers(selected, mark)) {
		return {
			changes: [
				{ from, to: from + mark.open.length },
				{ from: to - mark.close.length, to },
			],
			selection: EditorSelection.single(
				from,
				to - mark.open.length - mark.close.length,
			),
		};
	}

	if (markersAround(doc, from, to, mark)) {
		return {
			changes: [
				{ from: from - mark.open.length, to: from },
				{ from: to, to: to + mark.close.length },
			],
			selection: EditorSelection.single(
				from - mark.open.length,
				to - mark.open.length,
			),
		};
	}

	if (from === to) {
		return {
			changes: { from, insert: mark.open + mark.close },
			selection: EditorSelection.cursor(from + mark.open.length),
		};
	}

	return {
		changes: [
			{ from, insert: mark.open },
			{ from: to, insert: mark.close },
		],
		selection: EditorSelection.single(
			from + mark.open.length,
			to + mark.open.length,
		),
	};
}

function lineTransaction(
	state: EditorState,
	format: LineFormat,
): TransactionSpec {
	const main = state.selection.main;
	const lastPos =
		!main.empty && state.doc.lineAt(main.to).from === main.to
			? main.to - 1
			: main.to;
	const firstLine = state.doc.lineAt(main.from);
	const lastLine = state.doc.lineAt(lastPos);
	const changes: {
		from: number;
		to?: number;
		insert?: string;
	}[] = [];

	for (let number = firstLine.number; number <= lastLine.number; number += 1) {
		const line = state.doc.line(number);
		const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
		const body = line.text.slice(indent.length);
		const existing = prefixAt(body);
		const remove =
			existing?.kind === format.kind &&
			(format.kind !== "heading" || existing.level === format.level);
		changes.push({
			from: line.from + indent.length,
			to: line.from + indent.length + (existing?.prefix.length ?? 0),
			insert: remove ? "" : format.prefix,
		});
	}

	const changeSet = ChangeSet.of(changes, state.doc.length);
	const from = changeSet.mapPos(main.from, 1);
	const to = main.empty ? from : changeSet.mapPos(main.to, -1);
	return {
		changes,
		selection: EditorSelection.single(from, to),
	};
}

/**
 * Compute the Markdown edit for a source-mode formatting command. Inline marks
 * wrap (or unwrap) the selection; block commands toggle or replace the prefix
 * on every touched line.
 */
export function sourceFormatTransaction(
	state: EditorState,
	format: MarkdownSourceFormat,
): TransactionSpec | null {
	const mark = inlineMarks[format];
	if (mark) return inlineTransaction(state, mark);
	const line = lineFormats[format];
	if (line) return lineTransaction(state, line);
	return null;
}
