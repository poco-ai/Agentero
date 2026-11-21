/**
 * Single source of truth for Agent chat sessions.
 *
 * PDF visual-annotation modal and the right-rail Agent panel both read/write
 * here — they are two views of the same conversation, not two stores to sync.
 *
 * Invariant: transcript text lives ONLY on `sessions[i].lines`.
 * `getLines(state)` derives the active transcript — never a second copy.
 */

import { createContext, useContext } from "react";
import { createStore, type StoreApi, useStore } from "zustand";

import type {
	AskUserRequest,
	ElicitationRequest,
	PermissionRequest,
	PromptImage,
} from "@/lib/agent/api";
import type { ChatLine, ChatSessionHistoryItem } from "@/lib/agent/chat-state";
import type { SelectionContext } from "@/lib/agent/selection-store";
import type { PdfVisualDraft } from "@/lib/agent/visual-context-store";

export type AgentSessionRecord = ChatSessionHistoryItem & {
	/** When set, this session is the pin-modal transcript for that mark. */
	visualTraceId?: string;
	/** Absolute paper path for mark projection (optional). */
	paperAbsPath?: string;
};

/** One turn requested from outside the Agent panel (e.g. PDF pin modal). */
export type AgentTurnRequest = {
	nonce: number;
	/** User-visible text (and/or visual drafts via images + prompt). */
	text: string;
	/**
	 * When set, continue/create the session bound to this visual mark id.
	 * Modal and sidebar share that session.
	 */
	visualTraceId?: string;
	paperAbsPath?: string;
	/** Prefer this agent (pdfAsk / panel selection). */
	agentId?: string;
	modelId?: string;
	/** Title for a newly created session. */
	title?: string;
	/** Existing provider session to continue (session/load|resume). */
	providerSessionId?: string;
	/** Seed lines when opening an existing mark into the shared store. */
	seedLines?: ChatLine[];
	/**
	 * Same drafts as composer visual chips — send path already knows how to
	 * attach images + build the annotation prompt.
	 */
	visualDrafts?: PdfVisualDraft[];
	/** Optional images if not using visualDrafts. */
	images?: PromptImage[];
};

/** Follow-up frozen into a cross-window handoff. Same shape as the composer queue. */
export type AgentHandoffQueuedPrompt = {
	id: string;
	text: string;
	workflow?: string;
	contextPaths: string[];
	skillIds: string[];
	selections: SelectionContext[];
	visualDrafts: PdfVisualDraft[];
	images?: PromptImage[];
};

/**
 * Composer, queue, and unanswered interactive requests carried with a
 * main → feature-window snapshot. Chat lines stay on `sessions`; `running`
 * is derived from the active session's `status`, not a separate id set.
 */
export type AgentSessionHandoffSlice = {
	deliveryId: string;
	sourceLabel: string;
	targetLabel: string;
	providerSessionId: string | null;
	localSessionId: string;
	agentId: string | null;
	running: boolean;
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
	elicitationRequest: ElicitationRequest | null;
	askUserRequest: AskUserRequest | null;
};

export type AgentSessionHandoffApplyInput = {
	sessions: AgentSessionRecord[];
	activeTabId: string;
	draftLines?: ChatLine[];
	permissionRequest?: PermissionRequest | null;
} & Partial<AgentSessionHandoffSlice>;

/** Stable empty transcript (selector equality). */
export const EMPTY_CHAT_LINES: ChatLine[] = [];

export function getActiveLines(
	sessions: AgentSessionRecord[],
	activeTabId: string,
	draftLines: ChatLine[] = EMPTY_CHAT_LINES,
): ChatLine[] {
	if (activeTabId === "draft") {
		return draftLines.length ? draftLines : EMPTY_CHAT_LINES;
	}
	const session = sessions.find((item) => item.id === activeTabId);
	return session?.lines ?? EMPTY_CHAT_LINES;
}

