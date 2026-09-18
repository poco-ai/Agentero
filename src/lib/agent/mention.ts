/**
 * Composer `@` mention candidates: Vault directories (incl. papers) + Markdown files.
 * Empty query surfaces recent paths and shallow tree hints; typed query filters by path.
 */

import type { ComposerStateStorage } from "@/lib/agent/composer-state";
import { normalizeContextPath } from "@/lib/agent/context-path-icon";
import { isPlazaMentionPath } from "@/lib/agent/plaza-mention";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";

const RECENT_PREFIX = "agentero-agent-mention-recent-v1";
const RECENT_LIMIT = 12;
const DEFAULT_MENU_LIMIT = 8;

export type { ComposerStateStorage };

function normPath(path: string): string {
	return normalizeContextPath(path);
}

/** Path segment depth (`papers/a/b` → 3). */
export function mentionPathDepth(path: string): number {
	const n = normPath(path);
	if (!n) return 0;
	return n.split("/").filter(Boolean).length;
}

export function isUnderPaperPath(
	path: string,
	paperPaths: ReadonlySet<string> | Iterable<string>,
): boolean {
	const n = normPath(path);
	if (!n) return false;
	const set =
		paperPaths instanceof Set
			? paperPaths
			: new Set([...paperPaths].map(normPath).filter(Boolean));
	for (const paper of set) {
		if (!paper) continue;
		if (n === paper || n.startsWith(`${paper}/`)) return true;
	}
	return false;
}

/**
 * Build unique Vault-relative mention targets:
 * - paper folders (preferred unit under papers/)
 * - other directories (org folders, notes/, …)
 * - Markdown files **outside** paper folders (NOTES.md inside a paper is omitted)
 */
export function buildMentionCandidatePaths(options: {
	markdownPaths?: readonly string[] | null;
	directoryPaths?: readonly string[] | null;
	paperPaths?: readonly string[] | null;
}): string[] {
	const papers = new Set(
		(options.paperPaths ?? []).map(normPath).filter(Boolean),
	);
	const out: string[] = [];
	const seen = new Set<string>();

	const push = (raw: string) => {
		const p = normPath(raw);
		if (!p || seen.has(p)) return;
		seen.add(p);
		out.push(p);
	};

	for (const p of papers) push(p);

	for (const raw of options.directoryPaths ?? []) {
		const p = normPath(raw);
		if (!p) continue;
		// Skip dirs nested inside a paper (source/, assets/, …)
		if (isUnderPaperPath(p, papers) && !papers.has(p)) continue;
		push(p);
	}

	for (const raw of options.markdownPaths ?? []) {
		const p = normPath(raw);
		if (!p) continue;
		// Prefer attaching the paper unit over NOTES.md / PAPER.md inside it
		if (isUnderPaperPath(p, papers)) continue;
		push(p);
	}

	return out;
}

function pathMatchesQuery(path: string, query: string): boolean {
	if (!query) return true;
	const p = normPath(path).toLocaleLowerCase();
	const q = query.replace(/\\/g, "/").toLocaleLowerCase().replace(/^\/+/, "");
	if (!q) return true;
	if (p.includes(q)) return true;
	const base = p.split("/").pop() ?? p;
	return base.includes(q);
}

/** Parent vault-relative path (`papers/org/a` → `papers/org`; `papers` → null). */
export function mentionParentPath(
	path: string | null | undefined,
): string | null {
	const n = normPath(path ?? "");
	if (!n) return null;
	const idx = n.lastIndexOf("/");
	if (idx <= 0) return null;
	return n.slice(0, idx) || null;
}

/**
 * Direct children of `parent` among candidates (and intermediate segments).
 * `parent` null/empty → vault root (first path segment only).
 */
export function listMentionChildren(
	parent: string | null | undefined,
	candidates: readonly string[],
): string[] {
	const root = parent ? normPath(parent) : "";
	const prefix = root ? `${root}/` : "";
	const seen = new Set<string>();
	const out: string[] = [];

	for (const raw of candidates) {
		const p = normPath(raw);
		if (!p) continue;
		if (root) {
			if (p === root || !p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length);
			const slash = rest.indexOf("/");
			const childRel = slash === -1 ? rest : rest.slice(0, slash);
			if (!childRel) continue;
			const child = `${root}/${childRel}`;
			if (seen.has(child)) continue;
			seen.add(child);
			out.push(child);
		} else {
			const first = p.split("/").filter(Boolean)[0];
			if (!first || seen.has(first)) continue;
			seen.add(first);
			out.push(first);
		}
	}

	return out.sort((a, b) =>
		a.localeCompare(b, undefined, { sensitivity: "base" }),
	);
}

/**
 * Whether a path can be drilled into in the @ menu.
 * Paper folders are leaves (internals are not listed as candidates).
 */
