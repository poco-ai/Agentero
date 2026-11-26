import { agentSessionStore } from "@/lib/agent/agent-session-store";
import type { SelectionRecipient } from "@/lib/agent/selection-store";
import { isZenVirtualPath } from "@/lib/agent/zen-path";
import { zenScopeId, zenStore } from "@/lib/agent/zen-store";
import { sidebarChatState } from "@/lib/shell/sidebar-tabs";
import { uiStore } from "@/lib/shell/ui-store";
import { getActiveTab } from "@/lib/workspace/store";

/** Whether an open Agent workspace should receive app-wide chat inputs. */
export function zenOwnsChatInput(): boolean {
	const ui = uiStore.getState();
	if (ui.agentWindowOpen) return true;
	const active = getActiveTab();
	return Boolean(active && isZenVirtualPath(active.path));
}

export function chatInputRecipient(): SelectionRecipient {
	if (zenOwnsChatInput()) {
		const zen = zenStore.getState();
		const slot = zen.slots.find((slot) => slot.id === zen.activeSlotId);
		if (slot)
			return {
				scopeId: zenScopeId(slot.id),
				sessionId: slot.store.getState().activeTabId,
			};
	}
	const { scopeId, sessionId } = sidebarChatState.getState();
	return scopeId
		? { scopeId, sessionId }
		: { scopeId: null, sessionId: agentSessionStore.getState().activeTabId };
}