export type AgentSessionStore = {
	sessions: AgentSessionRecord[];
	activeTabId: string;
	/** Active session id whose transcript is being restored via session/load. */
	hydratingSessionId: string | null;
	/**
	 * Optimistic transcript while activeTabId is still "draft" (before runOnce
	 * returns a runtime session id). Cleared when leaving draft.
	 */
	draftLines: ChatLine[];
	/** Unanswered ask-mode permission. Survives Agent panel unmount in this window. */
	permissionRequest: PermissionRequest | null;
	/**
	 * Last main → feature-window snapshot applied in this webview.
	 * Null until a handoff is accepted. The panel hydrates composer UI from it.
	 */
	handoff: AgentSessionHandoffSlice | null;

	setSessions: (
		update:
			| AgentSessionRecord[]
			| ((prev: AgentSessionRecord[]) => AgentSessionRecord[]),
	) => void;
	setActiveTabId: (id: string) => void;
	setHydratingSessionId: (id: string | null) => void;
	/** Start an empty draft without mutating the transcript of the active session. */
	startDraft: () => void;
	/** Replace/update lines for the active tab (draft or session row). */
	setLines: (update: ChatLine[] | ((prev: ChatLine[]) => ChatLine[])) => void;
	setPermissionRequest: (
		update:
			| PermissionRequest
			| null
			| ((prev: PermissionRequest | null) => PermissionRequest | null),
	) => void;

	/** Upsert one session and optionally make it active. */
	upsertSession: (
		session: AgentSessionRecord,
		opts?: { activate?: boolean },
	) => void;
	/** Atomically publish a loaded transcript and make that history item active. */
	hydrateAndActivateSession: (
		session: AgentSessionRecord,
		lines: ChatLine[],
		title?: string,
	) => void;
	/** Patch lines on a session by id (stream correlation or product id). */
	updateSessionLines: (
		sessionId: string,
		update: (lines: ChatLine[]) => ChatLine[],
	) => void;
	findByVisualTraceId: (traceId: string) => AgentSessionRecord | undefined;
	findByProviderSessionId: (
		providerSessionId: string,
	) => AgentSessionRecord | undefined;

	// --- Turn bridge: panel registers handler; modal (etc.) requests turns ---
	turnRequest: AgentTurnRequest | null;
	/** Handler lives outside React state so register/unregister does not re-render. */
	_sendHandler: ((req: AgentTurnRequest) => Promise<boolean>) | null;
	registerSendHandler: (
		handler: ((req: AgentTurnRequest) => Promise<boolean>) | null,
	) => void;
	/** Queue a turn; panel handler runs it through the real send pipeline. */
	requestTurn: (input: Omit<AgentTurnRequest, "nonce">) => number;
	clearTurnRequest: () => void;
};

let turnNonce = 0;

export type AgentSessionStoreApi = StoreApi<AgentSessionStore>;

/**
 * One chat surface's session store. The right rail uses the shared
 * {@link agentSessionStore}; each Zen conversation slot owns its own, so
 * surfaces never fight over `activeTabId` or the turn bridge.
 */
