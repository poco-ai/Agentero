/**
 * Virtual Dockview path for an Agent session that lives in the main
 * workspace instead of the right rail.
 *
 * The path is stable per scope so `findCanonicalTab` also deduplicates a
 * moved conversation. The scope itself is not encoded in the tab id: the
 * `agentScopeId` field carries it and the session ref is persisted separately.
 */

const AGENT_DOCK_PREFIX = "agentero://agent/";
const DEFAULT_SCOPE_SEGMENT = "~";

/** Synthetic path for the rail's default Agent scope (`scopeId === null`). */
export function agentDockPath(scopeId: string | null): string {
	return `${AGENT_DOCK_PREFIX}${
		scopeId === null ? DEFAULT_SCOPE_SEGMENT : encodeURIComponent(scopeId)
	}`;
}

export function isAgentDockPath(path: string): boolean {
	return path.startsWith(AGENT_DOCK_PREFIX);
}

/** Scope encoded in an agent path; undefined for paths of other kinds. */
export function agentScopeIdFromDockPath(
	path: string,
): string | null | undefined {
	if (!isAgentDockPath(path)) return undefined;
	const segment = path.slice(AGENT_DOCK_PREFIX.length);
	if (!segment || segment === DEFAULT_SCOPE_SEGMENT) return null;
	try {
		return decodeURIComponent(segment);
	} catch {
		return undefined;
	}
}
