/**
 * Cross-window active-document broadcast for feature popout windows.
 * Main App windows emit; feature windows listen and follow active path.
 */

import type { AgentSessionRecord } from "@/lib/agent/agent-session-store";
import type { ChatLine } from "@/lib/agent/chat-state";
import { isTauri } from "@/lib/core/tauri";

export const WORKSPACE_ACTIVE_CHANGED_EVENT = "workspace:active-changed";
/** Popout → main: open a Vault path in the main workbench. */
export const WORKSPACE_OPEN_PATH_EVENT = "workspace:open-path";
export const AGENT_OPEN_SESSION_EVENT = "agent:open-session";
/** Main → new Agent feature window: full session snapshot for continuity. */
export const AGENT_SESSION_HANDOFF_EVENT = "agent:session-handoff";

export type WorkspaceActiveChangedPayload = {
	path: string | null;
	vaultPath: string | null;
	/** Paper title when known (Agent header etc.). */
	paperTitle?: string | null;
};

export type WorkspaceOpenPathPayload = {
	/** Vault-relative path accepted by `openGraphPath`. */
	path: string;
};

/** Serializable Agent panel state for a newly opened feature window. */
export type AgentSessionHandoffPayload = {
	sessions: AgentSessionRecord[];
	activeTabId: string;
	draftLines: ChatLine[];
	/** Preferred agent switcher selection (usually active session's agentId). */
	selectedAgentId?: string | null;
};

/** Emit from full App windows when the active dock document changes. */
export function broadcastWorkspaceActive(
	payload: WorkspaceActiveChangedPayload,
): void {
	if (!isTauri()) return;
	void (async () => {
		try {
			const { emit } = await import("@tauri-apps/api/event");
			await emit(WORKSPACE_ACTIVE_CHANGED_EVENT, payload);
		} catch {
			// non-fatal
		}
	})();
}

/** Subscribe in feature windows (and tests). */
export async function listenWorkspaceActive(
	handler: (payload: WorkspaceActiveChangedPayload) => void,
): Promise<() => void> {
	if (!isTauri()) return () => {};
	const { listen } = await import("@tauri-apps/api/event");
	const unlisten = await listen<WorkspaceActiveChangedPayload>(
		WORKSPACE_ACTIVE_CHANGED_EVENT,
		(event) => {
			handler(event.payload);
		},
	);
	return unlisten;
}

/** Ask the main workbench to open a Vault path and bring itself to the front. */
export function broadcastWorkspaceOpenPath(path: string): void {
	const trimmed = path.trim();
	if (!isTauri() || !trimmed) return;
	void (async () => {
		try {
			const { emit } = await import("@tauri-apps/api/event");
			await emit(WORKSPACE_OPEN_PATH_EVENT, { path: trimmed });
		} catch {
			// non-fatal
		}
	})();
}

/** Main-window listener for paths requested by a popout surface. */
export async function listenWorkspaceOpenPath(
	handler: (payload: WorkspaceOpenPathPayload) => void,
): Promise<() => void> {
	if (!isTauri()) return () => {};
	const { listen } = await import("@tauri-apps/api/event");
	const unlisten = await listen<WorkspaceOpenPathPayload>(
		WORKSPACE_OPEN_PATH_EVENT,
		(event) => {
			const path = event.payload?.path;
			if (typeof path === "string" && path.trim()) {
				handler({ path: path.trim() });
			}
		},
	);
	return unlisten;
}

/** Forward PDF pin → Agent open requests into a popped-out agent window. */
export function broadcastAgentOpenSession(payload: unknown): void {
	if (!isTauri()) return;
	void (async () => {
		try {
			const { emit } = await import("@tauri-apps/api/event");
			await emit(AGENT_OPEN_SESSION_EVENT, payload);
		} catch {
			// non-fatal
		}
	})();
}

export async function listenAgentOpenSession(
	handler: (payload: unknown) => void,
): Promise<() => void> {
	if (!isTauri()) return () => {};
	const { listen } = await import("@tauri-apps/api/event");
	const unlisten = await listen(AGENT_OPEN_SESSION_EVENT, (event) => {
		handler(event.payload);
	});
	return unlisten;
}

/** Emit session snapshot so a new Agent feature window can restore the open chat. */
export function broadcastAgentSessionHandoff(
	payload: AgentSessionHandoffPayload,
): void {
	if (!isTauri()) return;
	void (async () => {
		try {
			const { emit } = await import("@tauri-apps/api/event");
			await emit(AGENT_SESSION_HANDOFF_EVENT, payload);
		} catch {
			// non-fatal
		}
	})();
}

/**
 * Snapshot main-window agent store and emit handoff (with light retries so a
 * just-created feature window can subscribe after boot).
 *
 * Producer assumption: only the main window that opened the Agent feature
 * window emits this event for that open. The feature window applies the first
 * payload only (`applyAgentSessionHandoffOnce`).
 */
export function scheduleAgentSessionHandoffFromMain(): void {
	if (!isTauri()) return;
	void (async () => {
		try {
			const { getAgentSessionState } = await import(
				"@/lib/agent/agent-session-store"
			);
			const state = getAgentSessionState();
			const active =
				state.sessions.find((s) => s.id === state.activeTabId) ?? null;
			const payload: AgentSessionHandoffPayload = {
				sessions: state.sessions,
				activeTabId: state.activeTabId,
				draftLines: state.draftLines,
				selectedAgentId: active?.agentId ?? state.sessions[0]?.agentId ?? null,
			};
			// Empty handoff is still useful to clear "draft" flash when nothing open.
			// Retries only help late subscribers; consumers ignore after first apply.
			const emit = () => broadcastAgentSessionHandoff(payload);
			if (
				typeof window === "undefined" ||
				typeof window.setTimeout !== "function"
			) {
				emit();
				return;
			}
			for (const delay of [0, 120, 350, 900]) {
				window.setTimeout(emit, delay);
			}
		} catch {
			// non-fatal
		}
	})();
}

export async function listenAgentSessionHandoff(
	handler: (payload: AgentSessionHandoffPayload) => void,
): Promise<() => void> {
	if (!isTauri()) return () => {};
	const { listen } = await import("@tauri-apps/api/event");
	const unlisten = await listen<AgentSessionHandoffPayload>(
		AGENT_SESSION_HANDOFF_EVENT,
		(event) => {
			if (event.payload && typeof event.payload === "object") {
				handler(event.payload);
			}
		},
	);
	return unlisten;
}