export function createAgentSessionStore(): AgentSessionStoreApi {
	/** Non-reactive handler slot — mutating this must not call set(). */
	let sendHandlerSlot: ((req: AgentTurnRequest) => Promise<boolean>) | null =
		null;
	return createStore<AgentSessionStore>((set, get) => ({
		sessions: [],
		activeTabId: "draft",
		hydratingSessionId: null,
		draftLines: EMPTY_CHAT_LINES,
		permissionRequest: null,
		handoff: null,
		turnRequest: null,
		_sendHandler: null,

		setSessions: (update) =>
			set((s) => {
				const sessions =
					typeof update === "function" ? update(s.sessions) : update;
				if (sessions === s.sessions) return s;
				return { sessions };
			}),

		setActiveTabId: (id) =>
			set((s) => {
				if (s.activeTabId === id) return s;
				// Leaving draft discards optimistic draft transcript.
				if (id !== "draft" && s.draftLines !== EMPTY_CHAT_LINES) {
					return { activeTabId: id, draftLines: EMPTY_CHAT_LINES };
				}
				return { activeTabId: id };
			}),

		setHydratingSessionId: (id) =>
			set((s) =>
				s.hydratingSessionId === id ? s : { hydratingSessionId: id },
			),

		startDraft: () =>
			set({
				activeTabId: "draft",
				hydratingSessionId: null,
				draftLines: EMPTY_CHAT_LINES,
			}),

		setLines: (update) =>
			set((s) => {
				if (s.activeTabId === "draft") {
					const prevLines = s.draftLines;
					const nextLines =
						typeof update === "function" ? update(prevLines) : update;
					if (nextLines === prevLines) return s;
					return {
						draftLines: nextLines.length === 0 ? EMPTY_CHAT_LINES : nextLines,
					};
				}
				const idx = s.sessions.findIndex((item) => item.id === s.activeTabId);
				if (idx < 0) return s;
				const prevLines = s.sessions[idx].lines;
				const nextLines =
					typeof update === "function" ? update(prevLines) : update;
				if (nextLines === prevLines) return s;
				const sessions = s.sessions.slice();
				sessions[idx] = { ...sessions[idx], lines: nextLines };
				return { sessions };
			}),

		setPermissionRequest: (update) =>
			set((s) => {
				const permissionRequest =
					typeof update === "function" ? update(s.permissionRequest) : update;
				if (permissionRequest === s.permissionRequest) return s;
				return { permissionRequest };
			}),

		upsertSession: (session, opts) => {
			set((s) => {
				const idx = s.sessions.findIndex((item) => item.id === session.id);
				const sessions =
					idx >= 0
						? s.sessions.map((item, i) => (i === idx ? session : item))
						: [session, ...s.sessions.filter((item) => item.id !== session.id)];
				const activate = opts?.activate !== false;
				if (activate) {
					return {
						sessions,
						activeTabId: session.id,
					};
				}
				if (sessions === s.sessions) return s;
				return { sessions };
			});
		},

		hydrateAndActivateSession: (session, lines, title) => {
			set((s) => {
				const idx = s.sessions.findIndex(
					(item) => item.id === session.id && item.agentId === session.agentId,
				);
				const current = idx >= 0 ? s.sessions[idx] : undefined;
				const hydrated = {
					...session,
					...current,
					...(title !== undefined ? { title } : {}),
					lines,
				};
				const sessions =
					idx >= 0
						? s.sessions.map((item, i) => (i === idx ? hydrated : item))
						: [hydrated, ...s.sessions];
				return {
					sessions,
					activeTabId: hydrated.id,
					hydratingSessionId: null,
					draftLines: EMPTY_CHAT_LINES,
				};
			});
		},

		updateSessionLines: (sessionId, update) => {
			set((s) => {
				const idx = s.sessions.findIndex((item) => item.id === sessionId);
				if (idx < 0) return s;
				const prevLines = s.sessions[idx].lines;
				const nextLines = update(prevLines);
				if (nextLines === prevLines) return s;
				const sessions = s.sessions.slice();
				sessions[idx] = { ...sessions[idx], lines: nextLines };
				return { sessions };
			});
		},

		findByVisualTraceId: (traceId) =>
			get().sessions.find((s) => s.visualTraceId === traceId),

		findByProviderSessionId: (providerSessionId) =>
			get().sessions.find((s) => s.providerSessionId === providerSessionId),

		registerSendHandler: (handler) => {
			// Non-reactive: do not call set() — avoids re-render storms on mount.
			sendHandlerSlot = handler;
			get()._sendHandler = handler;
			const pending = get().turnRequest;
			if (handler && pending) {
				void handler(pending).finally(() => {
					if (get().turnRequest?.nonce === pending.nonce) {
						set({ turnRequest: null });
					}
				});
			}
		},

		requestTurn: (input) => {
			turnNonce += 1;
			const req: AgentTurnRequest = { ...input, nonce: turnNonce };
			const handler = sendHandlerSlot ?? get()._sendHandler;
			set({ turnRequest: req });
			if (handler) {
				void handler(req).finally(() => {
					if (get().turnRequest?.nonce === req.nonce) {
						set({ turnRequest: null });
					}
				});
			}
			return req.nonce;
		},

		clearTurnRequest: () => set({ turnRequest: null }),
	}));
}

/** The right-rail (and Agent feature window) store; PDF pins talk to this one. */
export const agentSessionStore = createAgentSessionStore();

export type AgentSessionScope = {
	store: AgentSessionStoreApi;
	/**
	 * Null for the shared rail store. Other surfaces namespace composer drafts
	 * with it and skip app-wide inputs (pinned selections, chrome, handoff).
	 */
	scopeId: string | null;
};

const DEFAULT_SCOPE: AgentSessionScope = {
	store: agentSessionStore,
	scopeId: null,
};

export const AgentSessionScopeContext =
	createContext<AgentSessionScope>(DEFAULT_SCOPE);

export function useAgentSessionScope(): AgentSessionScope {
	return useContext(AgentSessionScopeContext);
}

/** Store of the surrounding chat surface (rail by default). */
export function useAgentSessionStoreApi(): AgentSessionStoreApi {
	return useContext(AgentSessionScopeContext).store;
}

export function useAgentSessionStore<T>(
	selector: (s: AgentSessionStore) => T,
): T {
	return useStore(useAgentSessionStoreApi(), selector);
}

