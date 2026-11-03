/**
 * One refresh for a burst of imports, renames, and the files this app just
 * wrote. The disk work is a catalog list (or one `ensure_row` per paper) and
 * a wiki update of the touched paths. A full library rescan stays on the
 * external callers that cannot name a paper folder.
 *
 * An open import or metadata-recognition job holds the wave open, so a batch
 * whose papers land slower than the old debounce still refreshes once.
 */

import { backgroundTasksStore } from "@/lib/core/background-tasks";
import { perfWait } from "@/lib/core/perf";
import { isTauri } from "@/lib/core/tauri";
import { ensurePaperRows, listPapers } from "@/lib/paper/api";
import { libraryStore, setLibraryPapers } from "@/lib/paper/library-store";
import type { PaperLibraryRow } from "@/lib/paper/types";
import { normalizePathKey } from "@/lib/vault/path";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { watchRefreshDelayMs } from "@/lib/vault/shell-activity";
import {
	getVaultPath,
	refreshKnownDirectories,
	removeTreePaths,
	scheduleTreeRefresh,
} from "@/lib/vault/store";
import { applyWikiPaths } from "@/lib/wiki/api";
import { notifyWikiEmbedTargets } from "@/lib/wiki/embed-refresh";

const WAVE_KINDS = new Set(["import", "recognizeMetadata"]);

type LibraryMode = "none" | "list" | "ensure";

type Bucket = {
	library: LibraryMode;
	ensurePaths: Set<string>;
	wikiPaths: Set<string>;
	treePaths: Set<string>;
	treeRemove: Set<string>;
};

function emptyBucket(): Bucket {
	return {
		library: "none",
		ensurePaths: new Set(),
		wikiPaths: new Set(),
		treePaths: new Set(),
		treeRemove: new Set(),
	};
}

function rank(mode: LibraryMode): number {
	if (mode === "ensure") return 2;
	if (mode === "list") return 1;
	return 0;
}

function upgrade(bucket: Bucket, mode: LibraryMode): void {
	if (rank(mode) > rank(bucket.library)) bucket.library = mode;
}

function hasWork(bucket: Bucket): boolean {
	return (
		bucket.library !== "none" ||
		bucket.wikiPaths.size > 0 ||
		bucket.treePaths.size > 0 ||
		bucket.treeRemove.size > 0
	);
}

let wave = emptyBucket();
let external = emptyBucket();
let waveTimer: ReturnType<typeof setTimeout> | null = null;
let externalTimer: ReturnType<typeof setTimeout> | null = null;
let waveFlushing = false;
let externalFlushing = false;
const committedPrefixes = new Set<string>();
let waveSubscribed = false;
let bumpWikiRevision: (() => void) | null = null;

function norm(path: string): string {
	return normalizePathKey(path).replace(/\/+$/, "");
}

export function registerWikiRevisionBump(bump: () => void): void {
	bumpWikiRevision = bump;
}

/**
 * Workspace sync that runs after an external Library refresh. Wired by the
 * lifecycle registration so this coordinator keeps no dependency on the
 * tab/workspace modules it would otherwise close a cycle with.
 */
export type ExternalLibraryReconciler = (
	vaultPath: string,
	previous: readonly PaperLibraryRow[],
	next: readonly PaperLibraryRow[],
) => Promise<void>;

let externalLibraryReconciler: ExternalLibraryReconciler | null = null;

export function registerExternalLibraryReconciler(
	reconciler: ExternalLibraryReconciler | null,
): void {
	externalLibraryReconciler = reconciler;
}

export function isCommittedRefreshPath(path: string): boolean {
	const key = norm(path);
	if (!key) return false;
	for (const prefix of committedPrefixes) {
		if (key === prefix || key.startsWith(`${prefix}/`)) return true;
	}
	return false;
}

function rememberCommitted(path: string): void {
	const key = norm(path);
	if (key) committedPrefixes.add(key);
}

function forgetCommitted(path: string): void {
	const key = norm(path);
	if (!key) return;
	for (const prefix of committedPrefixes) {
		if (prefix === key || prefix.startsWith(`${key}/`)) {
			committedPrefixes.delete(prefix);
		}
	}
}

function waveActive(): boolean {
	return backgroundTasksStore.getState().tasks.some((task) => {
		return (
			WAVE_KINDS.has(task.kind) &&
			(task.status === "queued" || task.status === "running")
		);
	});
}

function ensureWaveSubscription(): void {
	if (waveSubscribed) return;
	waveSubscribed = true;
	backgroundTasksStore.subscribe(() => {
		if (waveActive()) return;
		if (hasWork(wave)) scheduleWaveFlush();
		if (hasWork(external)) scheduleExternalFlush();
	});
}

function scheduleWaveFlush(): void {
	ensureWaveSubscription();
	if (waveTimer) clearTimeout(waveTimer);
	if (waveActive()) {
		waveTimer = null;
		return;
	}
	const scheduledAt = performance.now();
	const delay = watchRefreshDelayMs("library");
	waveTimer = setTimeout(() => {
		waveTimer = null;
		perfWait("watch_wait.library", performance.now() - scheduledAt);
		void flushWave();
	}, delay);
}

function scheduleExternalFlush(): void {
	if (externalTimer) clearTimeout(externalTimer);
	if (waveActive()) {
		externalTimer = null;
		return;
	}
	const wikiOnly = external.library === "none";
	const scheduledAt = performance.now();
	const delay = watchRefreshDelayMs(wikiOnly ? "wiki" : "library");
	externalTimer = setTimeout(() => {
		externalTimer = null;
		perfWait(
			wikiOnly ? "watch_wait.wiki" : "watch_wait.library",
			performance.now() - scheduledAt,
		);
		void flushExternal();
	}, delay);
}

