import { normalizePath } from "@/lib/core/path";
import {
	isUnderPaperAttachments,
	paperAttachmentChildren,
	paperHasVisibleAttachments,
} from "@/lib/paper/attachments";
import type { FileNode } from "@/lib/vault/types";

type NamedChild = {
	name: string;
	kind?: string;
	path?: string;
	children?: NamedChild[];
	childrenPending?: boolean;
};

/**
 * Root-level paper documents surfaced as child rows (whitelist). Anything else
 * at the paper root (PDF, metadata.json, figures, …) stays owned by the paper
 * row itself.
 */
const PAPER_CHILD_DOC_EXTS = new Set([".md", ".html", ".htm"]);

/**
 * Root documents never surfaced as paper children. `PAPER.md` is the derived
 * body of the paper and is reached through the paper row's body view, so it
 * would only duplicate that entry.
 */
const HIDDEN_PAPER_DOC_NAMES = new Set(["paper.md"]);

/** The paper's canonical note. The notes column shows it unless the user picked another. */
export const PAPER_MAIN_NOTE_NAME = "notes.md";

function fileExtension(name: string): string {
	const lower = name.toLowerCase();
	const dot = lower.lastIndexOf(".");
	return dot > 0 ? lower.slice(dot) : "";
}

/** Whitelisted extension and not a paper-owned generated document. */
export function isPaperChildDocName(name: string): boolean {
	if (HIDDEN_PAPER_DOC_NAMES.has(name.toLowerCase())) return false;
	return PAPER_CHILD_DOC_EXTS.has(fileExtension(name));
}

/**
 * Root-level Markdown/HTML children of a paper folder.
 *
 * `PAPER.md` is the derived body and never listed. A single remaining document
 * is normally the paper's own `NOTES.md`, already represented by the paper row,
 * so it is not surfaced either. Only when the folder holds more than one
 * displayable document do the rows appear, so imported notes and web snapshots
 * become visible without adding a chevron to every paper.
 */
export function paperRootDocChildren<T extends NamedChild>(
	paper: { children?: T[] } | null | undefined,
): T[] {
	const docs = (paper?.children ?? []).filter(
		(child) => child.kind === "file" && isPaperChildDocName(child.name),
	);
	return docs.length > 1 ? docs : [];
}

/**
 * Every root-level document of a paper folder, main `NOTES.md` first.
 *
 * Unlike {@link paperRootDocChildren} this keeps the single-document folder
 * too: the notes column can show any of them, and its switcher needs the whole
 * set even when it only holds NOTES.md plus one extra note.
 */
export function paperNoteDocs<T extends NamedChild>(
	paper: { children?: T[] } | null | undefined,
): T[] {
	const docs = (paper?.children ?? []).filter(
		(child) =>
			child.kind === "file" &&
			Boolean(child.path) &&
			isPaperChildDocName(child.name),
	);
	const main: T[] = [];
	const rest: T[] = [];
	for (const doc of docs) {
		if (doc.name.toLowerCase() === PAPER_MAIN_NOTE_NAME) main.push(doc);
		else rest.push(doc);
	}
	return [...main, ...rest];
}

/** Basename of a normalized path, without touching the filesystem. */
function pathBaseName(path: string): string {
	const norm = normalizePath(path).replace(/\/+$/, "");
	return norm.slice(norm.lastIndexOf("/") + 1);
}

/**
 * Path is one of the paper's own notes: a root-level Markdown/HTML document of
 * the paper folder, `PAPER.md` (the derived body) excluded.
 */
export function isPaperNoteDocPath(
	path: string | null,
	paperDir: string | null,
): boolean {
	if (!path || !isPaperChildDocPath(path, paperDir)) return false;
	return !HIDDEN_PAPER_DOC_NAMES.has(pathBaseName(path).toLowerCase());
}

/**
 * Path is a surfaced root-level paper document (a direct child of the paper
 * folder with a whitelisted extension).
 */
export function isPaperChildDocPath(
	path: string | null,
	paperDir: string | null,
): boolean {
	if (!path || !paperDir) return false;
	const dir = normalizePath(paperDir).replace(/\/+$/, "");
	const target = normalizePath(path);
	const prefix = `${dir}/`;
	if (!target.toLowerCase().startsWith(prefix.toLowerCase())) return false;
	const rel = target.slice(prefix.length);
	return !rel.includes("/") && isPaperChildDocName(rel);
}

/** Path keeps its own tree row instead of highlighting the paper row. */
export function paperSurfacesChildPath(
	path: string | null,
	paper: FileNode,
): boolean {
	if (!path) return false;
	if (isUnderPaperAttachments(path, paper.path)) return true;
	if (!isPaperChildDocPath(path, paper.path)) return false;
	const docs = paperRootDocChildren(paper);
	const key = normalizePath(path).toLowerCase();
	return docs.some(
		(child) =>
			Boolean(child.path) &&
			normalizePath(child.path as string).toLowerCase() === key,
	);
}

/** Children shown when a paper row is expanded: root documents, then attachments. */
export function paperVisibleChildren(paper: FileNode): FileNode[] {
	const docs = paperRootDocChildren(paper);
	const attachments = paperAttachmentChildren(paper);
	if (docs.length === 0) return attachments;
	if (attachments.length === 0) return docs;
	return [...docs, ...attachments];
}

/** Whether a paper row shows an expand chevron (documents or attachments). */
export function paperHasVisibleChildren(
	paper: { children?: NamedChild[] } | null | undefined,
): boolean {
	return (
		paperRootDocChildren(paper).length > 0 || paperHasVisibleAttachments(paper)
	);
}
