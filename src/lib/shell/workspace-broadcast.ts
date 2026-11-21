/**
 * Cross-window active-document broadcast for feature popout windows.
 * Main App windows emit; feature windows listen and follow active path.
 *
 * Agent session handoff uses the same `agent:session-handoff` event for the
 * target's ready signal, the one snapshot, and the ack. The snapshot is sent
 * once, after the feature window is listening. Host events stay on the source
 * window until that snapshot is acked.
 */

import type {
	AgentHandoffQueuedPrompt,
	AgentSessionRecord,
} from "@/lib/agent/agent-session-store";
import { getAgentSessionState } from "@/lib/agent/agent-session-store";
import type {
	AskUserRequest,
	ElicitationRequest,
	PermissionRequest,
	PromptImage,
} from "@/lib/agent/api";
import type { ChatLine } from "@/lib/agent/chat-state";
import {
	composerScopeKey,
	loadAgentComposerState,
} from "@/lib/agent/composer-state";
import {
	type HandoffPhase,
	stepHandoffDelivery,
} from "@/lib/agent/session-handoff";
import type { PdfVisualDraft } from "@/lib/agent/visual-context-store";
import { currentVisualDrafts } from "@/lib/agent/visual-context-store";
import { commands } from "@/lib/core/bindings";
import { isTauri } from "@/lib/core/tauri";
import { broadcastSafe } from "@/lib/core/tauri-events";
import { getVaultPath } from "@/lib/vault/store";
import { currentWindowLabel } from "@/lib/workspace/store";

export const WORKSPACE_ACTIVE_CHANGED_EVENT = "workspace:active-changed";
/** Main ↔ Agent feature window: one snapshot, then an ack on the same event. */
export const AGENT_SESSION_HANDOFF_EVENT = "agent:session-handoff";

export type WorkspaceActiveChangedPayload = {
	path: string | null;
	vaultPath: string | null;
	/** Paper title when known (Agent header etc.). */
	paperTitle?: string | null;
};

export type AgentSessionHandoffSnapshot = {
	kind: "snapshot";
	deliveryId: string;
	sourceLabel: string;
	targetLabel: string;
	providerSessionId: string | null;
	localSessionId: string;
	agentId: string | null;
	/** Active session row. Null while the composer is still a draft. */
	session: AgentSessionRecord | null;
	/** `session.status === "running"`. Not a restored set of run ids. */
	running: boolean;
	sessions: AgentSessionRecord[];
	activeTabId: string;
	draftLines: ChatLine[];
	composerText: string;
	mentions: string[];
	composerSkillIds: string[];
	includeSelectedFile: boolean;
	images: PromptImage[];
	visualRefs: PdfVisualDraft[];
	queue: AgentHandoffQueuedPrompt[];
	permissionRequestId: string | null;
	elicitationRequestId: string | null;
	askUserRequestId: string | null;
	permissionRequest: PermissionRequest | null;
	elicitationRequest: ElicitationRequest | null;
	askUserRequest: AskUserRequest | null;
};

export type AgentSessionHandoffAck = {
	kind: "ack";
	deliveryId: string;
	sourceLabel: string;
	targetLabel: string;
};

export type AgentSessionHandoffReady = {
	kind: "ready";
	targetLabel: string;
};

export type AgentSessionHandoffMessage =
	| AgentSessionHandoffSnapshot
	| AgentSessionHandoffAck
	| AgentSessionHandoffReady;

type AgentHandoffReaders = {
	composerText: () => string;
	mentions: () => string[];
	skillIds: () => string[];
	includeSelectedFile: () => boolean;
	images: () => Promise<PromptImage[]>;
	queue: () => AgentHandoffQueuedPrompt[];
	elicitationRequest: () => ElicitationRequest | null;
	askUserRequest: () => AskUserRequest | null;
	selectedAgentId: () => string | null;
};

const handoffReaders: Partial<AgentHandoffReaders> = {};

/** Rail panel / composer publish live unsent state for the next snapshot. */
export function registerAgentHandoffReaders(
	patch: Partial<AgentHandoffReaders>,
): void {
	Object.assign(handoffReaders, patch);
}

/** Emit from full App windows when the active dock document changes. */
export function broadcastWorkspaceActive(
	payload: WorkspaceActiveChangedPayload,
): void {
	broadcastSafe(WORKSPACE_ACTIVE_CHANGED_EVENT, payload);
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

/** Emit one handoff message (snapshot, ready, or ack). */
export function broadcastAgentSessionHandoff(
	payload: AgentSessionHandoffMessage,
): void {
	broadcastSafe(AGENT_SESSION_HANDOFF_EVENT, payload);
}

function newDeliveryId(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}
	return `handoff-${Date.now()}`;
}

function freeze<T>(value: T): T {
	if (typeof structuredClone === "function") {
		try {
			return structuredClone(value);
		} catch {
			// Fall through to JSON for values structuredClone rejects.
		}
	}
	return JSON.parse(JSON.stringify(value)) as T;
}

