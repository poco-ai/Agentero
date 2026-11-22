/**
 * Per-harness ACP history cache for Zen.
 *
 * The only source of truth for a harness's sessions is its own process
 * (`session/list`), and every query can spawn + initialize that harness. Zen
 * aggregates every installed harness, so a naive fan-out pays N cold starts and
 * shows nothing until the slowest one answers (measured: 10.7 s on this
 * machine, with one harness taking 10 s while others needed 0.3–4 s).
 *
 * Cache one entry per (vault, agent) and paint it synchronously before
 * revalidating. Histories only change when a harness writes a session, which is
 * rare while Zen is open, so a five-minute window plus explicit invalidations
 * (registry changes, closing a session) is enough to stay fresh.
 */
import { type AcpSessionInfo, listSessions } from "@/lib/agent/api";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";

export type HarnessHistoryEntry = {
	sessions: AcpSessionInfo[];
	supported: boolean;
	fetchedAt: number;
};

const STORAGE_KEY = "agentero.harness-history.v1";
/** Revalidate window for a harness that was queried successfully. */
const TTL_MS = 5 * 60_000;
/** The Zen sidebar is a recency list; keep the newest rows only. */
const MAX_SESSIONS = 80;
const MAX_ENTRIES = 40;

type Persisted = Record<string, HarnessHistoryEntry>;

let entries: Map<string, HarnessHistoryEntry> | null = null;
const inflight = new Map<string, Promise<HarnessHistoryEntry>>();

function cacheKey(vaultPath: string | null, agentId: string): string {
	return `${vaultPath ?? ""}\u0000${agentId}`;
}

function isSessionInfo(value: unknown): value is AcpSessionInfo {
	if (!value || typeof value !== "object") return false;
	const session = value as AcpSessionInfo;
	return typeof session.sessionId === "string" && session.sessionId.length > 0;
}

function sanitizeEntry(value: unknown): HarnessHistoryEntry | null {
	if (!value || typeof value !== "object") return null;
	const entry = value as Partial<HarnessHistoryEntry>;
	if (!Array.isArray(entry.sessions)) return null;
	const sessions = entry.sessions.filter(isSessionInfo).slice(0, MAX_SESSIONS);
	const fetchedAt = typeof entry.fetchedAt === "number" ? entry.fetchedAt : 0;
	return {
		sessions,
		supported: entry.supported === true,
		fetchedAt,
	};
}

function load(): Map<string, HarnessHistoryEntry> {
	if (entries) return entries;
	const parsed = readJsonStorage<unknown>(STORAGE_KEY, null);
	entries = new Map();
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		for (const [key, value] of Object.entries(parsed as Persisted)) {
			const entry = sanitizeEntry(value);
			if (entry) entries.set(key, entry);
		}
	}
	return entries;
}

function persist(): void {
	if (!entries) return;
	const newest = [...entries.entries()]
		.sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
		.slice(0, MAX_ENTRIES);
	writeJsonStorage(STORAGE_KEY, Object.fromEntries(newest));
}

/** Last known history for a harness, or `null` when it was never queried. */
export function cachedHarnessHistory(
	vaultPath: string | null,
	agentId: string,
): HarnessHistoryEntry | null {
	return load().get(cacheKey(vaultPath, agentId)) ?? null;
}

/** Whether {@link cachedHarnessHistory} is recent enough to skip a query. */
export function isHarnessHistoryFresh(
	entry: HarnessHistoryEntry | null,
	now = Date.now(),
): boolean {
	return entry !== null && now - entry.fetchedAt < TTL_MS;
}

/**
 * Query one harness, sharing the request with concurrent callers. Rejects when
 * the harness fails so callers can keep showing cached rows.
 */
export function fetchHarnessHistory(request: {
	vaultPath: string | null;
	agentId: string;
}): Promise<HarnessHistoryEntry> {
	const key = cacheKey(request.vaultPath, request.agentId);
	const running = inflight.get(key);
	if (running) return running;
	const pending = listSessions({
		agentId: request.agentId,
		vaultPath: request.vaultPath ?? undefined,
	})
		.then((result) => {
			const sessions = result.supported
				? [...result.sessions]
						.sort((a, b) =>
							(b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
						)
						.slice(0, MAX_SESSIONS)
				: [];
			const entry: HarnessHistoryEntry = {
				sessions,
				supported: result.supported,
				fetchedAt: Date.now(),
			};
			load().set(key, entry);
			persist();
			return entry;
		})
		.finally(() => {
			if (inflight.get(key) === pending) inflight.delete(key);
		});
	inflight.set(key, pending);
	return pending;
}

/**
 * Drop cached history for one harness, or for every harness when `agentId` is
 * omitted. Used for registry changes (install/remove/probe) and for a session
 * the user just closed.
 */
export function invalidateHarnessHistory(agentId?: string): void {
	const suffix = agentId ? `\u0000${agentId}` : null;
	const map = load();
	let changed = false;
	for (const key of [...map.keys()]) {
		if (suffix === null || key.endsWith(suffix)) {
			map.delete(key);
			changed = true;
		}
	}
	if (changed) persist();
}
