/**
 * Local writing history.
 *
 * Snapshots live in the app data directory, outside the vault, so a OneDrive
 * copy of the project is not the timeline. Autosave of a thesis source file
 * records one; identical text is skipped, and edits a couple of minutes apart
 * update the latest snapshot instead of adding another.
 */

import { appLocalDataDir, join } from "@tauri-apps/api/path";
import {
	mkdir,
	readTextFile,
	remove,
	writeTextFile,
} from "@tauri-apps/plugin-fs";
import { createStore } from "zustand/vanilla";
import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { basenameOf, normalizePath } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import { joinVaultPath } from "@/lib/vault/path";
import { getVaultPath } from "@/lib/vault/store";
import { writingHistoryProjectRel } from "@/lib/writing/session";
import { explicitWritingProjectForPath } from "./project-manifest";

export const HISTORY_COALESCE_MS = 120_000;
export const HISTORY_LIMIT = 80;
export const HISTORY_MAX_CHARS = 1_500_000;

const SOURCE_EXTENSIONS = new Set([
	"bib",
	"bst",
	"clo",
	"cls",
	"md",
	"sty",
	"tex",
	"txt",
]);

export type HistoryEntry = {
	id: string;
	at: number;
	rel: string;
	bytes: number;
	hash: string;
};

export type SnapshotPlan =
	| { action: "skip" }
	| {
			action: "write";
			entry: HistoryEntry;
			entries: HistoryEntry[];
			dropIds: string[];
			replace: boolean;
	  };

type SaveOptions = {
	/** Restore always keeps the previous snapshot, even inside the coalesce window. */
	force?: boolean;
	now?: number;
	id?: string;
};

const queues = new Map<string, Promise<unknown>>();

export const writingFileReloadStore = createStore<{
	path: string;
	token: number;
}>(() => ({ path: "", token: 0 }));

/** Remount every open writing editor after a history restore wrote the files. */
export function reloadOpenWritingFiles(): void {
	writingFileReloadStore.setState((state) => ({
		path: "*",
		token: state.token + 1,
	}));
}

export function isHistorySourceName(name: string): boolean {
	const lower = name.toLowerCase();
	if (lower === ".latexmkrc") return true;
	if (lower.startsWith(".")) return false;
	const dot = lower.lastIndexOf(".");
	const ext = dot >= 0 ? lower.slice(dot + 1) : "";
	return SOURCE_EXTENSIONS.has(ext);
}

export function contentHash(text: string): string {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return `${(hash >>> 0).toString(16)}:${text.length}`;
}

export function historyProjectKey(projectDir: string): string {
	const normalized = normalizePath(projectDir).toLowerCase();
	const name =
		basenameOf(projectDir)
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32) || "project";
	return `${name}-${contentHash(normalized).replaceAll(":", "-")}`;
}

export function safeProjectRel(rel: string): string | null {
	const parts = rel.split("/").filter((part) => part.length > 0);
	if (parts.length === 0) return null;
	if (parts.some((part) => part === "." || part === "..")) return null;
	return parts.join("/");
}

export function planSnapshot(
	entries: readonly HistoryEntry[],
	rel: string,
	content: string,
	now: number,
	id: string,
	force = false,
): SnapshotPlan {
	if (content.length > HISTORY_MAX_CHARS) return { action: "skip" };
	const safeRel = safeProjectRel(rel);
	if (!safeRel) return { action: "skip" };
	const hash = contentHash(content);
	const latest = [...entries].reverse().find((entry) => entry.rel === safeRel);
	if (latest?.hash === hash) return { action: "skip" };
	const replace =
		!force && latest != null && now - latest.at < HISTORY_COALESCE_MS;
	const entry: HistoryEntry = {
		id: replace && latest ? latest.id : id,
		at: now,
		rel: safeRel,
		bytes: content.length,
		hash,
	};
	const kept = replace
		? entries.filter((item) => item.id !== entry.id)
		: [...entries];
	const next = [...kept, entry];
	const dropIds: string[] = [];
	while (next.length > HISTORY_LIMIT) {
		const removed = next.shift();
		if (removed) dropIds.push(removed.id);
	}
	return {
		action: "write",
		entry,
		entries: next,
		dropIds,
		replace,
	};
}

