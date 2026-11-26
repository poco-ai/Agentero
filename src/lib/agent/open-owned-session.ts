import {
	type AgentSessionStoreApi,
	agentSessionStore,
} from "@/lib/agent/agent-session-store";
import type { ChatSessionHistoryItem } from "@/lib/agent/chat-state";
import {
	focusAgentComposer,
	focusZenComposer,
	presentAgentComposer,
} from "@/lib/agent/composer-focus";
import { sessionMatchesRef, sessionReference } from "@/lib/agent/session-ref";
import { zenScopeId, zenStore } from "@/lib/agent/zen-store";
import { sidebarAgentTargets } from "@/lib/shell/sidebar-tabs";
import { uiStore } from "@/lib/shell/ui-store";

export function focusOwnedAgentSession(
	item: ChatSessionHistoryItem,
	source?: { store: AgentSessionStoreApi; scopeId: string | null },
): boolean {
	const ref = sessionReference(item);
	if (!ref) return false;
	const zen = zenStore.getState();
	const slot = zen.slots.find(
		(slot) =>
			slot.store !== source?.store &&
			((slot.pendingHistory?.agentId === ref.agentId &&
				slot.pendingHistory.providerSessionId === ref.providerSessionId) ||
				slot.store
					.getState()
					.sessions.some((session) => sessionMatchesRef(session, ref))),
	);
	if (slot) {
		const state = slot.store.getState();
		const session = state.sessions.find((session) =>
			sessionMatchesRef(session, ref),
		);
		if (session && session.id !== state.activeTabId)
			state.setActiveTabId(session.id);
		zen.activateSlot(slot.id);
		if (!uiStore.getState().agentWindowOpen) {
			void import("@/lib/agent/agent-window").then(({ openAgentWindow }) => {
				openAgentWindow();
				focusZenComposer();
			});
		} else focusAgentComposer({ scopeId: zenScopeId(slot.id) });
		return true;
	}
	const sidebar = sidebarAgentTargets().find(
		(target) =>
			target.scopeId !== source?.scopeId &&
			target.sessionRef &&
			sessionMatchesRef(item, target.sessionRef),
	);
	if (sidebar) {
		presentAgentComposer({ scopeId: sidebar.scopeId });
		return true;
	}
	if (
		uiStore.getState().featurePoppedOut.agent &&
		agentSessionStore
			.getState()
			.sessions.some((session) => sessionMatchesRef(session, ref))
	) {
		presentAgentComposer({ scopeId: null });
		return true;
	}
	return false;
}
