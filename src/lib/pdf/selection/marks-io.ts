/**
 * Unified on-disk layout for PDF selection marks:
 *
 *   papers/<id>/marks/<id>.json          # kind: ask | highlight | translate | visual
 *   papers/<id>/marks/annotations.json   # EmbedPDF highlight/批注 transfer blob
 *
 * Per-mark files are pretty JSON with required `kind`.
 * Legacy visual marks used kind `agent-trace` (still readable).
 * `annotations.json` is the aggregate EmbedPDF annotation store (not a mark).
 */
import { readDir } from "@tauri-apps/plugin-fs";

import { isTauri } from "@/lib/core/tauri";
import {
	joinVaultPath,
	normalizePathKey,
	readVaultFile,
	removeVaultPath,
	writeVaultFile,
} from "@/lib/vault";

export const MARKS_FOLDER = "marks";

/** Aggregate EmbedPDF annotations file name under `marks/` (not a per-id mark). */
export const ANNOTATIONS_JSON = "annotations.json";

export type PdfMarkKind =
	| "ask"
	| "highlight"
	| "translate"
	| "visual"
	| "agent-trace";

export function marksDir(paperAbsPath: string): string {
	return joinVaultPath(paperAbsPath, MARKS_FOLDER);
}

export function markPath(paperAbsPath: string, id: string): string {
	return joinVaultPath(marksDir(paperAbsPath), `${id}.json`);
}

/** Sentinel for files that failed to read/parse (never a real JSON value). */
const CORRUPT_MARK = Symbol("marks.corrupt");

/** Read + JSON.parse every per-id `*.json` under `marks/` (skip aggregate + corrupt). */
export async function listMarkRaw(paperAbsPath: string): Promise<unknown[]> {
	if (!paperAbsPath || !isTauri()) return [];
	const dir = marksDir(paperAbsPath);
	let names: string[] = [];
	try {
		const entries = await readDir(dir);
		names = entries
			.map((e) => e.name)
			.filter(
				(n): n is string =>
					Boolean(n?.endsWith(".json")) && n !== ANNOTATIONS_JSON,
			);
	} catch {
		return [];
	}
	// Each file is an independent IPC round-trip; read them concurrently
	// instead of serially (refresh cost grew with mark count).
	const loaded = await Promise.all(
		names.map(async (name): Promise<unknown> => {
			try {
				const raw = await readVaultFile(joinVaultPath(dir, name));
				return JSON.parse(raw) as unknown;
			} catch {
				return CORRUPT_MARK;
			}
		}),
	);
	return loaded.filter((mark) => mark !== CORRUPT_MARK);
}

export async function readMarkRaw(
	paperAbsPath: string,
	id: string,
): Promise<unknown | null> {
	if (!paperAbsPath || !id || !isTauri()) return null;
	try {
		const raw = await readVaultFile(markPath(paperAbsPath, id));
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

/**
 * Self-write echo suppression: watcher events caused by this app's own
 * `marks/` writes are pure echo for the marks refresh (the writer already
 * updated in-memory state), so the marks watcher skips events whose paths are
 * all recent self-writes. Writers register the path here; the TTL covers the
 * filesystem-watcher latency between write and event.
 */
const SELF_WRITE_TTL_MS = 3000;
const selfWrites = new Map<string, number>();

/** Register a `marks/` path this app is about to write (echo suppression). */
export function markSelfWrite(path: string): void {
	const now = Date.now();
	selfWrites.set(normalizePathKey(path), now);
	for (const [key, at] of selfWrites) {
		if (now - at > SELF_WRITE_TTL_MS) selfWrites.delete(key);
	}
}

/** True when `path` was written by this app within the echo TTL. */
export function isRecentSelfWrite(path: string): boolean {
	const at = selfWrites.get(normalizePathKey(path));
	return at !== undefined && Date.now() - at <= SELF_WRITE_TTL_MS;
}

export async function writeMarkFile(
	paperAbsPath: string,
	id: string,
	payload: unknown,
): Promise<void> {
	const path = markPath(paperAbsPath, id);
	markSelfWrite(path);
	await writeVaultFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

export async function deleteMarkFile(
	paperAbsPath: string,
	id: string,
): Promise<void> {
	if (!isTauri() || !paperAbsPath || !id) return;
	markSelfWrite(markPath(paperAbsPath, id));
	try {
		await removeVaultPath(markPath(paperAbsPath, id));
	} catch {
		// missing is fine
	}
}
