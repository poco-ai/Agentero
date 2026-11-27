/**
 * The notes a paper folder offers to the notes column, and which one the user
 * read last. The notes column shows one document at a time; this module is what
 * the in-place switcher and the ⌃Tab cycle read from.
 */

import { normalizePath } from "@/lib/core/path";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import { PAPER_MAIN_NOTE_NAME, paperNoteDocs } from "@/lib/paper/children";
import { normalizePathKey, treeFindNode } from "@/lib/vault/path";
import type { FileNode } from "@/lib/vault/types";

/** Remembered-note storage. One path per paper folder, newest first. */
const STORAGE_KEY = "agentero.paperNote.v1";
/** Old papers fall out instead of growing the map forever. */
const MAX_ENTRIES = 200;

/** Paper folder owning a notes path (`…/papers/x/NOTES.md` → `…/papers/x`). */
export function paperNotesDir(notesPath: string): string {
	return normalizePath(notesPath).replace(/\/notes\.md$/i, "");
}

/**
 * Every note path of the paper, main `NOTES.md` first.
 *
 * `notesPath` is always included: the main note is shown even before it exists
 * on disk (the editor seeds it on first save), so it must stay in the cycle.
 */
export function paperNotePaths(
	notesPath: string,
	tree: FileNode[] | null | undefined,
): string[] {
	const dir = paperNotesDir(notesPath);
	const paths = [normalizePath(notesPath)];
	const docs = paperNoteDocs(tree ? treeFindNode(tree, dir) : null);
	for (const doc of docs) {
		if (!doc.path) continue;
		const path = normalizePath(doc.path);
		if (!paths.includes(path)) paths.push(path);
	}
	return paths;
}

/** Whether `path` is the paper's main note rather than an extra one. */
export function isMainPaperNote(path: string): boolean {
	return path.split("/").pop()?.toLowerCase() === PAPER_MAIN_NOTE_NAME;
}

type LastNoteMap = Record<string, string>;

let cachedMap: LastNoteMap | null = null;

function loadMap(): LastNoteMap {
	if (cachedMap) return cachedMap;
	const stored = readJsonStorage<unknown>(STORAGE_KEY, null);
	const map: LastNoteMap = {};
	if (stored && typeof stored === "object" && !Array.isArray(stored)) {
		for (const [key, value] of Object.entries(
			stored as Record<string, unknown>,
		)) {
			if (typeof value === "string" && value) map[key] = value;
		}
	}
	cachedMap = map;
	return map;
}

/** Record the note the notes column now shows for this paper. */
export function rememberPaperNote(paperDir: string, notePath: string): void {
	const key = normalizePathKey(paperDir);
	const path = normalizePath(notePath);
	const map = loadMap();
	if (map[key] === path) return;
	delete map[key];
	map[key] = path;
	const keys = Object.keys(map);
	for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) {
		delete map[stale];
	}
	writeJsonStorage(STORAGE_KEY, map);
}

/** Last note read for this paper, if any. */
export function lastPaperNote(paperDir: string): string | null {
	const map = loadMap();
	const key = normalizePathKey(paperDir);
	return map[key] ?? null;
}

/**
 * Note to show when the paper's notes column (re)opens: the remembered one
 * when it still exists inside this paper folder, otherwise null (NOTES.md).
 */
export function resumePaperNote(
	notesPath: string,
	tree: FileNode[] | null | undefined,
): string | null {
	const dir = normalizePathKey(paperNotesDir(notesPath));
	const hint = lastPaperNote(paperNotesDir(notesPath));
	if (!hint) return null;
	const key = normalizePathKey(hint);
	if (key === normalizePathKey(notesPath)) return null;
	if (!key.startsWith(`${dir}/`)) return null;
	if (!tree) return null;
	return treeFindNode(tree, hint)?.kind === "file" ? hint : null;
}
