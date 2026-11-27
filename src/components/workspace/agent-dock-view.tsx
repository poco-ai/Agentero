/**
 * Agent conversation hosted in the main workspace.
 *
 * A rail tab dropped on the workspace becomes a normal `DocTab` of kind
 * `agent`; the scope store is owned by the agent-scope registry so the move
 * keeps the transcript and any running turn. Rendering mirrors the rail
 * panel, minus the rail's lazy mount / visibility plumbing.
 */

import { Suspense, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentPanel } from "@/components/agent/agent-panel";
import { useAgentScope } from "@/hooks/use-agent-scope";
import {
	useLibraryStore,
	useSettings,
	useUiStore,
	useVaultStore,
	useWorkspaceStore,
} from "@/hooks/use-app-stores";
import { AgentSessionScopeContext } from "@/lib/agent/agent-session-store";
import { sessionHistoryItem, sessionReference } from "@/lib/agent/session-ref";
import { errorText } from "@/lib/core/error";
import type { ApiError } from "@/lib/core/ipc";
import { notifyError } from "@/lib/core/notify";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { updateTab } from "@/lib/workspace/store";
import type { DocTab } from "@/lib/workspace/tabs";
import { openCitation } from "@/lib/workspace/viewer-actions";

export function AgentDockView({ tab }: { tab: DocTab }) {
	const { t } = useTranslation(["app", "agent"]);
	const scope = useAgentScope(tab.agentScopeId ?? null);
	const vaultPath = useVaultStore((state) => state.vaultPath);
	const vaultMarkdownPaths = useVaultStore((state) => state.vaultMdFiles);
	const vaultDirectoryPaths = useVaultStore((state) => state.vaultDirPaths);
	const vaultPaperPaths = useVaultStore((state) => state.vaultPaperPaths);
	const paperMetadata = useLibraryStore((state) => state.paperMetaByRelPath);
	const paperTreeLabelMode = useSettings((state) => state.paperTreeLabelMode);
	// The default scope is shared with the singleton Agent window; when the
	// window owns it, unmount here instead of rendering two chat surfaces.
	const agentWindowOpen = useUiStore((state) => state.agentWindowOpen);
	const agentInWindow = scope.scopeId === null && agentWindowOpen;
	const selectedPath = useWorkspaceStore((state) => {
		const active = state.tabs.find(
			(candidate) => candidate.id === state.activeTabId,
		);
		return active && active.kind !== "agent" ? active.path : null;
	});
	const selectedPaperTitle = useWorkspaceStore(
		(state) =>
			state.tabs.find((candidate) => candidate.id === state.activeTabId)
				?.paperMeta?.title ?? null,
	);
	// Only a fresh (restored) store loads history; a moved panel already has
	// the conversation in its registry store.
	const [historyItem, setHistoryItem] = useState(() =>
		tab.agentSessionRef && scope.store.getState().sessions.length === 0
			? sessionHistoryItem(tab.agentSessionRef)
			: null,
	);

	// Active session can change inside the panel (session switch, new draft).
	// Persist its identity so a restore reopens the same conversation.
	useEffect(() => {
		return scope.store.subscribe((state, previous) => {
			const before = previous.sessions.find(
				(session) => session.id === previous.activeTabId,
			);
			const after = state.sessions.find(
				(session) => session.id === state.activeTabId,
			);
			if (before === after) return;
			const previousRef = sessionReference(before);
			const ref = sessionReference(after);
			// Ignore streaming line updates: only identity/title changes matter.
			if (JSON.stringify(previousRef) === JSON.stringify(ref)) return;
			updateTab(tab.id, {
				agentSessionRef: ref,
				...(ref?.title?.trim() ? { title: ref.title.trim() } : {}),
			});
		});
	}, [scope, tab.id]);

	const title = useMemo(
		() => tab.title || t("app:labels.agent"),
		[tab.title, t],
	);

	if (!vaultPath) return null;
	if (agentInWindow) {
		return (
			<div
				data-workspace-view={tab.id}
				className="h-full min-h-0 bg-background"
			/>
		);
	}
	return (
		<AgentSessionScopeContext.Provider value={scope}>
			<div
				data-workspace-view={tab.id}
				className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
			>
				<Suspense fallback={null}>
					<AgentPanel
						vaultPath={vaultPath}
						selectedPath={selectedPath}
						selectedPaperTitle={selectedPaperTitle}
						vaultMarkdownPaths={vaultMarkdownPaths}
						vaultDirectoryPaths={vaultDirectoryPaths}
						vaultPaperPaths={vaultPaperPaths}
						paperMetaByRelPath={paperMetadata}
						paperTreeLabelMode={paperTreeLabelMode}
						className="h-full min-h-0"
						workspace
						initialAgentId={tab.agentSessionRef?.agentId}
						openHistoryItem={historyItem}
						onOpenHistoryHandled={() => setHistoryItem(null)}
						onOpenHistoryError={(_item, error) => {
							const code = (error as ApiError | null)?.code;
							if (
								code === "agent_not_found" ||
								code === "session_not_found" ||
								/\b(?:session|thread)(?:\s+\S+)?\s+(?:not found|does not exist)\b/i.test(
									errorText(error),
								)
							) {
								notifyError(errorText(error));
							}
						}}
						restoringHistory={Boolean(historyItem)}
						suppressHistoryImport={scope.scopeId !== null}
						title={title}
						onOpenAgentSettings={() => openSettingsWindow("agent")}
						onOpenSource={openCitation}
					/>
				</Suspense>
			</div>
		</AgentSessionScopeContext.Provider>
	);
}
