/**
 * Catalog paper list/get helpers (SQLite via Host).
 * Import/export go through Translator `/import` and `/export` (Zotero JSON).
 */
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import i18n from "@/i18n";
import { invokeApi } from "@/lib/core/ipc";
import { normalizeRelPath } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import { withNormalizedTags } from "@/lib/paper/tags";
import type { PaperMetadata } from "@/lib/paper/types";
import { type AppSettings, DEFAULT_TRANSLATOR_BASE_URL } from "@/lib/settings";
import type { PaperTagInput } from "@/lib/ui/tag-colors";
import type { WikiRenameResult } from "@/lib/wiki";

/**
 * Virtual file-tree path for the papers library table.
 * Not a real filesystem path — never passed to Host fs APIs.
 */
export const LIBRARY_VIRTUAL_PATH = "agentero:library";

export function isLibraryVirtualPath(path: string | null | undefined): boolean {
	return path === LIBRARY_VIRTUAL_PATH;
}

/** Virtual file-tree / tab path for the Recycle Bin center view. */
export const TRASH_VIRTUAL_PATH = "agentero:trash";

export function isTrashVirtualPath(path: string | null | undefined): boolean {
	return path === TRASH_VIRTUAL_PATH;
}

/** Normalize vault-relative path for library scope comparisons. */
export function normalizeLibraryScope(path: string): string {
	return normalizeRelPath(path).toLowerCase();
}

/**
 * Whether a vault-relative path is a meaningful Library folder scope.
 * Only `papers` / `papers/...` filter the catalog; `notes`, `.agents`,
 * `plans`, etc. are not paper trees and must show the full library (#160).
 */
export function isPapersLibraryScope(
	scopeRel: string | null | undefined,
): boolean {
	if (scopeRel == null || scopeRel === "") return false;
	const s = normalizeLibraryScope(scopeRel);
	return s === "papers" || s.startsWith("papers/");
}

/**
 * Resolve a folder click to a Library scope path.
 * Non-papers folders → `null` (full library).
 */
export function resolveLibraryScopePath(
	rel: string | null | undefined,
): string | null {
	if (rel == null || rel === "") return null;
	const cleaned = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!cleaned) return null;
	return isPapersLibraryScope(cleaned) ? cleaned : null;
}

/**
 * Destination folder for a PDF dropped on the Library table.
 * Folder-scoped Library (`papers/nlp`) imports there; full library uses
 * `fallback` (tree selection / `papers`).
 */
export function libraryDropParentDir(
	scopePath: string | null | undefined,
	fallback = "papers",
): string {
	const cleaned = (scopePath ?? "")
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (!cleaned || !isPapersLibraryScope(cleaned)) {
		return fallback.trim() || "papers";
	}
	return cleaned;
}

/**
 * Whether a catalog paper path falls under a folder scope (recursive).
 * `scopeRel` is vault-relative (e.g. `papers/nlp`); empty/null = full library.
 * Scopes outside `papers/` are treated as full library (#160).
 */
export function paperInLibraryScope(
	paperPath: string | undefined,
	scopeRel: string | null | undefined,
): boolean {
	if (scopeRel == null || scopeRel === "") return true;
	if (!isPapersLibraryScope(scopeRel)) return true;
	if (!paperPath) return false;
	const p = normalizeLibraryScope(paperPath);
	const s = normalizeLibraryScope(scopeRel);
	if (!s) return true;
	return p === s || p.startsWith(`${s}/`);
}

/** Filter catalog rows to those under a vault-relative folder (recursive). */
export function filterPapersByScope(
	papers: PaperMetadata[],
	scopeRel: string | null | undefined,
): PaperMetadata[] {
	if (scopeRel == null || scopeRel === "") return papers;
	if (!isPapersLibraryScope(scopeRel)) return papers;
	const s = normalizeLibraryScope(scopeRel);
	if (!s) return papers;
	return papers.filter((p) => paperInLibraryScope(p.path, s));
}

