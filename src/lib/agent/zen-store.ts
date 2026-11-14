/**
 * Zen conversation slots.
 *
 * Zen is a full-page Agent surface with several conversations open at once.
 * Each slot owns an independent session store (see
 * {@link createAgentSessionStore}) so slots never fight over `activeTabId`,
 * while all slots stay mounted and keep receiving stream events.
 *
 * The slot list is module-level so a dockview panel move / split does not
 * drop conversations.
 */

import { createStore, useStore } from "zustand";
import { agentChromeStore } from "@/lib/agent/agent-chrome-store";
import {
	type AgentSessionRecord,
	type AgentSessionStoreApi,
	agentSessionStore,
	createAgentSessionStore,
	EMPTY_CHAT_LINES,
} from "@/lib/agent/agent-session-store";
import { cancelAgentRun } from "@/lib/agent/api";
import type { ChatLine } from "@/lib/agent/chat-state";
import {
	composerScopeKey,
	loadAgentComposerState,
	saveAgentComposerState,
} from "@/lib/agent/composer-state";

/** Agent shown on a slot row (updated when the slot's harness changes). */
export type ZenSlotAgent = {
	id: string | null;
	name: string | null;
	template: string | null;
};

/** One ACP history row waiting to be loaded into a fresh slot. */
export type ZenHistoryItem = {
	/** Provider/runtime session id used for `session/load`. */
	id: string;
	agentId: string;
	agentName: string;
	title: string;
	startedAt: string;
	providerSessionId: string;
};

export type ZenSlot = {
	id: string;
	store: AgentSessionStoreApi;
	agent: ZenSlotAgent;
	/** One-shot history row; the panel loads it once its history probe is ready. */
	pendingHistory?: ZenHistoryItem | null;
};

/** Initial session state for a new slot (rail takeover / history row). */
export type ZenSlotSeed = {
	sessions?: AgentSessionRecord[];
	activeTabId?: string;
	draftLines?: ChatLine[];
	agentId?: string | null;
	agentName?: string | null;
	agentTemplate?: string | null;
	history?: ZenHistoryItem | null;
};

export type ZenState = {
	slots: ZenSlot[];
	activeSlotId: string | null;
	/** Append a slot and activate it. Returns the new slot id. */
	addSlot: (seed?: ZenSlotSeed) => string;
	/** Cancel that slot's in-flight turns, then drop it. */
	removeSlot: (id: string) => void;
	/** Drop one session inside a slot; the slot goes with its last session. */
	closeSlotSession: (slotId: string, sessionId: string) => void;
	activateSlot: (id: string) => void;
	setSlotAgent: (id: string, agent: ZenSlotAgent) => void;
	/** Drop the pending history request once the panel has begun loading it. */
	clearSlotHistory: (id: string) => void;
	/** Cancel every slot's in-flight turns and clear the list (tab closed). */
	closeAll: () => void;
};

/** Composer storage namespace for one slot — keeps drafts per surface. */
export function zenScopeId(slotId: string): string {
	return `zen:${slotId}`;
}

let slotSeq = 0;

function nextSlotId(): string {
	slotSeq += 1;
	return `slot-${slotSeq}-${Date.now().toString(36)}`;
}

function seedSlotStore(store: AgentSessionStoreApi, seed: ZenSlotSeed): void {
	const sessions = seed.sessions ?? [];
	if (!sessions.length && !seed.activeTabId) return;
	store.setState({
		sessions,
		activeTabId: seed.activeTabId || "draft",
		hydratingSessionId: null,
		draftLines: seed.draftLines?.length ? seed.draftLines : EMPTY_CHAT_LINES,
	});
}

function cancelSlotRuns(slot: ZenSlot): void {
	for (const session of slot.store.getState().sessions) {
		if (session.status !== "running") continue;
		void cancelAgentRun(session.id).catch(() => undefined);
	}
}

