/**
 * Wiki state (zustand vanilla): index revision signal and external-rename
 * repair flow. Also owns the debounced wiki rebuild scheduler and the
 * watcher-echo filters (internal rename transactions and self-writes;
 * module-level timers replace the old App refs).
 */

import { createStore } from "zustand/vanilla";
import { perfOp, perfWait } from "@/lib/core/perf";
import {
	clearRefreshWave,
	noteWikiPath,
	registerWikiRevisionBump,
} from "@/lib/lifecycle/refresh-wave";
import { isResearchTablePath } from "@/lib/research-table/model";
import type { VaultFileChangedPayload } from "@/lib/vault/fs-watch";
import { watchRefreshDelayMs } from "@/lib/vault/shell-activity";
import { getVaultPath } from "@/lib/vault/store";
import { rebuildWikiIndex, type WikiExternalRenamePreview } from "@/lib/wiki";
import { notifyWikiEmbedTargets } from "@/lib/wiki/embed-refresh";
import { isWikiTargetPath } from "@/lib/wiki/target-path";
import { normalizeTabPath } from "@/lib/workspace/tabs";

export type ExternalRenameFailure = {
	from: string;
	to: string;
	error: string;
	affectedSources: number | null;
	zeroWrite: boolean;
	rollback?: string;
};

type WikiStore = {
	/** Bumped after graph_rebuild so Backlinks/Graph re-fetch. */
	wikiIndexRevision: number;
	/** Awaiting the user's decision for one verified external local rename. */
	externalRenamePreview: WikiExternalRenamePreview | null;
	externalRenameVaultPath: string | null;
	externalRenameRepairing: boolean;
	/** A no-write preflight failure that still needs an actionable review surface. */
	externalRenameFailure: ExternalRenameFailure | null;
};

export const wikiStore = createStore<WikiStore>(() => ({
	wikiIndexRevision: 0,
	externalRenamePreview: null,
	externalRenameVaultPath: null,
	externalRenameRepairing: false,
	externalRenameFailure: null,
}));

export function bumpWikiIndexRevision(): void {
	wikiStore.setState((s) => ({ wikiIndexRevision: s.wikiIndexRevision + 1 }));
}

export function setExternalRenamePreview(
	preview: WikiExternalRenamePreview | null,
): void {
	wikiStore.setState({ externalRenamePreview: preview });
}

export function setExternalRenameVaultPath(path: string | null): void {
	wikiStore.setState({ externalRenameVaultPath: path });
}

export function setExternalRenameRepairing(repairing: boolean): void {
	wikiStore.setState({ externalRenameRepairing: repairing });
}

export function setExternalRenameFailure(
	failure: ExternalRenameFailure | null,
): void {
	wikiStore.setState({ externalRenameFailure: failure });
}

/** Rebuild wiki index and notify Backlinks/Graph panels to re-fetch. */
export async function rebuildWikiAndNotify(path: string): Promise<void> {
	try {
		await perfOp("graph_rebuild", () => rebuildWikiIndex(path));
		bumpWikiIndexRevision();
	} catch {
		// Index rebuild is best-effort; panels re-fetch on next path change.
	}
}

/** Debounced embed refresh for autosave echoes. External paths join the refresh wave. */
let wikiRebuildTimer: ReturnType<typeof setTimeout> | null = null;
/** Self-write echoes that only refresh mounted embeds, skipping the index update. */
const wikiEchoEmbedPaths = new Set<string>();

function queueEmbedRefresh(absPath: string): void {
	wikiEchoEmbedPaths.add(absPath);
	if (wikiRebuildTimer) clearTimeout(wikiRebuildTimer);
	const scheduledAt = performance.now();
	const delay = watchRefreshDelayMs("wiki");
	wikiRebuildTimer = setTimeout(() => {
		wikiRebuildTimer = null;
		perfWait("watch_wait.wiki", performance.now() - scheduledAt);
		const echoPaths = [...wikiEchoEmbedPaths];
		wikiEchoEmbedPaths.clear();
		if (!getVaultPath() || echoPaths.length === 0) return;
		notifyWikiEmbedTargets(echoPaths);
	}, delay);
}

/**
 * Markdown files carry references; images and PDFs are canonical targets
 * whose create/remove/modify events also invalidate link resolution and
 * embedded attachment projections. Research tables are embed targets only:
 * a file change refreshes mounted previews and does not rebuild the link index.
 */
