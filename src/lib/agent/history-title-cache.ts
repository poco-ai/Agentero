import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";

/**
 * Best-effort cache of hydrated ACP history titles.
 *
 * `session/list` does not include user prompts, so titles for agents like Kimi
 * must be derived via `session/load`. Caching avoids re-loading every session
 * on each Agent panel mount / history open (#484).
 *
 * Non-authoritative: a missing/stale entry just triggers another load.
 * User renames (#710) are stored as overrides and always win over ACP titles.
 */

const STORAGE_KEY = "agentero.agent-history-titles.v1";
const OVERRIDE_KEY = "agentero.agent-history-title-overrides.v1";
const EMPTY_KEY = "agentero.agent-empty-sessions.v1";
const DISMISSED_KEY = "agentero.agent-dismissed-sessions.v1";
const MAX_ENTRIES = 400;
const MAX_EMPTY = 2000;

type CacheMap = Record<string, string>;

function cacheKey(agentId: string, sessionId: string): string {
	return `${agentId}\0${sessionId}`;
}

function readAll(): CacheMap {
	const parsed = readJsonStorage<unknown>(STORAGE_KEY, null);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}
	const out: CacheMap = {};
	for (const [k, v] of Object.entries(parsed as CacheMap)) {
		if (typeof k === "string" && typeof v === "string" && v.trim()) {
			out[k] = v.trim();
		}
	}
	return out;
}

function writeAll(map: CacheMap): void {
	const entries = Object.entries(map);
	const trimmed =
		entries.length > MAX_ENTRIES
			? Object.fromEntries(entries.slice(entries.length - MAX_ENTRIES))
			: map;
	writeJsonStorage(STORAGE_KEY, trimmed);
}

function readOverrides(): CacheMap {
	const parsed = readJsonStorage<unknown>(OVERRIDE_KEY, null);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}
	const out: CacheMap = {};
	for (const [k, v] of Object.entries(parsed as CacheMap)) {
		if (typeof k === "string" && typeof v === "string" && v.trim()) {
			out[k] = v.trim();
		}
	}
	return out;
}

function writeOverrides(map: CacheMap): void {
	const entries = Object.entries(map);
	const trimmed =
		entries.length > MAX_ENTRIES
			? Object.fromEntries(entries.slice(entries.length - MAX_ENTRIES))
			: map;
	writeJsonStorage(OVERRIDE_KEY, trimmed);
}

function lookup(
	map: CacheMap,
	agentId: string,
	sessionId: string,
	providerSessionId?: string | null,
): string | null {
	const agent = agentId.trim();
	const id = sessionId.trim();
	if (!agent || !id) return null;
	const providerId = providerSessionId?.trim() || id;
	return (
		map[cacheKey(agent, providerId)]?.trim() ||
		map[cacheKey(agent, id)]?.trim() ||
		null
	);
}

export function getCachedHistoryTitle(
	agentId: string,
	sessionId: string,
): string | null {
	const id = sessionId.trim();
	const agent = agentId.trim();
	if (!id || !agent) return null;
	const value = readAll()[cacheKey(agent, id)];
	return value?.trim() || null;
}

/** User-renamed title that must not be overwritten by ACP pushes. */
export function getOverriddenHistoryTitle(
	agentId: string,
	sessionId: string,
	providerSessionId?: string | null,
): string | null {
	return lookup(readOverrides(), agentId, sessionId, providerSessionId);
}

export function setCachedHistoryTitle(
	agentId: string,
	sessionId: string,
	title: string,
): void {
	const id = sessionId.trim();
	const agent = agentId.trim();
	const cleaned = title.trim();
	if (!id || !agent || !cleaned) return;
	const map = readAll();
	map[cacheKey(agent, id)] = cleaned;
	writeAll(map);
}

/**
 * Persist a user-chosen history title. Writes both the regular cache and the
 * override map so re-list / session_info_update cannot clobber it (#710).
 */