export const zenStore = createStore<ZenState>((set, get) => ({
	slots: [],
	activeSlotId: null,

	addSlot: (seed) => {
		const id = nextSlotId();
		const store = createAgentSessionStore();
		seedSlotStore(store, seed ?? {});
		const slot: ZenSlot = {
			id,
			store,
			agent: {
				id: seed?.agentId ?? null,
				name: seed?.agentName ?? null,
				template: seed?.agentTemplate ?? null,
			},
			pendingHistory: seed?.history ?? null,
		};
		set((state) => ({ slots: [...state.slots, slot], activeSlotId: id }));
		return id;
	},

	removeSlot: (id) => {
		const state = get();
		const slot = state.slots.find((candidate) => candidate.id === id);
		if (!slot) return;
		cancelSlotRuns(slot);
		const index = state.slots.findIndex((candidate) => candidate.id === id);
		const slots = state.slots.filter((candidate) => candidate.id !== id);
		const activeSlotId =
			state.activeSlotId === id
				? (slots[Math.min(index, slots.length - 1)]?.id ?? null)
				: state.activeSlotId;
		set({ slots, activeSlotId });
	},

	closeSlotSession: (slotId, sessionId) => {
		const slot = get().slots.find((candidate) => candidate.id === slotId);
		if (!slot) return;
		const state = slot.store.getState();
		const session = state.sessions.find((item) => item.id === sessionId);
		if (!session) return;
		if (session.status === "running") {
			void cancelAgentRun(session.id).catch(() => undefined);
		}
		const remaining = state.sessions.filter((item) => item.id !== sessionId);
		if (remaining.length === 0) {
			get().removeSlot(slotId);
			return;
		}
		state.setSessions(remaining);
		if (state.activeTabId === sessionId) {
			state.setActiveTabId(remaining[0]?.id ?? "draft");
		}
	},

	activateSlot: (id) => {
		if (get().activeSlotId === id) return;
		if (!get().slots.some((slot) => slot.id === id)) return;
		set({ activeSlotId: id });
	},

	setSlotAgent: (id, agent) => {
		const slot = get().slots.find((candidate) => candidate.id === id);
		if (!slot) return;
		if (
			slot.agent.id === agent.id &&
			slot.agent.name === agent.name &&
			slot.agent.template === agent.template
		) {
			return;
		}
		set((state) => ({
			slots: state.slots.map((candidate) =>
				candidate.id === id ? { ...candidate, agent } : candidate,
			),
		}));
	},

	clearSlotHistory: (id) => {
		const slot = get().slots.find((candidate) => candidate.id === id);
		if (!slot?.pendingHistory) return;
		set((state) => ({
			slots: state.slots.map((candidate) =>
				candidate.id === id
					? { ...candidate, pendingHistory: null }
					: candidate,
			),
		}));
	},

	closeAll: () => {
		for (const slot of get().slots) cancelSlotRuns(slot);
		set({ slots: [], activeSlotId: null });
	},
}));

function copyRailDraft(
	vaultPath: string | null,
	agentId: string | null,
	sessionId: string,
	slotId: string,
): void {
	if (!vaultPath || !agentId || typeof window === "undefined") return;
	const fromKey = composerScopeKey(vaultPath, agentId);
	const toKey = composerScopeKey(vaultPath, agentId, zenScopeId(slotId));
	if (!fromKey || !toKey) return;
	const draft = loadAgentComposerState(window.localStorage, fromKey, sessionId);
	if (!draft) return;
	saveAgentComposerState(window.localStorage, toKey, sessionId, draft);
}

/**
 * First Zen open takes over the rail's conversation: collapse is handled by
 * the caller, this seeds slot #1 from the rail store and copies its draft.
 * The rail store itself is left untouched so reopening it still shows the
 * original conversation.
 */
export function seedZenFromRail(vaultPath: string | null): void {
	if (zenStore.getState().slots.length > 0) return;
	const rail = agentSessionStore.getState();
	// Visual-annotation pin chats belong to the rail/PDF side; Zen takes over
	// ordinary conversations only.
	const sessions = rail.sessions.filter((session) => !session.visualTraceId);
	const activeTabId = sessions.some(
		(session) => session.id === rail.activeTabId,
	)
		? rail.activeTabId
		: "draft";
	const active = sessions.find((session) => session.id === activeTabId) ?? null;
	const agentId =
		agentChromeStore.getState().agentId ??
		active?.agentId ??
		sessions[0]?.agentId ??
		null;
	const slotId = zenStore.getState().addSlot({
		sessions,
		activeTabId,
		draftLines: activeTabId === "draft" ? rail.draftLines : undefined,
		agentId,
		agentName: active?.agentName ?? null,
	});
	copyRailDraft(vaultPath, agentId, activeTabId, slotId);
}

/** React binding for the module store (rows derive their own slot store). */
export function useZenStore<T>(selector: (state: ZenState) => T): T {
	return useStore(zenStore, selector);
}

/** Close the Zen tab: stop every slot's in-flight turn and drop the list. */
export function closeZenWorkspace(): void {
	zenStore.getState().closeAll();
}