export function mentionPathHasChildren(
	path: string,
	candidates: readonly string[],
	paperPaths?: ReadonlySet<string> | Iterable<string> | null,
): boolean {
	const n = normPath(path);
	if (!n) return false;
	if (paperPaths) {
		const set =
			paperPaths instanceof Set
				? paperPaths
				: new Set([...paperPaths].map(normPath).filter(Boolean));
		if (set.has(n)) return false;
	}
	const prefix = `${n}/`;
	return candidates.some((c) => {
		const p = normPath(c);
		return Boolean(p && p !== n && p.startsWith(prefix));
	});
}

/**
 * Rank and slice mention candidates for the composer menu.
 * Empty query → recents first, then shallow tree (depth ≤ 2), then the rest.
 * Non-empty query → path substring match; recents boosted.
 * When `browseRoot` is set → list that folder's **direct children** (drill-down).
 */
export function filterMentionOptions(options: {
	candidates: readonly string[];
	query: string;
	exclude?: readonly string[];
	recent?: readonly string[];
	/** Extra searchable labels keyed by path (paper titles, …). */
	labelsByPath?: ReadonlyMap<string, string> | null;
	/**
	 * When set, show only direct children of this directory (in-folder browse).
	 * Ignores shallow/recent ranking.
	 */
	browseRoot?: string | null;
	limit?: number;
}): string[] {
	const limit = options.limit ?? DEFAULT_MENU_LIMIT;
	const exclude = new Set(
		(options.exclude ?? []).map(normPath).filter(Boolean),
	);
	const recent = (options.recent ?? []).map(normPath).filter(Boolean);
	const recentRank = new Map(recent.map((p, i) => [p, i]));
	const query = (options.query ?? "").trim();
	const labels = options.labelsByPath;
	const browseRoot = options.browseRoot ? normPath(options.browseRoot) : null;

	const matchesExtra = (path: string): boolean => {
		if (!query || !labels) return false;
		const label = labels.get(path)?.toLocaleLowerCase();
		if (!label) return false;
		return label.includes(query.toLocaleLowerCase());
	};

	// Drill-down: list children of the browsed folder only.
	if (browseRoot) {
		const children = listMentionChildren(browseRoot, options.candidates)
			.filter((p) => !exclude.has(p))
			.filter((p) => !query || pathMatchesQuery(p, query) || matchesExtra(p));
		return children.slice(0, Math.max(limit, 24));
	}

	const pool = options.candidates
		.map(normPath)
		.filter((p) => p && !exclude.has(p))
		.filter((p) => {
			if (!isPlazaMentionPath(p)) return true;
			// Plaza entries are title-search targets: surface on typed queries
			// (label match below) or as recents, never in the empty-query
			// shallow tree or folder drill-downs.
			return Boolean(query) || recentRank.has(p);
		})
		.filter((p) => !query || pathMatchesQuery(p, query) || matchesExtra(p));

	if (pool.length === 0) return [];

	const score = (path: string): number => {
		const r = recentRank.get(path);
		const recentBoost = r !== undefined ? 1_000_000 - r : 0;
		if (!query) {
			const depth = mentionPathDepth(path);
			// Prefer recents, then shallow tree, then deeper paths
			const depthScore =
				depth <= 2 ? 10_000 - depth : 100 - Math.min(depth, 50);
			return recentBoost + depthScore;
		}
		const p = path.toLocaleLowerCase();
		const q = query.toLocaleLowerCase();
		const base = p.split("/").pop() ?? p;
		let matchScore = 0;
		if (base.startsWith(q)) matchScore += 500;
		else if (base.includes(q)) matchScore += 300;
		else if (p.includes(q)) matchScore += 100;
		if (matchesExtra(path)) matchScore += 200;
		return recentBoost + matchScore;
	};

	return [...pool]
		.sort((a, b) => {
			const d = score(b) - score(a);
			if (d !== 0) return d;
			return a.localeCompare(b, undefined, { sensitivity: "base" });
		})
		.slice(0, limit);
}

function recentStorageKey(vaultPath: string): string {
	return `${RECENT_PREFIX}:${encodeURIComponent(vaultPath)}`;
}

export function loadRecentMentionPaths(
	storage: ComposerStateStorage | null | undefined,
	vaultPath: string | null,
): string[] {
	if (!storage || !vaultPath) return [];
	const parsed = readJsonStorage<unknown>(
		recentStorageKey(vaultPath),
		null,
		storage,
	);
	if (!Array.isArray(parsed)) return [];
	return [
		...new Set(
			parsed
				.filter((item): item is string => typeof item === "string")
				.map(normPath)
				.filter(Boolean),
		),
	].slice(0, RECENT_LIMIT);
}

export function pushRecentMentionPath(
	storage: ComposerStateStorage | null | undefined,
	vaultPath: string | null,
	path: string,
): string[] {
	if (!storage || !vaultPath) return [];
	const next = normPath(path);
	if (!next) return loadRecentMentionPaths(storage, vaultPath);
	const prev = loadRecentMentionPaths(storage, vaultPath).filter(
		(p) => p !== next,
	);
	const updated = [next, ...prev].slice(0, RECENT_LIMIT);
	// best-effort
	writeJsonStorage(recentStorageKey(vaultPath), updated, storage);
	return updated;
}
