/**
 * One Dockview tab's conversation. Each host tab owns a Zen slot (and its own
 * session store), so switching tabs never swaps the composer or transcript.
 */

import { useMemo } from "react";
import { AgentPanel } from "@/components/agent/agent-panel";
import {
	useLibraryStore,
	useSettings,
	useVaultStore,
} from "@/hooks/use-app-stores";
import { AgentSessionScopeContext } from "@/lib/agent/agent-session-store";
import { closeAgentWindow } from "@/lib/agent/agent-window";
import type { ChatSessionHistoryItem } from "@/lib/agent/chat-state";
import {
	useZenStore,
	type ZenHistoryItem,
	zenScopeId,
	zenStore,
} from "@/lib/agent/zen-store";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { openCitation } from "@/lib/workspace/actions";

function historyItemFor(pending: ZenHistoryItem): ChatSessionHistoryItem {
	return {
		id: pending.id,
		agentId: pending.agentId,
		agentName: pending.agentName,
		title: pending.title,
		startedAt: pending.startedAt,
		providerSessionId: pending.providerSessionId,
		source: "external",
		lines: [],
		status: "completed",
		resumeable: true,
	};
}

export function AgentSessionView({
	slotId,
	autoFocus,
}: {
	slotId: string;
	autoFocus: boolean;
}) {
	const slot = useZenStoreSlot(slotId);
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const vaultMarkdownPaths = useVaultStore((s) => s.vaultMdFiles);
	const vaultDirectoryPaths = useVaultStore((s) => s.vaultDirPaths);
	const vaultPaperPaths = useVaultStore((s) => s.vaultPaperPaths);
	const paperMetaByRelPath = useLibraryStore((s) => s.paperMetaByRelPath);
	const paperTreeLabelMode = useSettings((s) => s.paperTreeLabelMode);
	const scope = useMemo(
		() => (slot ? { store: slot.store, scopeId: zenScopeId(slot.id) } : null),
		[slot],
	);
	const historyItem = useMemo(
		() => (slot?.pendingHistory ? historyItemFor(slot.pendingHistory) : null),
		[slot?.pendingHistory],
	);
	if (!slot || !scope) return null;

	return (
		<AgentSessionScopeContext.Provider value={scope}>
			<AgentPanel
				vaultPath={vaultPath}
				vaultMarkdownPaths={vaultMarkdownPaths}
				vaultDirectoryPaths={vaultDirectoryPaths}
				vaultPaperPaths={vaultPaperPaths}
				paperMetaByRelPath={paperMetaByRelPath}
				paperTreeLabelMode={paperTreeLabelMode}
				className="h-full min-h-0"
				wide
				initialAgentId={slot.agent.id}
				openHistoryItem={historyItem}
				onOpenHistoryHandled={() =>
					zenStore.getState().clearSlotHistory(slot.id)
				}
				restoringHistory={Boolean(slot.pendingHistory)}
				suppressHistoryImport
				workspace
				onAgentChange={(agent) =>
					zenStore.getState().setSlotAgent(slot.id, agent)
				}
				onOpenAgentSettings={() => openSettingsWindow("agent")}
				onOpenSource={(source) => {
					// Vault citations land in the hidden document dock; external
					// links keep the Agent workspace open.
					if (!/^https?:/i.test(source)) closeAgentWindow();
					openCitation(source);
				}}
				autoFocus={autoFocus}
			/>
		</AgentSessionScopeContext.Provider>
	);
}

function useZenStoreSlot(slotId: string) {
	return useZenStore((s) => s.slots.find((slot) => slot.id === slotId) ?? null);
}