export async function listPapers(vaultPath: string): Promise<PaperMetadata[]> {
	if (!isTauri()) return [];
	const { isRemoteVaultHandle, remotePaperList, remoteSessionIdFromHandle } =
		await import("@/lib/vault/remote/remote-vault");
	if (isRemoteVaultHandle(vaultPath)) {
		const sessionId = remoteSessionIdFromHandle(vaultPath);
		if (!sessionId) return [];
		const rows = (await remotePaperList(sessionId)) as PaperMetadata[];
		return rows.map(withNormalizedTags);
	}
	const rows = await invokeApi<PaperMetadata[]>(
		"paper_list",
		{
			args: { vaultPath },
		},
		{
			fallback: "paper_list failed",
		},
	);
	return rows.map(withNormalizedTags);
}

export type PaperRescanResult = { count: number };

/** Rebuild catalog rows from papers/ on disk (recover disk-only papers). */
export async function rescanPapers(vaultPath: string): Promise<number> {
	if (!isTauri()) return 0;
	const { isRemoteVaultHandle, remotePaperRescan, remoteSessionIdFromHandle } =
		await import("@/lib/vault/remote/remote-vault");
	if (isRemoteVaultHandle(vaultPath)) {
		const sessionId = remoteSessionIdFromHandle(vaultPath);
		if (!sessionId) return 0;
		const r = await remotePaperRescan(sessionId);
		return r.count;
	}
	const r = await invokeApi<PaperRescanResult>(
		"paper_rescan",
		{
			args: { vaultPath },
		},
		{
			fallback: i18n.t("sidebar:papersLibrary.rescanFailed"),
		},
	);
	return r.count;
}

/**
 * Cached PDF page counts keyed by vault-relative paper path (catalog table
 * `pdf_page_counts`). Lets the reading heatmap skip reopening every PDF.
 * Best-effort: cache misses/failures just fall back to reading the PDF.
 */
export async function listPaperPageCounts(
	vaultPath: string,
): Promise<Map<string, number>> {
	if (!isTauri()) return new Map();
	const { isRemoteVaultHandle } = await import(
		"@/lib/vault/remote/remote-vault"
	);
	if (isRemoteVaultHandle(vaultPath)) return new Map();
	try {
		const counts = await invokeApi<Record<string, number>>(
			"paper_page_counts",
			{ args: { vaultPath } },
			{ fallback: "paper_page_counts failed" },
		);
		return new Map(Object.entries(counts ?? {}));
	} catch {
		return new Map();
	}
}

/** Persist newly discovered PDF page counts (best-effort, fire-and-forget). */
export async function savePaperPageCounts(
	vaultPath: string,
	counts: ReadonlyMap<string, number>,
): Promise<void> {
	if (!isTauri() || counts.size === 0) return;
	const { isRemoteVaultHandle } = await import(
		"@/lib/vault/remote/remote-vault"
	);
	if (isRemoteVaultHandle(vaultPath)) return;
	try {
		await invokeApi<null>(
			"paper_set_page_counts",
			{ args: { vaultPath, counts: Object.fromEntries(counts) } },
			{ fallback: "paper_set_page_counts failed", allowVoid: true },
		);
	} catch {
		// Cache write failure is invisible by design; next load retries.
	}
}

export type TrashResult = {
	batchId: string;
	count: number;
};

/**
 * Move vault-relative paths into the recycle bin (`.agentero/.trash/`).
 * Snapshots + removes catalog rows so the delete can be undone.
 */
export async function trashPaths(
	vaultPath: string,
	rels: string[],
): Promise<TrashResult> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:fileTree.deleteDesktopOnly"));
	}
	return invokeApi<TrashResult>(
		"path_trash",
		{
			args: { vaultPath, rels },
		},
		{
			fallback: i18n.t("sidebar:fileTree.deleteFailed"),
		},
	);
}

export type TrashEntry = {
	id: string;
	batchId: string;
	stored: string;
	rel: string;
	name: string;
	deletedAt: string;
	isDir: boolean;
};

