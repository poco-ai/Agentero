/**
 * Agent session store registry keyed by scope id.
 *
 * The right rail used to create the store inside the panel component, which
 * made a cross-dock move (rail ↔ main workspace) destroy the conversation and
 * cancel its running turn. Owning stores here keeps a session alive while its
 * panel is re-mounted in the other Dockview.
 *
 * The shared rail store (`scopeId === null`) stays a module singleton, so the
 * default Agent surface behaves exactly as before.
 */

import {
	type AgentSessionScope,
	agentSessionStore,
	createAgentSessionStore,
} from "@/lib/agent/agent-session-store";
import { cancelAgentRun } from "@/lib/agent/api";

type RegistryEntry = {
	scope: AgentSessionScope;
	/** Mounted panels holding this scope. */
	refs: number;
	/** Deferred teardown; a move re-mounts before it fires. */
	releaseTimer: ReturnType<typeof setTimeout> | null;
};

/** Grace period covering the destination mount of a cross-dock move. */
const RELEASE_GRACE_MS = 1000;

const DEFAULT_SCOPE: AgentSessionScope = {
	scopeId: null,
	store: agentSessionStore,
};

const entries = new Map<string, RegistryEntry>();

/** Stable scope object for a scope id; creates the per-session store lazily. */
export function agentScopeFor(scopeId: string | null): AgentSessionScope {
	if (scopeId === null) return DEFAULT_SCOPE;
	let entry = entries.get(scopeId);
	if (!entry) {
		entry = {
			scope: { scopeId, store: createAgentSessionStore() },
			refs: 0,
			releaseTimer: null,
		};
		entries.set(scopeId, entry);
	}
	return entry.scope;
}

export function retainAgentScope(scopeId: string | null): void {
	if (scopeId === null) return;
	const entry = entries.get(scopeId);
	if (!entry) return;
	entry.refs += 1;
	if (entry.releaseTimer != null) {
		clearTimeout(entry.releaseTimer);
		entry.releaseTimer = null;
	}
}

/**
 * Drop one panel reference. When the last panel closes, stop its running
 * turns and forget the store. Normal close and cross-dock move share this
 * path; the grace period distinguishes them.
 */
export function releaseAgentScope(scopeId: string | null): void {
	if (scopeId === null) return;
	const entry = entries.get(scopeId);
	if (!entry) return;
	entry.refs = Math.max(0, entry.refs - 1);
	if (entry.refs > 0 || entry.releaseTimer != null) return;
	entry.releaseTimer = setTimeout(() => {
		entry.releaseTimer = null;
		if (entry.refs > 0) return;
		entries.delete(scopeId);
		for (const session of entry.scope.store.getState().sessions) {
			if (session.status === "running") {
				void cancelAgentRun(session.id).catch(() => undefined);
			}
		}
	}, RELEASE_GRACE_MS);
}

/** Test-only: forget every per-session store. */
export function resetAgentScopes(): void {
	for (const entry of entries.values()) {
		if (entry.releaseTimer != null) clearTimeout(entry.releaseTimer);
	}
	entries.clear();
}
