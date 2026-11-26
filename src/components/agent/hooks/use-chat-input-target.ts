import { useStore } from "zustand";
import { useUiStore, useWorkspaceStore } from "@/hooks/use-app-stores";
import { useAgentSessionScope } from "@/lib/agent/agent-session-store";
import { isZenVirtualPath } from "@/lib/agent/zen-path";
import { useZenStore, zenScopeId } from "@/lib/agent/zen-store";
import { sidebarChatState } from "@/lib/shell/sidebar-tabs";

export function useChatInputTarget(): boolean {
	const { scopeId } = useAgentSessionScope();
	const zenTabActive = useWorkspaceStore((s) =>
		s.tabs.some(
			(tab) => tab.id === s.activeTabId && isZenVirtualPath(tab.path),
		),
	);
	const agentWindowOpen = useUiStore((s) => s.agentWindowOpen);
	const activeSlotId = useZenStore((s) => s.activeSlotId);
	const sidebarScope = useStore(sidebarChatState, (state) => state.scopeId);
	const zenOwns = agentWindowOpen || zenTabActive;
	return zenOwns && activeSlotId !== null
		? scopeId === zenScopeId(activeSlotId)
		: scopeId === sidebarScope;
}