/** Active transcript — derived from sessions[activeTabId].lines (or draft). */
export function useActiveChatLines(): ChatLine[] {
	return useAgentSessionStore((s) =>
		getActiveLines(s.sessions, s.activeTabId, s.draftLines),
	);
}

/** Whether the active tab's session has a turn in flight. */
export function isActiveTabRunning(s: AgentSessionStore): boolean {
	return s.sessions.some(
		(session) => session.id === s.activeTabId && session.status === "running",
	);
}

export function getAgentSessionState(): AgentSessionStore {
	return agentSessionStore.getState();
}

/**
 * Whether this feature-window process has already consumed a main→popout
 * session handoff. New Agent windows accept the first snapshot only so later
 * retry emits cannot clobber in-window progress.
 */
let agentSessionHandoffApplied = false;

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function handoffSliceFrom(
	payload: AgentSessionHandoffApplyInput,
	sessions: AgentSessionRecord[],
	activeTabId: string,
): AgentSessionHandoffSlice {
	const session = sessions.find((item) => item.id === activeTabId) ?? null;
	const permissionRequestId =
		payload.permissionRequest?.requestId ?? payload.permissionRequestId ?? null;
	return {
		deliveryId: payload.deliveryId ?? "",
		sourceLabel: payload.sourceLabel ?? "",
		targetLabel: payload.targetLabel ?? "",
		providerSessionId:
			payload.providerSessionId ?? session?.providerSessionId ?? null,
		localSessionId: payload.localSessionId || activeTabId,
		agentId: payload.agentId ?? session?.agentId ?? null,
		// The boolean on the wire is a hint. The session row is the authority,
		// so a handoff never invents a parallel set of running ids.
		running: session?.status === "running",
		composerText: payload.composerText ?? "",
		mentions: stringList(payload.mentions),
		composerSkillIds: stringList(payload.composerSkillIds),
		includeSelectedFile: payload.includeSelectedFile === true,
		images: Array.isArray(payload.images) ? payload.images : [],
		visualRefs: Array.isArray(payload.visualRefs) ? payload.visualRefs : [],
		queue: Array.isArray(payload.queue) ? payload.queue : [],
		permissionRequestId,
		elicitationRequestId:
			payload.elicitationRequest?.requestId ??
			payload.elicitationRequestId ??
			null,
		askUserRequestId:
			payload.askUserRequest?.requestId ?? payload.askUserRequestId ?? null,
		elicitationRequest: payload.elicitationRequest ?? null,
		askUserRequest: payload.askUserRequest ?? null,
	};
}

/** Apply a cross-window handoff snapshot (new Agent feature window boot). */
export function applyAgentSessionHandoff(
	payload: AgentSessionHandoffApplyInput,
): void {
	const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
	const activeTabId =
		typeof payload.activeTabId === "string" && payload.activeTabId
			? payload.activeTabId
			: "draft";
	const draftLines =
		Array.isArray(payload.draftLines) && payload.draftLines.length > 0
			? payload.draftLines
			: EMPTY_CHAT_LINES;
	agentSessionStore.setState({
		sessions,
		activeTabId,
		hydratingSessionId: null,
		draftLines,
		handoff: handoffSliceFrom(payload, sessions, activeTabId),
		...(payload.permissionRequest !== undefined
			? { permissionRequest: payload.permissionRequest }
			: {}),
	});
}

/**
 * Apply handoff at most once per feature-window process.
 * @returns true if this call applied the snapshot
 */
export function applyAgentSessionHandoffOnce(
	payload: AgentSessionHandoffApplyInput,
): boolean {
	if (agentSessionHandoffApplied) return false;
	agentSessionHandoffApplied = true;
	applyAgentSessionHandoff(payload);
	return true;
}

/** The once-latch is process-global. Tests reset it between cases. */
export function resetAgentSessionHandoffApplied(): void {
	agentSessionHandoffApplied = false;
}

/**
 * Drop chat state belonging to the vault being closed. `_sendHandler` /
 * `sendHandlerSlot` are wiring owned by AgentPanel's mount, not vault data —
 * the panel does not remount on a switch, so clearing them here would break
 * PDF-pin turns until it happened to remount.
 */
export function clearAgentVaultState(): void {
	agentSessionStore.setState({
		sessions: [],
		activeTabId: "draft",
		hydratingSessionId: null,
		draftLines: EMPTY_CHAT_LINES,
		permissionRequest: null,
		handoff: null,
		turnRequest: null,
	});
}
