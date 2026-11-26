/**
 * Right rail: Agent chat.
 * Subscribes to stores directly.
 */

import {
	DockviewReact,
	type DockviewReadyEvent,
	type IDockviewPanelHeaderProps,
	type IDockviewPanelProps,
} from "dockview-react";
import { File, NotebookPen, Plus } from "lucide-react";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { PaneHeader } from "@/components/shell/pane-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DocumentTab } from "@/components/workspace/document-tab";
import {
	useLibraryStore,
	useSettings,
	useUiStore,
	useVaultStore,
	useWorkspaceStore,
} from "@/hooks/use-app-stores";
import { errorText } from "@/lib/core/error";
import { scheduleIdle } from "@/lib/core/idle";
import { notifyError } from "@/lib/core/notify";
import { basenameOf } from "@/lib/core/path";
import { cn } from "@/lib/core/utils";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import {
	closeSidebarTab,
	connectSidebarDock,
	DEFAULT_SIDEBAR_AGENT,
	openOrActivateSidebarTarget,
	type SidebarPanelParams,
} from "@/lib/shell/sidebar-tabs";
import { setAgentPanelMounted, setRightSidebarTab } from "@/lib/shell/ui-store";
import { pickVaultPreviewFile } from "@/lib/vault/pick";
import { getVaultPath, vaultLoadGeneration } from "@/lib/vault/store";
import { openCitation } from "@/lib/workspace/actions";
import { agenteroDockTheme } from "@/lib/workspace/dockview-theme";
import {
	currentSidebarPaperNotes,
	readSidebarFile,
	restoreSidebarFile,
	sidebarFileTarget,
} from "@/lib/workspace/sidebar-files";

// The panel stays out of the first paint. Once the vault is open and the main
// thread is idle, mount it hidden so ACP warm runs as a background task
// without the user opening the rail.
const AGENT_PANEL_PREFETCH_DELAY_MS = 1500;

const AgentPanel = lazy(() =>
	import("@/components/agent/agent-panel").then((m) => ({
		default: m.AgentPanel,
	})),
);

const SidebarFilePanel = lazy(() =>
	import("./sidebar-file-panel").then((module) => ({
		default: module.SidebarFilePanel,
	})),
);

function SidebarFile(props: IDockviewPanelProps<SidebarPanelParams>) {
	return (
		<Suspense fallback={<Skeleton className="m-4 h-16" />}>
			<SidebarFilePanel {...props} />
		</Suspense>
	);
}

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

function SidebarAgent() {
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
							onOpenAgentSettings={onOpenAgentSettings}
							onOpenSource={handleAgentOpenSource}
						/>
					</Suspense>
				</div>
			)}
		</>
	);
}

function SidebarTab({ api }: IDockviewPanelHeaderProps) {
	const { t } = useTranslation("app");
	return (
		<DocumentTab
			title={api.title}
			closeLabel={t("tabs.close", { title: api.title })}
			onClose={() => closeSidebarTab(api.id)}
		/>
	);
}

function SidebarNewTabButton() {
	const { t } = useTranslation("app");
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			aria-label={t("sidebarTabs.newTab")}
			onClick={() =>
				openOrActivateSidebarTarget({
					kind: "launcher",
					notesPath: currentSidebarPaperNotes(),
				})
			}
		>
			<Plus className="size-4" aria-hidden />
		</Button>
	);
}

function SidebarLauncher({
	api,
	params,
}: IDockviewPanelProps<SidebarPanelParams>) {
	const { t } = useTranslation("app");
	const [busy, setBusy] = useState(false);
	const notesPath =
		params.target.kind === "launcher" ? params.target.notesPath : undefined;
	const openFile = async (notes?: string) => {
		const vault = getVaultPath();
		if (!vault) return;
		const generation = vaultLoadGeneration();
		const canOpen = () =>
			getVaultPath() === vault &&
			vaultLoadGeneration() === generation &&
			api.isVisible;
		setBusy(true);
		try {
			const path = notes ?? (await pickVaultPreviewFile(vault));
			if (!path || !canOpen()) return;
			const target = sidebarFileTarget(vault, path);
			if (!target || (!notes && target.kind === "notes"))
				throw new Error(t("sidebarTabs.unsupportedFile"));
			const file = await readSidebarFile(vault, target);
			await openOrActivateSidebarTarget(target, {
				replace: api.id,
				canOpen,
				file,
			});
		} catch (error) {
			if (canOpen()) notifyError(errorText(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex h-full flex-col items-start gap-2 overflow-auto p-4">
			<Button
				type="button"
				variant="ghost"
				onClick={() =>
					openOrActivateSidebarTarget(DEFAULT_SIDEBAR_AGENT, {
						replace: api.id,
					})
				}
			>
				{t("labels.agent")}
			</Button>
			<Button
				type="button"
				variant="ghost"
				disabled={busy || !notesPath}
				onClick={() => void openFile(notesPath)}
			>
				<NotebookPen aria-hidden />
				{t("sidebarTabs.currentNotes")}
			</Button>
			<Button
				type="button"
				variant="ghost"
				disabled={busy}
				onClick={() => void openFile()}
			>
				<File aria-hidden />
				{t("sidebarTabs.openFile")}
			</Button>
		</div>
	);
}

const components = {
	agent: SidebarAgent,
	launcher: SidebarLauncher,
	pdf: SidebarFile,
	notes: SidebarFile,
	html: SidebarFile,
};

function SidebarDock({ vaultPath }: { vaultPath: string }) {
	const { t } = useTranslation("app");
	const disconnect = useRef<(() => void) | null>(null);
	const onReady = useCallback(
		({ api }: DockviewReadyEvent) => {
			disconnect.current?.();
			disconnect.current = connectSidebarDock(api, vaultPath, {
				title: (target) =>
					target.kind === "agent"
						? t("labels.agent")
						: target.kind === "launcher"
							? t("sidebarTabs.newTab")
							: basenameOf(target.vaultRelPath),
				restoreTarget: (target) =>
					target.kind === "agent"
						? Promise.resolve(target)
						: restoreSidebarFile(vaultPath, target),
			});
		},
		[t, vaultPath],
	);
	useEffect(() => () => disconnect.current?.(), []);

	return (
		<aside
			className="agentero-dockview agentero-dock-global h-full min-h-0 min-w-0 bg-sidebar"
			aria-label={t("titlebar.showRightSidebar")}
		>
			<DockviewReact
				className="h-full w-full"
				theme={agenteroDockTheme}
				components={components}
				defaultTabComponent={SidebarTab}
				rightHeaderActionsComponent={SidebarNewTabButton}
				disableFloatingGroups
				disableDnd
				onReady={onReady}
			/>
		</aside>
	);
}

export function RightSidebar() {
	const vaultPath = useVaultStore((store) => store.vaultPath);
	return vaultPath ? (
		<SidebarDock key={vaultPath} vaultPath={vaultPath} />
	) : null;
}
