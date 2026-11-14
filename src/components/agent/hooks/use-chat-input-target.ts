/**
 * Which mounted composer should consume app-wide chat inputs (file-tree
 * "Add to chat", pinned selections, seeded prompts)?
 *
 * The rail wins while it is visibly showing the agent tab; otherwise an open
 * Zen workspace's active slot owns them. Inactive slots stay subscribed but
 * ignore the inputs.
 */

import { useUiStore, useWorkspaceStore } from "@/hooks/use-app-stores";
import { useAgentSessionScope } from "@/lib/agent/agent-session-store";
import {
	railIsAgentSurface,
	zenTabIsOpen,
} from "@/lib/agent/chat-input-surface";
import { useZenStore, zenScopeId } from "@/lib/agent/zen-store";

export function useChatInputTarget(): boolean {
	const { scopeId } = useAgentSessionScope();
	const zenOpen = useWorkspaceStore((s) => zenTabIsOpen(s.tabs));
	const railVisible = useUiStore(railIsAgentSurface);
	const activeSlotId = useZenStore((s) => s.activeSlotId);
	const zenOwns = zenOpen && !railVisible;
	if (scopeId === null) return !zenOwns;
	return (
		zenOwns && activeSlotId !== null && scopeId === zenScopeId(activeSlotId)
	);
}
