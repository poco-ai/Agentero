import { latexLanguage } from "codemirror-lang-latex";
import type { BibEntry } from "@/lib/bibtex/parse";

/** Blank comments and verbatim contents while preserving source offsets. */
export function texSourceCode(source: string): string {
	const visible = source.split("");
	latexLanguage.parser.parse(source).iterate({
		enter(node) {
			if (!/Comment|Verbatim|VerbContent|LstInline/.test(node.name)) return;
			for (let i = node.from; i < node.to; i += 1)
				if (visible[i] !== "\n") visible[i] = " ";
			return false;
		},
	});
	return visible.join("");
}

function unsafeBibliographyPath(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f || character === "{" || character === "}")
			return true;
	}
	return false;
}

/**
 * A bibliography path the project can open. Absolute paths, URLs and a `..`
 * that leaves the project are dropped; a missing extension becomes `.bib`.
 */
export function bibliographyFilePath(raw: string): string | null {
	const value = raw.trim().replaceAll("\\", "/");
	if (!value || unsafeBibliographyPath(value)) return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
	if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return null;
	const parts: string[] = [];
	for (const part of value.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (!parts.length) return null;
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	const joined = parts.join("/");
	if (!joined) return null;
	if (/\.[A-Za-z0-9]+$/.test(joined))
		return /\.bib$/i.test(joined) ? joined : null;
	return `${joined}.bib`;
}

/** Biblatex when the preamble loads it or calls `\addbibresource`. */
export function bibliographyKind(source: string): "biblatex" | "bibtex" | null {
	const code = texSourceCode(source);
	if (
		/\\addbibresource\b/.test(code) ||
		/\\usepackage(?:\s*\[[^\]]*\])?\s*\{[^}]*\bbiblatex\b/.test(code)
	)
		return "biblatex";
	if (
		/\\bibliography\b/.test(code) ||
		/\\begin\s*\{thebibliography\}/.test(code)
	)
		return "bibtex";
	return null;
}

/** Declared bibliography targets include resources that have not been created yet. */
export function declaredTexBibliographies(source: string): string[] {
	const targets: string[] = [];
	for (const match of texSourceCode(source).matchAll(
		/\\(bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g,
	)) {
		const parts =
			match[1] === "bibliography" ? match[2].split(",") : [match[2]];
		for (const part of parts) {
			const target = bibliographyFilePath(part);
			if (target) targets.push(target);
		}
	}
	return targets;
}

function texGroup(
	code: string,
	start: number,
	open: string,
	close: string,
): { text: string; end: number } | null {
	if (code[start] !== open) return null;
	let depth = 1;
	let braces = 0;
	for (let i = start + 1; i < code.length; i += 1) {
		if (code[i] === "\\") {
			i += 1;
			continue;
		}
		if (open === "[") {
			if (code[i] === "{") braces += 1;
			else if (code[i] === "}") braces = Math.max(0, braces - 1);
		}
		if (braces) continue;
		if (code[i] === open) depth += 1;
		else if (code[i] === close && --depth === 0)
			return { text: code.slice(start + 1, i), end: i + 1 };
	}
	return null;
}

/** Inline bibliographies share the same completion/definition model as .bib entries. */
export function parseTexBibitems(source: string): BibEntry[] {
	const code = texSourceCode(source);
	const entries: BibEntry[] = [];
	for (const environment of code.matchAll(
		/\\begin\s*\{thebibliography\}[\s\S]*?\\end\s*\{thebibliography\}/g,
	)) {
		const start = environment.index ?? 0;
		const bodyEnd = start + environment[0].lastIndexOf("\\end");
		const items: { key: string; from: number; bodyFrom: number }[] = [];
		for (const item of environment[0].matchAll(/\\bibitem(?=[\s[{])/g)) {
			let pos = start + (item.index ?? 0) + item[0].length;
			while (/\s/.test(code[pos] ?? "") && pos < bodyEnd) pos += 1;
			if (code[pos] === "[") {
				const label = texGroup(code, pos, "[", "]");
				if (!label) continue;
				pos = label.end;
				while (/\s/.test(code[pos] ?? "") && pos < bodyEnd) pos += 1;
			}
			const key = texGroup(code, pos, "{", "}");
			if (key?.text.trim())
				items.push({
					key: key.text.trim(),
					from: start + (item.index ?? 0),
					bodyFrom: key.end,
				});
		}
		for (let index = 0; index < items.length; index += 1) {
			const item = items[index];
			const to = items[index + 1]?.from ?? bodyEnd;
			const raw = code.slice(item.bodyFrom, to);
			const preview = raw
				.replace(/\\[A-Za-z]+\*?/g, " ")
				.replace(/[{}]/g, "")
				.replace(/~/g, " ")
				.replace(/\s+/g, " ")
				.trim();
			const year = /\b(?:19|20)\d{2}\b/.exec(preview)?.[0];
			const doi = /\b10\.\d{4,9}\/[^\s{}]+/i
				.exec(raw)?.[0]
				?.replace(/[.,;]+$/, "");
			const eprint = /arxiv\s*:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i.exec(
				preview,
			)?.[1];
			entries.push({
				key: item.key,
				kind: "bibitem",
				from: item.from,
				to,
				fields: {
					title: preview,
					...(year ? { year } : {}),
					...(doi ? { doi } : {}),
					...(eprint ? { eprint } : {}),
				},
			});
		}
	}
	return entries;
}
