/**
 * Section commands introduced with `\newcommand`, `\def`, or xparse.
 * The outline uses these when the grammar only knows the standard headings.
 */

import { plainTexTitle } from "@/lib/tex/plain-title";
import { texSourceCode } from "@/lib/tex/source";

export type CustomSection = {
	from: number;
	line: number;
	level: number;
	title: string;
};

const LEVEL: Record<string, number> = {
	part: 0,
	chapter: 0,
	section: 1,
	subsection: 2,
	subsubsection: 3,
};

type ArgKind = "star" | "optional" | "required";

type Wrapper = {
	name: string;
	kind: "command" | "environment";
	level: number;
	/** 1-based argument that holds the heading text. */
	argument: number;
	args: ArgKind[];
	from: number;
	to: number;
};

function skipSpace(text: string, index: number): number {
	let cursor = index;
	while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
	return cursor;
}

function readGroup(
	text: string,
	open: number,
): { inner: string; end: number } | null {
	if (text[open] !== "{") return null;
	let depth = 0;
	for (let index = open; index < text.length; index += 1) {
		if (text[index] === "\\") {
			index += 1;
			continue;
		}
		if (text[index] === "{") depth += 1;
		else if (text[index] === "}") {
			depth -= 1;
			if (depth === 0)
				return { inner: text.slice(open + 1, index), end: index + 1 };
		}
	}
	return null;
}

function readName(
	text: string,
	index: number,
): { name: string; end: number } | null {
	let cursor = skipSpace(text, index);
	if (text[cursor] === "{") {
		const group = readGroup(text, cursor);
		if (!group) return null;
		const name = group.inner.trim().replace(/^\\/, "");
		return name ? { name, end: group.end } : null;
	}
	if (text[cursor] === "\\") cursor += 1;
	const match = /^[A-Za-z@]+/.exec(text.slice(cursor));
	if (!match) return null;
	return { name: match[0], end: cursor + match[0].length };
}

function headingArgument(
	body: string,
): { level: number; argument: number } | null {
	const pattern =
		/\\(part|chapter|section|subsection|subsubsection)\*?(?:\s*\[[^\]]*\])?\s*\{([^{}]*)\}/g;
	for (const match of body.matchAll(pattern)) {
		const level = LEVEL[match[1] ?? ""];
		const slot = /#(\d+)/.exec(match[2] ?? "");
		if (level === undefined || !slot) continue;
		return { level, argument: Number(slot[1]) };
	}
	return null;
}

function classicArgs(count: number, optionalDefault: boolean): ArgKind[] {
	if (count <= 0) return [];
	if (!optionalDefault) return Array.from({ length: count }, () => "required");
	return [
		"optional",
		...Array.from({ length: count - 1 }, (): ArgKind => "required"),
	];
}

function xparseArgs(spec: string): ArgKind[] | null {
	const args: ArgKind[] = [];
	for (let index = 0; index < spec.length; index += 1) {
		const token = spec[index];
		if (!token || /\s/.test(token)) continue;
		if (token === "s") args.push("star");
		else if (token === "m") args.push("required");
		else if (token === "o") args.push("optional");
		else if (token === "O" && spec[index + 1] === "{") {
			const group = readGroup(spec, index + 1);
			if (!group) return null;
			args.push("optional");
			index = group.end - 1;
		} else if (token === "+" || token === "!") {
		} else return null;
	}
	return args;
}

function pushWrapper(
	wrappers: Wrapper[],
	from: number,
	name: string,
	kind: Wrapper["kind"],
	body: string,
	args: ArgKind[],
	to: number,
) {
	const heading = headingArgument(body);
	if (!heading || heading.argument < 1 || heading.argument > args.length)
		return;
	if (args[heading.argument - 1] === "star") return;
	wrappers.push({
		name,
		kind,
		level: heading.level,
		argument: heading.argument,
		args,
		from,
		to,
	});
}