export function scheduleWikiRebuild(absPath: string): void {
	if (isResearchTablePath(absPath)) {
		if (!getVaultPath()) return;
		queueEmbedRefresh(absPath);
		return;
	}
	if (!isWikiTargetPath(absPath)) return;
	// Autosave/⌘S echo: the save path already folded this file into the index,
	// so the watcher only refreshes mounted embeds (#270).
	if (isSelfWrittenPath(absPath)) {
		queueEmbedRefresh(absPath);
		return;
	}
	if (!getVaultPath()) return;
	noteWikiPath(absPath);
}

/** Paths this app just wrote to disk; their watcher echoes skip the rebuild. */
const selfWrittenPaths = new Map<
	string,
	{ expiresAt: number; content?: string }
>();

/** Watcher echoes of an app write settle well within this window. */
const SELF_WRITE_ECHO_TTL_MS = 4000;

/**
 * Remember a path this app wrote to disk so its watcher echo does not
 * re-trigger a full Wiki rebuild on every autosave. `content`, when passed,
 * lets editor reload ignore that same body even if the tab seed is still stale.
 */
export function trackSelfWrittenPath(path: string, content?: string): void {
	selfWrittenPaths.set(normalizeTabPath(path), {
		expiresAt: Date.now() + SELF_WRITE_ECHO_TTL_MS,
		...(content !== undefined ? { content } : {}),
	});
}

function selfWriteEcho(
	absPath: string,
): { expiresAt: number; content?: string } | null {
	const now = Date.now();
	const normalized = normalizeTabPath(absPath);
	let matched: { expiresAt: number; content?: string } | null = null;
	for (const [path, entry] of selfWrittenPaths) {
		if (entry.expiresAt <= now) {
			selfWrittenPaths.delete(path);
			continue;
		}
		if (path === normalized) matched = entry;
	}
	return matched;
}

function isSelfWrittenPath(absPath: string): boolean {
	return selfWriteEcho(absPath) !== null;
}

/** True when `content` is the body just written to `path` by this app. */
export function isSelfWrittenContent(path: string, content: string): boolean {
	return selfWriteEcho(path)?.content === content;
}

/** Host watcher paths caused by a committed rename transaction. */
const internalRenamePaths = new Map<string, number>();

export function trackInternalRenamePaths(
	paths: string[],
	expiresAt: number,
): void {
	for (const path of paths) {
		internalRenamePaths.set(normalizeTabPath(path), expiresAt);
	}
}

export function shouldIgnoreInternalRenameEvent(
	payload: VaultFileChangedPayload,
): boolean {
	const now = Date.now();
	for (const [path, expiresAt] of internalRenamePaths) {
		if (expiresAt <= now) internalRenamePaths.delete(path);
	}
	if (payload.paths.length === 0 || internalRenamePaths.size === 0) {
		return false;
	}
	return payload.paths.every((path) => {
		const normalized = normalizeTabPath(path);
		for (const tracked of internalRenamePaths.keys()) {
			if (
				normalized === tracked ||
				normalized.startsWith(`${tracked}/`) ||
				(normalized.includes(".agentero-rename-") &&
					normalized.slice(0, normalized.lastIndexOf("/")) ===
						tracked.slice(0, tracked.lastIndexOf("/")))
			) {
				return true;
			}
		}
		return false;
	});
}

/**
 * Drop wiki state belonging to the vault being closed: the external-rename
 * repair flow plus every watcher-echo collection, whose entries would otherwise
 * be matched against the next vault's paths. `wikiIndexRevision` is left alone
 * because subscribers compare its monotonic value.
 */
export function clearWikiVaultState(): void {
	if (wikiRebuildTimer) {
		clearTimeout(wikiRebuildTimer);
		wikiRebuildTimer = null;
	}
	wikiEchoEmbedPaths.clear();
	clearRefreshWave();
	selfWrittenPaths.clear();
	internalRenamePaths.clear();
	wikiStore.setState({
		externalRenamePreview: null,
		externalRenameVaultPath: null,
		externalRenameRepairing: false,
		externalRenameFailure: null,
	});
}

registerWikiRevisionBump(bumpWikiIndexRevision);