/** List all items currently in the recycle bin (`.agentero/.trash/`). */
export async function listTrash(vaultPath: string): Promise<TrashEntry[]> {
	if (!isTauri()) return [];
	return invokeApi<TrashEntry[]>(
		"path_list_trash",
		{
			args: { vaultPath },
		},
		{
			fallback: i18n.t("sidebar:recycleBin.loadFailed"),
		},
	);
}

/** Restore one recycle-bin item to its original path; returns the rel path. */
export async function restoreTrashItem(
	vaultPath: string,
	batchId: string,
	stored: string,
): Promise<string> {
	const r = await invokeApi<{ rel: string }>(
		"path_restore_item",
		{
			args: { vaultPath, batchId, stored },
		},
		{
			fallback: i18n.t("sidebar:fileTree.undoFailed"),
		},
	);
	return r.rel;
}

/** Permanently delete one recycle-bin item. */
export async function purgeTrashItem(
	vaultPath: string,
	batchId: string,
	stored: string,
): Promise<void> {
	await invokeApi<null>(
		"path_purge_item",
		{
			args: { vaultPath, batchId, stored },
		},
		{
			fallback: i18n.t("sidebar:recycleBin.purgeFailed"),
			allowVoid: true,
		},
	);
}

/** Empty the entire recycle bin (permanent). */
export async function purgeAllTrash(vaultPath: string): Promise<void> {
	await invokeApi<null>(
		"path_purge_trash",
		{
			args: { vaultPath },
		},
		{
			fallback: i18n.t("sidebar:recycleBin.purgeFailed"),
			allowVoid: true,
		},
	);
}

export type PaperMoveResult = {
	newRel: string;
	linkUpdate: WikiRenameResult;
};

/**
 * Move a paper/org folder (or file) into another papers/ folder on disk and
 * rewrite matching catalog path prefixes. Never overwrites an existing target.
 */
export async function movePaperFolder(
	vaultPath: string,
	fromRel: string,
	destParentRel: string,
	dirtyPaths: string[],
): Promise<PaperMoveResult> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:fileTree.moveDesktopOnly"));
	}
	return invokeApi<PaperMoveResult>(
		"paper_move",
		{
			args: { vaultPath, fromRel, destParentRel, dirtyPaths },
		},
		{
			fallback: i18n.t("sidebar:fileTree.moveFailed"),
		},
	);
}

/**
 * Mark paper as read / unread after paper-reader workflow (catalog authority).
 */
export async function setPaperIsRead(
	vaultPath: string,
	path: string,
	isRead: boolean,
): Promise<PaperMetadata> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:fileTree.readDesktopOnly"));
	}
	const { isRemoteVaultHandle, remoteSessionIdFromHandle } = await import(
		"@/lib/vault/remote/remote-vault"
	);
	if (isRemoteVaultHandle(vaultPath)) {
		const sessionId = remoteSessionIdFromHandle(vaultPath);
		if (!sessionId) {
			throw new Error(i18n.t("sidebar:fileTree.readMarkFailed"));
		}
		const paper = await invokeApi<PaperMetadata>(
			"remote_paper_set_is_read",
			{
				args: { sessionId, path, isRead },
			},
			{
				fallback: i18n.t("sidebar:fileTree.readMarkFailed"),
			},
		);
		return withNormalizedTags(paper);
	}
	const paper = await invokeApi<PaperMetadata>(
		"paper_set_is_read",
		{
			args: { vaultPath, path, isRead },
		},
		{
			fallback: i18n.t("sidebar:fileTree.readMarkFailed"),
		},
	);
	return withNormalizedTags(paper);
}

/**
 * Replace paper tags in catalog (full list; Host normalizes trim/dedupe/color).
 * Items may be bare strings or `{ name, color? }`.
 */
