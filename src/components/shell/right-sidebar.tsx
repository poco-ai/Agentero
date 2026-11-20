/**
 * Right rail: Agent chat.
 * Subscribes to stores directly.
 */

import { lazy, Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
	useLibraryStore,
	useSettings,
	useUiStore,
	useVaultStore,
	useWorkspaceStore,
} from "@/hooks/use-app-stores";
import { cn } from "@/lib/core/utils";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { setAgentPanelMounted, setRightSidebarTab } from "@/lib/shell/ui-store";
import { openCitation } from "@/lib/workspace/actions";

// The Agent panel is lazy-loaded: it isn't mounted until the agent sidebar is
// opened, so its (large) bundle stays out of the initial chunk.
const AgentPanel = lazy(() =>
	import("@/components/agent/agent-panel").then((m) => ({
		default: m.AgentPanel,
	})),
);

function onOpenAgentSettings(): void {
	openSettingsWindow("agent");
}

function handleAgentOpenSource(source: string): void {
	openCitation(source);
}

export function RightSidebar() {
	const { t } = useTranslation(["app"]);
	const rightSidebarOpen = useUiStore((s) => s.rightSidebarOpen);
	const rightSidebarTab = useUiStore((s) => s.rightSidebarTab);
	const agentPanelMounted = useUiStore((s) => s.agentPanelMounted);
	const featurePoppedOut = useUiStore((s) => s.featurePoppedOut);
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const vaultMdFiles = useVaultStore((s) => s.vaultMdFiles);
	const vaultDirPaths = useVaultStore((s) => s.vaultDirPaths);
	const vaultPaperPaths = useVaultStore((s) => s.vaultPaperPaths);
	const paperMetaByRelPath = useLibraryStore((s) => s.paperMetaByRelPath);
	const paperTreeLabelMode = useSettings((s) => s.paperTreeLabelMode);
	const workspacePath = useWorkspaceStore(
		(s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.path ?? null,
	);
	const workspaceTitle = useWorkspaceStore(
		(s) =>
			s.tabs.find((tab) => tab.id === s.activeTabId)?.paperMeta?.title ?? null,
	);
	const selectedPath = workspacePath;
	const selectedPaperTitle = workspaceTitle;

	// Annotations tab was removed; migrate any persisted "annotations" state to
	// "agent" so the right rail does not open empty.
	useEffect(() => {
		if (rightSidebarTab === "annotations") {
			setRightSidebarTab("agent");
		}
	}, [rightSidebarTab]);

	// Singleton feature windows own the surface — do not also host in the rail.
	const agentInWindow = Boolean(featurePoppedOut.agent);
	const agentVisible =
		!agentInWindow && rightSidebarOpen && rightSidebarTab === "agent";
	useEffect(() => {
		if (agentVisible) setAgentPanelMounted(true);
	}, [agentVisible]);

	return (
		<>
			{/* Keep AgentPanel alive when switching rail tabs, but never while
			    the agent singleton window is open. */}
			{!agentInWindow && (agentPanelMounted || agentVisible) && (
				<div className={cn("h-full min-h-0", !agentVisible && "hidden")}>
					<Suspense fallback={null}>
						<AgentPanel
							vaultPath={vaultPath}
							selectedPath={selectedPath}
							selectedPaperTitle={selectedPaperTitle}
							vaultMarkdownPaths={vaultMdFiles}
							vaultDirectoryPaths={vaultDirPaths}
							vaultPaperPaths={vaultPaperPaths}
							paperMetaByRelPath={paperMetaByRelPath}
							paperTreeLabelMode={paperTreeLabelMode}
							className="min-h-0 h-full"
							title={t("labels.agent")}
							autoFocus={agentVisible}
							onOpenAgentSettings={onOpenAgentSettings}
							onOpenSource={handleAgentOpenSource}
						/>
					</Suspense>
				</div>
			)}
		</>
	);
}
