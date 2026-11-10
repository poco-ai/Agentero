import i18n from "@/i18n";
import {
	type BibEntry,
	firstAuthorSurname,
	parseBibEntries,
} from "@/lib/bibtex/parse";
import { dirnameOf, joinPath } from "@/lib/core/path";
import type { PaperMetadata } from "@/lib/paper/types";
import { getTexEditor } from "@/lib/tex/editor-navigation";
import {
	invalidateTexProjectIndex,
	loadTexProjectIndex,
	type TexCitation,
} from "@/lib/tex/project-index";
import {
	bibliographyKind,
	declaredTexBibliographies,
	texSourceCode,
} from "@/lib/tex/source";
import { readVaultFile } from "@/lib/vault/fs";
import { persistTextFile } from "@/lib/workspace/persistence";
import {
	flushAllTextEditors,
	flushTextEditorFor,
} from "@/lib/workspace/text-editor-flush";

const normalDoi = (doi: string | null | undefined) =>
	doi
		?.trim()
		.replace(/\\([_%&#{}])/g, "$1")
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.toLowerCase();
const normalTitle = (title: string | undefined) =>
	title
		?.replace(/[{}\\]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();

export function existingCatalogCitation(
	entries: readonly BibEntry[],
	paper: Pick<PaperMetadata, "doi" | "title" | "arxiv_id"> &
		Partial<Pick<PaperMetadata, "bibtex_key">>,
): BibEntry | undefined {
	return entries.find(
		(entry) =>
			(Boolean(normalDoi(paper.doi)) &&
				normalDoi(entry.fields.doi) === normalDoi(paper.doi)) ||
			(Boolean(paper.arxiv_id) &&
				entry.fields.eprint?.replace(/v\d+$/, "") ===
					paper.arxiv_id?.replace(/v\d+$/, "")) ||
			(Boolean(normalTitle(paper.title)) &&
				(normalTitle(entry.fields.title) === normalTitle(paper.title) ||
					(entry.kind === "bibitem" &&
						paper.bibtex_key === entry.key &&
						normalTitle(entry.fields.title)?.includes(
							normalTitle(paper.title) ?? "",
						)))),
	);
}

function bibValue(value: string): string {
	return value
		.replace(/[\\%&#_{}]/g, (char) =>
			char === "\\" ? "\\textbackslash{}" : `\\${char}`,
		)
		.replace(/[\r\n]+/g, " ");
}

export function catalogBibEntry(
	paper: Pick<
		PaperMetadata,
		| "bibtex_key"
		| "id"
		| "title"
		| "authors"
		| "year"
		| "doi"
		| "arxiv_id"
		| "publication"
		| "volume"
		| "issue"
		| "pages"
		| "publisher"
	>,
	entries: readonly BibEntry[],
): { key: string; content: string } {
	const surname = firstAuthorSurname(paper.authors[0]) ?? "paper";
	const stem =
		(
			paper.bibtex_key ||
			`${surname}${paper.year ?? ""}${paper.title.split(/\s+/).find((part) => part.length > 3) ?? paper.id}`
		)
			.normalize("NFKD")
			.replace(/[^a-zA-Z0-9:_.+-]/g, "") || "paper";
	const used = new Set(entries.map((entry) => entry.key));
	let key = stem;
	for (let suffix = 1; used.has(key); suffix += 1) key = `${stem}${suffix}`;
	const fields: [string, string | number | null | undefined][] = [
		["title", paper.title],
		["author", paper.authors.join(" and ")],
		["year", paper.year],
		["journal", paper.publication],
		["volume", paper.volume],
		["number", paper.issue],
		["pages", paper.pages],
		["publisher", paper.publisher],
		["doi", paper.doi],
		["eprint", paper.arxiv_id],
		["archivePrefix", paper.arxiv_id ? "arXiv" : null],
	];
	const body = fields
		.filter(
			([, value]) => value !== null && value !== undefined && value !== "",
		)
		.map(([name, value]) => `  ${name} = {${bibValue(String(value))}}`)
		.join(",\n");
	return {
		key,
		content: `@${paper.publication ? "article" : "misc"}{${key},\n${body}\n}`,
	};
}

/** Attach a new bibliography only if the document has no existing resource. */
export function projectBibliographyChanges(
	source: string,
): { from: number; insert: string }[] {
	const code = texSourceCode(source);
	if (/\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{/.test(code))
		return [];
	const begin = /\\begin\s*\{document\}/.exec(code);
	const end = /\\end\s*\{document\}/.exec(code);
	if (!begin || !end) return [];
	if (bibliographyKind(source) === "biblatex") {
		return [
			{ from: begin.index, insert: "\\addbibresource{references.bib}\n" },
			...(/\\printbibliography\b/.test(code)
				? []
				: [{ from: end.index, insert: "\\printbibliography\n" }]),
		];
	}
	const declaration = `${/\\bibliographystyle\b/.test(code) ? "" : "\\bibliographystyle{plain}\n"}\\bibliography{references}\n`;
	return [{ from: end.index, insert: declaration }];
}

export function attachProjectBibliography(source: string): string {
	return projectBibliographyChanges(source).reduceRight(
		(content, change) =>
			`${content.slice(0, change.from)}${change.insert}${content.slice(change.from)}`,
		source,
	);
}

async function attachBibliographySource(path: string): Promise<void> {
	const editor = getTexEditor(path);
	if (editor) {
		const before = editor.state.doc.toString();
		const changes = projectBibliographyChanges(before);
		if (!changes.length) return;
		editor.dispatch({
			changes,
			userEvent: "input.citation",
		});
		if (!(await flushTextEditorFor(path)))
			throw new Error(i18n.t("latexLanguage:saveFailed"));
		return;
	}
	const before = await readVaultFile(path);
	const next = attachProjectBibliography(before);
	if (next !== before && !(await persistTextFile(path, next, before)))
		throw new Error(i18n.t("latexLanguage:saveFailed"));
}

let insertionQueue: Promise<unknown> = Promise.resolve();

/** Serializes bibliography read/merge/write and refuses stale disk snapshots. */
export function addCatalogCitation(
	path: string,
	paper: PaperMetadata,
): Promise<string> {
	const operation = insertionQueue
		.catch(() => undefined)
		.then(async () => {
			if (!(await flushAllTextEditors()))
				throw new Error(i18n.t("latexLanguage:saveFailed"));
			invalidateTexProjectIndex();
			const index = await loadTexProjectIndex(path);
			const duplicate = existingCatalogCitation(index.citations, paper) as
				| TexCitation
				| undefined;
			if (duplicate) return duplicate.key;
			const declaredPaths = [...index.documents.values()]
				.flatMap((source) => declaredTexBibliographies(source))
				.map((target) =>
					/^(?:\/|[A-Za-z]:[\\/])/.test(target)
						? target
						: joinPath(dirnameOf(index.rootPath), target),
				);
			const bibPath =
				index.bibFiles[0] ??
				declaredPaths[0] ??
				joinPath(dirnameOf(index.rootPath), "references.bib");
			const needsAttachment = !index.bibFiles.length && !declaredPaths.length;
			if (needsAttachment) {
				const rootSource =
					getTexEditor(index.rootPath)?.state.doc.toString() ??
					(await readVaultFile(index.rootPath));
				if (attachProjectBibliography(rootSource) === rootSource)
					throw new Error(i18n.t("latexLanguage:noDocumentEnd"));
			}
			let before = "";
			try {
				before = await readVaultFile(bibPath);
			} catch {
				/* New bibliography. */
			}
			const localEntries = parseBibEntries(before);
			const existing = existingCatalogCitation(localEntries, paper);
			const entry = existing
				? { key: existing.key, content: "" }
				: catalogBibEntry(paper, [...index.citations, ...localEntries]);
			const next = `${before.trimEnd()}${before.trim() ? "\n\n" : ""}${entry.content}\n`;
			if (!existing && !(await persistTextFile(bibPath, next, before)))
				throw new Error(i18n.t("latexLanguage:saveFailed"));
			if (needsAttachment) await attachBibliographySource(index.rootPath);
			invalidateTexProjectIndex();
			return entry.key;
		});
	insertionQueue = operation;
	return operation;
}
