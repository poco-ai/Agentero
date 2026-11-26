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
import { sessionHistoryItem } from "@/lib/agent/session-ref";
import { useZenStore, zenScopeId, zenStore } from "@/lib/agent/zen-store";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { openSidebarCitation } from "@/lib/workspace/sidebar-citations";

export function AgentSessionView({
	slotId,
	autoFocus,
}: {
	slotId: string;
	autoFocus: boolean;
}) {
	const slot = useZenStore(
		(s) => s.slots.find((slot) => slot.id === slotId) ?? null,
	);
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
		() =>
			slot?.pendingHistory ? sessionHistoryItem(slot.pendingHistory) : null,
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
				onOpenSource={openSidebarCitation}
				onOpenArtifact={(file) =>
					void openSidebarCitation(file.path, file.vault)
				}
				autoFocus={autoFocus}
			/>
		</AgentSessionScopeContext.Provider>
	);
}