function readComposerFallback(
	agentId: string | null,
	sessionId: string,
): {
	text: string;
	mentions: string[];
	skillIds: string[];
	includeSelectedFile: boolean;
} {
	const empty = {
		text: "",
		mentions: [] as string[],
		skillIds: [] as string[],
		includeSelectedFile: false,
	};
	try {
		const storage = typeof localStorage === "undefined" ? null : localStorage;
		const scopeKey = composerScopeKey(getVaultPath(), agentId, null);
		if (!storage || !scopeKey) return empty;
		const saved = loadAgentComposerState(storage, scopeKey, sessionId);
		if (!saved) return empty;
		return {
			text: saved.text,
			mentions: saved.mentionedPaths,
			skillIds: saved.selectedSkillIds,
			includeSelectedFile: saved.includeSelectedFile,
		};
	} catch {
		return empty;
	}
}

/** Freeze the main window's agent surface. Unsent composer state is copied in. */
export async function captureAgentSessionHandoffSnapshot(
	targetLabel: string,
): Promise<AgentSessionHandoffSnapshot> {
	const state = getAgentSessionState();
	const activeTabId = state.activeTabId || "draft";
	const session =
		state.sessions.find((item) => item.id === activeTabId) ?? null;
	const agentId =
		handoffReaders.selectedAgentId?.() ??
		session?.agentId ??
		state.sessions[0]?.agentId ??
		null;
	const fallback = readComposerFallback(agentId, activeTabId);
	const composerText = handoffReaders.composerText?.() ?? fallback.text;
	const mentions = handoffReaders.mentions?.() ?? fallback.mentions;
	const composerSkillIds = handoffReaders.skillIds?.() ?? fallback.skillIds;
	const includeSelectedFile =
		handoffReaders.includeSelectedFile?.() ?? fallback.includeSelectedFile;
	let images: PromptImage[] = [];
	try {
		images = (await handoffReaders.images?.()) ?? [];
	} catch {
		images = [];
	}
	const queue = handoffReaders.queue?.() ?? [];
	const elicitationRequest = handoffReaders.elicitationRequest?.() ?? null;
	const askUserRequest = handoffReaders.askUserRequest?.() ?? null;
	const permissionRequest = state.permissionRequest;
	const running = session?.status === "running";
	return freeze({
		kind: "snapshot",
		deliveryId: newDeliveryId(),
		sourceLabel: currentWindowLabel(),
		targetLabel,
		providerSessionId: session?.providerSessionId ?? null,
		localSessionId: activeTabId,
		agentId,
		session,
		running,
		sessions: state.sessions,
		activeTabId,
		draftLines: state.draftLines,
		composerText,
		mentions,
		composerSkillIds,
		includeSelectedFile,
		images,
		visualRefs: currentVisualDrafts(),
		queue,
		permissionRequestId: permissionRequest?.requestId ?? null,
		elicitationRequestId: elicitationRequest?.requestId ?? null,
		askUserRequestId: askUserRequest?.requestId ?? null,
		permissionRequest,
		elicitationRequest,
		askUserRequest,
	});
}

async function rebindAgentEventWindow(
	sourceLabel: string,
	targetLabel: string,
): Promise<void> {
	await commands.agentRebindEventWindow(sourceLabel, targetLabel);
}

/**
 * Capture one snapshot and wait for the feature window.
 *
 * The snapshot is not emitted until the target reports that it is listening.
 * It is emitted once. Host event rebind runs only after the matching ack.
 * Callers stop the returned function when the popout fails before delivery;
 * stopping does not retarget events.
 */
export async function beginAgentSessionHandoff(
	targetLabel: string,
): Promise<() => void> {
	if (!isTauri()) return () => {};
	const snapshot = await captureAgentSessionHandoffSnapshot(targetLabel);
	let phase: HandoffPhase = "waiting-ready";
	let stopped = false;
	let rebindStarted = false;
	let unlisten: (() => void) | null = null;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		unlisten?.();
	};
	unlisten = await listenAgentSessionHandoff((message) => {
		if (stopped) return;
		const step = stepHandoffDelivery(phase, message, {
			targetLabel: snapshot.targetLabel,
			deliveryId: snapshot.deliveryId,
		});
		phase = step.phase;
		if (step.effect === "send-snapshot") {
			broadcastAgentSessionHandoff(snapshot);
			return;
		}
		if (step.effect !== "rebind" || rebindStarted) return;
		rebindStarted = true;
		void rebindAgentEventWindow(snapshot.sourceLabel, snapshot.targetLabel)
			.then(() => {
				stop();
			})
			.catch(() => {
				// Ack arrived but the host did not retarget. Keep emitting to the
				// source; do not treat the handoff as delivered.
				rebindStarted = false;
				phase = "snapshot-sent";
			});
	});
	if (stopped) {
		unlisten();
		return () => {};
	}
	return stop;
}

export async function listenAgentSessionHandoff(
	handler: (payload: AgentSessionHandoffMessage) => void,
): Promise<() => void> {
	if (!isTauri()) return () => {};
	const { listen } = await import("@tauri-apps/api/event");
	const unlisten = await listen<AgentSessionHandoffMessage>(
		AGENT_SESSION_HANDOFF_EVENT,
		(event) => {
			if (event.payload && typeof event.payload === "object") {
				handler(event.payload);
			}
		},
	);
	return unlisten;
}