function newSnapshotId(now: number): string {
	const rand = Math.random().toString(36).slice(2, 8);
	return `${now.toString(36)}-${rand}`;
}

function enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
	const prev = queues.get(key) ?? Promise.resolve();
	const run = prev.then(job, job);
	queues.set(
		key,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	return run;
}

/** Record a source save. Failures toast once; they do not block the editor save. */
export function noteWritingSave(absPath: string, content: string): void {
	void saveWritingSnapshot(absPath, content).catch((error: unknown) => {
		notifyError(i18n.t("sidebar:writing.historyFailed"), {
			id: "writing-history",
			description: errorText(error),
		});
	});
}

export async function saveWritingSnapshot(
	absPath: string,
	content: string,
	options: SaveOptions = {},
): Promise<void> {
	if (!isHistorySourceName(basenameOf(absPath))) return;
	const located = await locateProjectFile(absPath);
	if (!located) return;
	const key = historyProjectKey(located.projectDir);
	return enqueue(key, () =>
		writeSnapshot(located.projectDir, located.rel, content, options),
	);
}

async function locateProjectFile(
	absPath: string,
): Promise<{ projectDir: string; rel: string } | null> {
	if (!isTauri()) return null;
	const vault = getVaultPath();
	if (!vault) return null;
	const projectRel = writingHistoryProjectRel(vault, absPath);
	if (!projectRel) return null;
	const explicit = await explicitWritingProjectForPath(vault, absPath);
	const projectDir = explicit?.directory ?? joinVaultPath(vault, projectRel);
	const root = normalizePath(projectDir);
	const abs = normalizePath(absPath);
	const prefix = `${root}/`;
	if (!abs.startsWith(prefix)) return null;
	const rel = safeProjectRel(abs.slice(prefix.length));
	if (!rel) return null;
	return { projectDir, rel };
}

async function historyDir(projectDir: string): Promise<string> {
	const root = await appLocalDataDir();
	return join(root, "writing-history", historyProjectKey(projectDir));
}

async function readIndex(projectDir: string): Promise<HistoryEntry[]> {
	const dir = await historyDir(projectDir);
	try {
		const text = await readTextFile(await join(dir, "index.json"));
		return parseIndex(text);
	} catch {
		return [];
	}
}

function parseIndex(text: string): HistoryEntry[] {
	try {
		const parsed = JSON.parse(text) as { entries?: HistoryEntry[] };
		if (!Array.isArray(parsed.entries)) return [];
		return parsed.entries.filter(
			(entry) =>
				typeof entry?.id === "string" &&
				typeof entry.rel === "string" &&
				typeof entry.hash === "string" &&
				typeof entry.at === "number",
		);
	} catch {
		return [];
	}
}

async function writeSnapshot(
	projectDir: string,
	rel: string,
	content: string,
	options: SaveOptions,
): Promise<void> {
	const now = options.now ?? Date.now();
	const id = options.id ?? newSnapshotId(now);
	const entries = await readIndex(projectDir);
	const plan = planSnapshot(entries, rel, content, now, id, options.force);
	if (plan.action === "skip") return;
	const dir = await historyDir(projectDir);
	await mkdir(dir, { recursive: true });
	await writeTextFile(await join(dir, `${plan.entry.id}.txt`), content);
	await writeTextFile(
		await join(dir, "index.json"),
		JSON.stringify({ entries: plan.entries }),
	);
	await Promise.all(
		plan.dropIds.map(async (dropId) => {
			if (!/^[a-z0-9-]+$/i.test(dropId)) return;
			await remove(await join(dir, `${dropId}.txt`)).catch(() => undefined);
		}),
	);
}

export async function listWritingHistory(
	projectDir: string,
): Promise<HistoryEntry[]> {
	const entries = await readIndex(projectDir);
	return [...entries].reverse();
}

export async function readWritingSnapshot(
	projectDir: string,
	id: string,
): Promise<string> {
	if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("invalid snapshot");
	const dir = await historyDir(projectDir);
	return readTextFile(await join(dir, `${id}.txt`));
}

export function projectFilePath(
	projectDir: string,
	rel: string,
): string | null {
	const safe = safeProjectRel(rel);
	if (!safe) return null;
	return joinVaultPath(projectDir, safe);
}