/** Catalog row is already written. Refresh the list and these paths once. */
export function noteCommittedPaths(paths: string[]): void {
	if (paths.length === 0) {
		noteCommittedLibraryList();
		return;
	}
	upgrade(wave, "list");
	for (const path of paths) {
		rememberCommitted(path);
		wave.wikiPaths.add(path);
		wave.treePaths.add(path);
	}
	scheduleWaveFlush();
}

/** A committed rename: drop the old prefix and refresh both endpoints. */
export function noteCommittedRename(fromAbs: string, toAbs: string): void {
	forgetCommitted(fromAbs);
	rememberCommitted(toAbs);
	upgrade(wave, "list");
	wave.wikiPaths.add(fromAbs);
	wave.wikiPaths.add(toAbs);
	wave.treeRemove.add(fromAbs);
	wave.treePaths.add(toAbs);
	scheduleWaveFlush();
}

/**
 * File-tree paths from the watcher. While an import wave is open they wait
 * for that wave, so a batch does not re-list `papers/` once per paper.
 */
export function noteTreePaths(paths: string[]): void {
	const deferred: string[] = [];
	const immediate: string[] = [];
	for (const path of paths) {
		if (!path) continue;
		if (waveActive() || isCommittedRefreshPath(path)) deferred.push(path);
		else immediate.push(path);
	}
	if (deferred.length > 0) {
		for (const path of deferred) wave.treePaths.add(path);
		scheduleWaveFlush();
	}
	if (immediate.length > 0) scheduleTreeRefresh(immediate);
}

/** Quiet catalog list, coalesced with an in-flight import wave. */
export function noteCommittedLibraryList(): void {
	upgrade(wave, "list");
	scheduleWaveFlush();
}

/**
 * Wiki path from the watcher. Files this wave just wrote stay on the wave;
 * everything else debounces on its own.
 */
export function noteWikiPath(path: string): void {
	if (!path) return;
	if (isCommittedRefreshPath(path)) {
		wave.wikiPaths.add(path);
		scheduleWaveFlush();
		return;
	}
	external.wikiPaths.add(path);
	scheduleExternalFlush();
}

/** Watcher paths under papers/ that this app did not just commit. */
export function noteExternalLibraryPaths(paths: string[]): void {
	const outside: string[] = [];
	let held = false;
	for (const path of paths) {
		if (isCommittedRefreshPath(path)) {
			wave.wikiPaths.add(path);
			held = true;
		} else {
			outside.push(path);
		}
	}
	if (held) scheduleWaveFlush();
	if (outside.length === 0) return;
	upgrade(external, "ensure");
	for (const path of outside) {
		external.ensurePaths.add(path);
		external.wikiPaths.add(path);
	}
	scheduleExternalFlush();
}

export function clearRefreshWave(): void {
	if (waveTimer) clearTimeout(waveTimer);
	if (externalTimer) clearTimeout(externalTimer);
	waveTimer = null;
	externalTimer = null;
	wave = emptyBucket();
	external = emptyBucket();
	committedPrefixes.clear();
}

async function flushWave(): Promise<void> {
	if (waveActive()) {
		scheduleWaveFlush();
		return;
	}
	if (waveFlushing || !hasWork(wave)) return;
	waveFlushing = true;
	const bucket = wave;
	wave = emptyBucket();
	try {
		await flushBucket(bucket);
	} finally {
		committedPrefixes.clear();
		waveFlushing = false;
		if (hasWork(wave)) scheduleWaveFlush();
	}
}

async function flushExternal(): Promise<void> {
	if (externalFlushing || !hasWork(external)) return;
	externalFlushing = true;
	const bucket = external;
	external = emptyBucket();
	try {
		await flushBucket(bucket);
	} finally {
		externalFlushing = false;
		if (hasWork(external)) scheduleExternalFlush();
	}
}

async function flushBucket(bucket: Bucket): Promise<void> {
	const vault = getVaultPath();
	if (!vault || !isTauri() || isRemoteVaultHandle(vault)) return;
	if (bucket.treeRemove.size > 0) {
		removeTreePaths([...bucket.treeRemove]);
	}
	if (bucket.treePaths.size > 0) {
		await refreshKnownDirectories([...bucket.treePaths]);
	}
	try {
		if (bucket.library === "ensure") {
			await ensurePaperRows(vault, [...bucket.ensurePaths]);
		}
		if (bucket.library !== "none") {
			const papers = await listPapers(vault);
			if (getVaultPath() === vault) {
				// External tools move papers without a trustworthy rename pair;
				// carry open tabs/annotations to the catalog's new paths first.
				if (externalLibraryReconciler) {
					try {
						await externalLibraryReconciler(
							vault,
							libraryStore.getState().papers,
							papers,
						);
					} catch {
						// Workspace remap is best-effort; the catalog rows below
						// must still publish.
					}
				}
				setLibraryPapers(papers);
			}
		}
	} catch {
		// Background catalog refresh is best-effort. The next watcher burst retries.
	}
	if (bucket.wikiPaths.size === 0) return;
	const wikiPaths = [...bucket.wikiPaths];
	try {
		await applyWikiPaths(vault, wikiPaths);
		bumpWikiRevision?.();
	} catch {
		// Index update is best-effort; panels re-fetch on the next path change.
	}
	notifyWikiEmbedTargets(wikiPaths);
}