export function setUserHistoryTitle(
	agentId: string,
	sessionId: string,
	title: string,
	providerSessionId?: string | null,
): void {
	const id = sessionId.trim();
	const agent = agentId.trim();
	const cleaned = title.trim();
	if (!id || !agent || !cleaned) return;
	const providerId = providerSessionId?.trim() || id;
	setCachedHistoryTitle(agent, providerId, cleaned);
	if (providerId !== id) setCachedHistoryTitle(agent, id, cleaned);
	const overrides = readOverrides();
	overrides[cacheKey(agent, providerId)] = cleaned;
	if (providerId !== id) overrides[cacheKey(agent, id)] = cleaned;
	writeOverrides(overrides);
}

function readFlagSet(storageKey: string): CacheMap {
	const parsed = readJsonStorage<unknown>(storageKey, null);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}
	const out: CacheMap = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (value === true) out[key] = "1";
	}
	return out;
}

function writeFlagSet(storageKey: string, map: CacheMap): void {
	const entries = Object.entries(map);
	const trimmed =
		entries.length > MAX_EMPTY
			? Object.fromEntries(entries.slice(entries.length - MAX_EMPTY))
			: map;
	const stored: Record<string, true> = {};
	for (const key of Object.keys(trimmed)) stored[key] = true;
	writeJsonStorage(storageKey, stored);
}

function readEmptySessions(): CacheMap {
	return readFlagSet(EMPTY_KEY);
}

function writeEmptySessions(map: CacheMap): void {
	writeFlagSet(EMPTY_KEY, map);
}

/** ACP sessions whose transcript had no lines the last time we loaded them. */
export function isEmptyAcpSession(agentId: string, sessionId: string): boolean {
	const id = sessionId.trim();
	const agent = agentId.trim();
	if (!id || !agent) return false;
	return readEmptySessions()[cacheKey(agent, id)] === "1";
}

export function rememberEmptyAcpSession(
	agentId: string,
	sessionId: string,
): void {
	const id = sessionId.trim();
	const agent = agentId.trim();
	if (!id || !agent) return;
	const map = readEmptySessions();
	const key = cacheKey(agent, id);
	if (map[key] === "1") return;
	map[key] = "1";
	writeEmptySessions(map);
}

function readDismissedSessions(): CacheMap {
	return readFlagSet(DISMISSED_KEY);
}

function writeDismissedSessions(map: CacheMap): void {
	writeFlagSet(DISMISSED_KEY, map);
}

/** Sessions the user removed from history. `session/list` must not bring them back. */
export function isDismissedAcpSession(
	agentId: string,
	sessionId: string,
): boolean {
	const id = sessionId.trim();
	const agent = agentId.trim();
	if (!id || !agent) return false;
	return readDismissedSessions()[cacheKey(agent, id)] === "1";
}

export function rememberDismissedAcpSession(
	agentId: string,
	sessionId: string,
): void {
	const id = sessionId.trim();
	const agent = agentId.trim();
	if (!id || !agent) return;
	const map = readDismissedSessions();
	const key = cacheKey(agent, id);
	if (map[key] === "1") return;
	map[key] = "1";
	writeDismissedSessions(map);
}

export function forgetEmptyAcpSession(
	agentId: string,
	sessionId: string,
): void {
	const id = sessionId.trim();
	const agent = agentId.trim();
	if (!id || !agent) return;
	const map = readEmptySessions();
	const key = cacheKey(agent, id);
	if (map[key] !== "1") return;
	delete map[key];
	writeEmptySessions(map);
}

/** Apply cached titles onto sessions that still lack a human label. */
export function applyCachedHistoryTitles(
	agentId: string,
	sessions: Array<{
		id: string;
		title: string;
		providerSessionId?: string | null;
		titleLocked?: boolean;
	}>,
): typeof sessions {
	if (sessions.length === 0) return sessions;
	const map = readAll();
	const overrides = readOverrides();
	if (Object.keys(map).length === 0 && Object.keys(overrides).length === 0) {
		return sessions;
	}
	return sessions.map((session) => {
		const overridden = lookup(
			overrides,
			agentId,
			session.id,
			session.providerSessionId,
		);
		if (overridden) {
			if (session.title === overridden && session.titleLocked) return session;
			return { ...session, title: overridden, titleLocked: true };
		}
		if (session.title.trim() || session.titleLocked) return session;
		const cached = lookup(map, agentId, session.id, session.providerSessionId);
		if (!cached) return session;
		return { ...session, title: cached };
	});
}
