/**
 * Right rail: Agent chat.
 * Subscribes to stores directly.
 */

import { lazy, Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { PaneHeader } from "@/components/shell/pane-header";
import { Skeleton } from "@/components/ui/skeleton";
import {
	useLibraryStore,
	useSettings,
	useUiStore,
	useVaultStore,
	useWorkspaceStore,
} from "@/hooks/use-app-stores";
import { scheduleIdle } from "@/lib/core/idle";
import { cn } from "@/lib/core/utils";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { setAgentPanelMounted, setRightSidebarTab } from "@/lib/shell/ui-store";
import { openCitation } from "@/lib/workspace/actions";

// The panel stays out of the first paint. Once the vault is open and the main
// thread is idle, mount it hidden so ACP warm runs as a background task
// without the user opening the rail.
const AGENT_PANEL_PREFETCH_DELAY_MS = 1500;

const AgentPanel = lazy(() =>
	import("@/components/agent/agent-panel").then((m) => ({
		default: m.AgentPanel,
	})),
);

function mountAgentPanelWhenLoaded(): void {
	void import("@/components/agent/agent-panel").then(() => {
		setAgentPanelMounted(true);
	});
}

/** Run after the rail's width change has been painted. */
function afterRailPaint(run: () => void): () => void {
	if (typeof requestAnimationFrame !== "function") {
		const timer = setTimeout(run, 32);
		return () => clearTimeout(timer);
	}
	let second = 0;
	const first = requestAnimationFrame(() => {
		second = requestAnimationFrame(run);
	});
	return () => {
		cancelAnimationFrame(first);
		if (second) cancelAnimationFrame(second);
	};
}

function onOpenAgentSettings(): void {
	openSettingsWindow("agent");
}

function handleAgentOpenSource(source: string): void {
	openCitation(source);
}

/** Holds the rail's shape until the heavy panel mounts on a later frame. */
function AgentRailShell({ title }: { title: string }) {
	return (
		<section
			className="flex h-full min-h-0 select-none flex-col bg-sidebar"
			aria-label={title}
			aria-busy="true"
		>
			<PaneHeader>
				<span className="truncate font-medium">{title}</span>
			</PaneHeader>
			<div className="flex min-h-0 flex-1 flex-col gap-3 px-3 py-4">
				<Skeleton className="h-3 w-2/3" />
				<Skeleton className="h-3 w-full" />
				<Skeleton className="h-3 w-5/6" />
			</div>
			<div className="shrink-0 border-t px-3 py-3">
				<Skeleton className="h-16 w-full" />
			</div>
		</section>
	);
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

	// Vault open and idle: load the panel in the background, rail still closed.
	useEffect(() => {
		if (!vaultPath || agentPanelMounted || agentInWindow) return;
		let cancelIdle = () => {};
		const timer = window.setTimeout(() => {
			cancelIdle = scheduleIdle(mountAgentPanelWhenLoaded, 4000);
		}, AGENT_PANEL_PREFETCH_DELAY_MS);
		return () => {
			window.clearTimeout(timer);
			cancelIdle();
		};
	}, [vaultPath, agentPanelMounted, agentInWindow]);

	// Opened before the idle mount finished: mount after this width paints.
	useEffect(() => {
		if (!agentVisible || agentPanelMounted) return;
		return afterRailPaint(() => setAgentPanelMounted(true));
	}, [agentVisible, agentPanelMounted]);

	const agentTitle = t("labels.agent");
	const showShell = agentVisible && !agentPanelMounted;

	return (
		<>
			{showShell ? <AgentRailShell title={agentTitle} /> : null}
			{/* Keep AgentPanel alive when switching rail tabs, but never while
			    the agent singleton window is open. */}
			{!agentInWindow && agentPanelMounted && (
				<div className={cn("h-full min-h-0", !agentVisible && "hidden")}>
					<Suspense fallback={<AgentRailShell title={agentTitle} />}>
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
							title={agentTitle}
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