function scanWrappers(text: string): Wrapper[] {
	const wrappers: Wrapper[] = [];
	const pattern =
		/\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|newenvironment|renewenvironment|def|gdef|edef|xdef|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|NewDocumentEnvironment|RenewDocumentEnvironment|ProvideDocumentEnvironment|DeclareDocumentEnvironment)\*?/g;
	for (const match of text.matchAll(pattern)) {
		const head = match[1] ?? "";
		const from = match.index ?? 0;
		let cursor = skipSpace(text, from + match[0].length);
		const named = readName(text, cursor);
		if (!named) continue;
		cursor = named.end;
		if (
			head === "NewDocumentCommand" ||
			head === "RenewDocumentCommand" ||
			head === "ProvideDocumentCommand" ||
			head === "DeclareDocumentCommand" ||
			head === "NewDocumentEnvironment" ||
			head === "RenewDocumentEnvironment" ||
			head === "ProvideDocumentEnvironment" ||
			head === "DeclareDocumentEnvironment"
		) {
			cursor = skipSpace(text, cursor);
			const spec = readGroup(text, cursor);
			if (!spec) continue;
			const args = xparseArgs(spec.inner);
			cursor = skipSpace(text, spec.end);
			const body = readGroup(text, cursor);
			if (!args || !body) continue;
			const environment = head.endsWith("Environment");
			pushWrapper(
				wrappers,
				from,
				named.name,
				environment ? "environment" : "command",
				body.inner,
				args,
				body.end,
			);
			continue;
		}
		if (
			head === "def" ||
			head === "gdef" ||
			head === "edef" ||
			head === "xdef"
		) {
			const parameters = /^\s*(?:#\d)+/.exec(text.slice(cursor));
			const count = parameters ? (parameters[0].match(/#/g)?.length ?? 0) : 0;
			cursor += parameters?.[0].length ?? 0;
			cursor = skipSpace(text, cursor);
			const body = readGroup(text, cursor);
			if (!body) continue;
			pushWrapper(
				wrappers,
				from,
				named.name,
				"command",
				body.inner,
				classicArgs(count, false),
				body.end,
			);
			continue;
		}
		const counted = /^\s*\[\s*(\d)\s*\]/.exec(text.slice(cursor));
		const count = counted ? Number(counted[1]) : 0;
		cursor += counted?.[0].length ?? 0;
		const withDefault = /^\s*\[[^\]]*\]/.exec(text.slice(cursor));
		cursor += withDefault?.[0].length ?? 0;
		cursor = skipSpace(text, cursor);
		const body = readGroup(text, cursor);
		if (!body) continue;
		const environment =
			head === "newenvironment" || head === "renewenvironment";
		pushWrapper(
			wrappers,
			from,
			named.name,
			environment ? "environment" : "command",
			body.inner,
			classicArgs(
				count || headingArgument(body.inner)?.argument || 0,
				Boolean(withDefault),
			),
			body.end,
		);
	}
	return wrappers;
}

function readUseArgs(
	text: string,
	index: number,
	args: readonly ArgKind[],
): { values: (string | null)[]; end: number } | null {
	const values: (string | null)[] = [];
	let cursor = index;
	for (const kind of args) {
		cursor = skipSpace(text, cursor);
		if (kind === "star") {
			if (text[cursor] === "*") {
				values.push("*");
				cursor += 1;
			} else values.push(null);
			continue;
		}
		if (kind === "optional") {
			if (text[cursor] !== "[") {
				values.push(null);
				continue;
			}
			const close = text.indexOf("]", cursor);
			if (close < 0) return null;
			values.push(text.slice(cursor + 1, close));
			cursor = close + 1;
			continue;
		}
		const group = readGroup(text, cursor);
		if (!group) return null;
		values.push(group.inner);
		cursor = group.end;
	}
	return { values, end: cursor };
}

function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset; index += 1)
		if (text.charCodeAt(index) === 10) line += 1;
	return line;
}

function inside(wrappers: readonly Wrapper[], offset: number): boolean {
	return wrappers.some(
		(wrapper) => offset >= wrapper.from && offset < wrapper.to,
	);
}

/** Headings produced by a macro or environment that wraps a standard section. */
export function customTexSections(source: string): CustomSection[] {
	const text = texSourceCode(source);
	const wrappers = scanWrappers(text);
	if (!wrappers.length) return [];
	const byCommand = new Map<string, Wrapper>();
	const byEnvironment = new Map<string, Wrapper>();
	for (const wrapper of wrappers) {
		const map = wrapper.kind === "command" ? byCommand : byEnvironment;
		map.set(wrapper.name, wrapper);
	}
	const found: CustomSection[] = [];
	const commandNames = [...byCommand.keys()].sort(
		(a, b) => b.length - a.length,
	);
	if (commandNames.length) {
		const pattern = new RegExp(
			`\\\\(${commandNames.join("|")})(?![A-Za-z])`,
			"g",
		);
		for (const match of text.matchAll(pattern)) {
			const from = match.index ?? 0;
			if (from > 0 && text[from - 1] === "\\") continue;
			if (inside(wrappers, from)) continue;
			const wrapper = byCommand.get(match[1] ?? "");
			if (!wrapper) continue;
			const args = readUseArgs(text, from + match[0].length, wrapper.args);
			const title = args?.values[wrapper.argument - 1];
			if (!args || title == null) continue;
			const plain = plainTexTitle(title);
			if (!plain) continue;
			found.push({
				from,
				line: lineAt(source, from),
				level: wrapper.level,
				title: plain,
			});
		}
	}
	if (byEnvironment.size) {
		const names = [...byEnvironment.keys()].sort((a, b) => b.length - a.length);
		const pattern = new RegExp(`\\\\begin\\s*\\{(${names.join("|")})\\}`, "g");
		for (const match of text.matchAll(pattern)) {
			const from = match.index ?? 0;
			if (inside(wrappers, from)) continue;
			const wrapper = byEnvironment.get(match[1] ?? "");
			if (!wrapper) continue;
			const args = readUseArgs(text, from + match[0].length, wrapper.args);
			const title = args?.values[wrapper.argument - 1];
			if (!args || title == null) continue;
			const plain = plainTexTitle(title);
			if (!plain) continue;
			found.push({
				from,
				line: lineAt(source, from),
				level: wrapper.level,
				title: plain,
			});
		}
	}
	found.sort((left, right) => left.from - right.from);
	return found;
}