export async function setPaperTags(
	vaultPath: string,
	path: string,
	tags: PaperTagInput[],
): Promise<PaperMetadata> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:paperInfo.tagsDesktopOnly"));
	}
	const { isRemoteVaultHandle, remoteSessionIdFromHandle } = await import(
		"@/lib/vault/remote/remote-vault"
	);
	if (isRemoteVaultHandle(vaultPath)) {
		const sessionId = remoteSessionIdFromHandle(vaultPath);
		if (!sessionId) {
			throw new Error(i18n.t("sidebar:paperInfo.tagsSaveFailed"));
		}
		const paper = await invokeApi<PaperMetadata>(
			"remote_paper_set_tags",
			{
				args: { sessionId, path, tags },
			},
			{
				fallback: i18n.t("sidebar:paperInfo.tagsSaveFailed"),
			},
		);
		return withNormalizedTags(paper);
	}
	const paper = await invokeApi<PaperMetadata>(
		"paper_set_tags",
		{
			args: { vaultPath, path, tags },
		},
		{
			fallback: i18n.t("sidebar:paperInfo.tagsSaveFailed"),
		},
	);
	return withNormalizedTags(paper);
}

export type PaperExportResult = {
	format: string;
	content: string;
	count: number;
	filename: string;
};

export type PaperImportResult = {
	imported: number;
	skipped: number;
	paths: string[];
	titles: string[];
	errors: string[];
};

function translatorBase(settings?: AppSettings): string {
	const raw =
		settings?.translatorBaseUrl?.trim() || DEFAULT_TRANSLATOR_BASE_URL;
	return raw.replace(/\/+$/, "");
}

/**
 * Export catalog via Host → Translator `POST /export`.
 * Host converts catalog rows to a **Zotero API JSON array** (required body shape).
 */
export async function exportLibrary(opts: {
	vaultPath: string;
	settings?: AppSettings;
	/** Default bibtex */
	format?: string;
}): Promise<PaperExportResult> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:papersLibrary.desktopOnly"));
	}
	return invokeApi<PaperExportResult>(
		"paper_export",
		{
			args: {
				vaultPath: opts.vaultPath,
				format: opts.format ?? "bibtex",
				translatorBaseUrl: translatorBase(opts.settings),
			},
		},
		{
			fallback: i18n.t("sidebar:papersLibrary.exportFailed"),
		},
	);
}

/**
 * Save-dialog wrapper: export library then write file.
 * Returns null if user cancels the save dialog.
 */
export async function exportLibraryToFile(opts: {
	vaultPath: string;
	settings?: AppSettings;
	format?: string;
}): Promise<PaperExportResult | null> {
	const data = await exportLibrary(opts);
	const path = await save({
		defaultPath: data.filename,
		filters: [
			{
				name: data.format,
				extensions: [data.filename.split(".").pop() || "bib"],
			},
		],
	});
	if (!path) return null;
	await writeTextFile(path, data.content);
	return data;
}

/**
 * Import BibTeX/RIS via Translator `POST /import` → catalog + paper folders.
 */
export async function importLibraryText(opts: {
	vaultPath: string;
	content: string;
	parentDir?: string;
	settings?: AppSettings;
}): Promise<PaperImportResult> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:papersLibrary.desktopOnly"));
	}
	return invokeApi<PaperImportResult>(
		"paper_import",
		{
			args: {
				vaultPath: opts.vaultPath,
				parentDir: opts.parentDir ?? "papers",
				content: opts.content,
				translatorBaseUrl: translatorBase(opts.settings),
			},
		},
		{
			fallback: i18n.t("sidebar:papersLibrary.importFailed"),
		},
	);
}

/**
 * Open-dialog wrapper: pick .bib/.ris/… then import.
 * Returns null if user cancels.
 */
export async function importLibraryFromFile(opts: {
	vaultPath: string;
	parentDir?: string;
	settings?: AppSettings;
}): Promise<PaperImportResult | null> {
	const selected = await open({
		multiple: false,
		filters: [
			{
				name: "Bibliography",
				extensions: ["bib", "ris", "enw", "xml", "json", "txt"],
			},
		],
	});
	if (!selected) return null;
	const path = Array.isArray(selected) ? selected[0] : selected;
	if (!path) return null;
	const content = await readTextFile(path);
	return importLibraryText({
		vaultPath: opts.vaultPath,
		content,
		parentDir: opts.parentDir,
		settings: opts.settings,
	});
}
