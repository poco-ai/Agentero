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
import { File, MessageSquarePlus, NotebookPen, Plus } from "lucide-react";
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
import {
	AgentSessionScopeContext,
	agentSessionStore,
	createAgentSessionStore,
} from "@/lib/agent/agent-session-store";
import { cancelAgentRun, listAgents } from "@/lib/agent/api";
import type { ChatSessionHistoryItem } from "@/lib/agent/chat-state";
import { isDismissedAcpSession } from "@/lib/agent/history-title-cache";
import { sessionHistoryItem, sessionReference } from "@/lib/agent/session-ref";
import { errorText } from "@/lib/core/error";
import { scheduleIdle } from "@/lib/core/idle";
import type { ApiError } from "@/lib/core/ipc";
import { notifyError } from "@/lib/core/notify";
import { basenameOf } from "@/lib/core/path";
import { cn } from "@/lib/core/utils";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import {
	closeSidebarTab,
	connectSidebarDock,
	isSidebarView,
	openOrActivateSidebarTarget,
	type SidebarAgentTarget,
	type SidebarPanelParams,
	sidebarPdfPath,
	updateSidebarAgentTarget,
} from "@/lib/shell/sidebar-tabs";
import { setAgentPanelMounted, uiStore } from "@/lib/shell/ui-store";
import { pickVaultPreviewFile } from "@/lib/vault/pick";
import { getVaultPath, vaultLoadGeneration } from "@/lib/vault/store";
import { openCitation } from "@/lib/workspace/actions";
import { agenteroDockTheme } from "@/lib/workspace/dockview-theme";
import { openSidebarCitation } from "@/lib/workspace/sidebar-citations";
import {
	currentSidebarPaperNotes,
	readSidebarFile,
	restoreSidebarFile,
	sidebarFileTarget,
} from "@/lib/workspace/sidebar-files";
import { createViewId } from "@/lib/workspace/tabs/model";

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

function SidebarAgent({
	api,
	params,
}: IDockviewPanelProps<SidebarPanelParams>) {
	const { t } = useTranslation(["app"]);
	const rightSidebarOpen = useUiStore((s) => s.rightSidebarOpen);
	const agentWindowOpen = useUiStore((s) => s.agentWindowOpen);
	const agentPanelMounted = useUiStore((s) => s.agentPanelMounted);
	const featurePoppedOut = useUiStore((s) => s.featurePoppedOut);
	const [initialTarget] = useState(params.target as SidebarAgentTarget);
	const [historyItem, setHistoryItem] = useState(() =>
		initialTarget.sessionRef
			? sessionHistoryItem(initialTarget.sessionRef)
			: null,
	);
	const [failedHistory, setFailedHistory] =
		useState<ChatSessionHistoryItem | null>(null);
	const [scope] = useState(() => ({
		scopeId: initialTarget.scopeId,
		store:
			initialTarget.scopeId === null
				? agentSessionStore
				: createAgentSessionStore(),
	}));
	const [visible, setVisible] = useState(api.isVisible);
	const agentId = useRef(
		initialTarget.agentId ?? initialTarget.sessionRef?.agentId,
	);
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

	useEffect(() => {
		const subscription = api.onDidVisibilityChange(({ isVisible }) =>
			setVisible(isVisible),
		);
		return () => subscription.dispose();
	}, [api]);
	useEffect(
		() =>
			scope.store.subscribe((state, previous) => {
				const old = previous.sessions.find(
					(session) => session.id === previous.activeTabId,
				);
				const current = state.sessions.find(
					(session) => session.id === state.activeTabId,
				);
				if (
					old === current ||
					JSON.stringify(sessionReference(old)) ===
						JSON.stringify(sessionReference(current))
				)
					return;
				updateSidebarAgentTarget(api.id, {
					kind: "agent",
					scopeId: scope.scopeId,
					sessionRef: sessionReference(current),
					agentId: agentId.current,
				});
			}),
		[api.id, scope],
	);
	useEffect(
		() => () => {
			if (!scope.scopeId) return;
			queueMicrotask(() => {
				if (isSidebarView(api.id)) return;
				for (const session of scope.store.getState().sessions) {
					if (session.status === "running")
						void cancelAgentRun(session.id).catch(() => undefined);
				}
			});
		},
		[api.id, scope],
	);
	const onAgentChange = useCallback(
		({ id }: { id: string }) => {
			agentId.current = id;
			const state = scope.store.getState();
			const sessionRef =
				sessionReference(
					state.sessions.find((session) => session.id === state.activeTabId),
				) ?? (historyItem ? sessionReference(historyItem) : undefined);
			updateSidebarAgentTarget(api.id, {
				kind: "agent",
				scopeId: scope.scopeId,
				agentId: id,
				sessionRef,
			});
		},
		[api.id, historyItem, scope],
	);

	// Singleton feature windows own the surface — do not also host in the rail.
	const agentInWindow =
		scope.scopeId === null && Boolean(featurePoppedOut.agent);
	const agentVisible = !agentInWindow && rightSidebarOpen && visible;

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
		<AgentSessionScopeContext.Provider value={scope}>
			<div data-sidebar-view={api.id} className="h-full min-h-0">
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
								initialAgentId={
									initialTarget.agentId ?? initialTarget.sessionRef?.agentId
								}
								openHistoryItem={historyItem}
								onOpenHistoryHandled={() => setHistoryItem(null)}
								onOpenHistoryError={(item, error) => {
									const code = (error as ApiError | null)?.code;
									if (
										initialTarget.sessionRef?.id === item.id &&
										(code === "agent_not_found" ||
											code === "session_not_found" ||
											/\b(?:session|thread)(?:\s+\S+)?\s+(?:not found|does not exist)\b/i.test(
												errorText(error),
											))
									) {
										void closeSidebarTab(api.id);
									} else setFailedHistory(item);
								}}
								headerActions={
									failedHistory ? (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={() => {
												setHistoryItem(failedHistory);
												setFailedHistory(null);
											}}
										>
											{t("sidebarTabs.retry")}
										</Button>
									) : undefined
								}
								onAgentChange={onAgentChange}
								restoringHistory={Boolean(historyItem)}
								suppressHistoryImport={scope.scopeId !== null}
								title={agentTitle}
								onOpenAgentSettings={onOpenAgentSettings}
								onOpenSource={
									agentWindowOpen ? openSidebarCitation : handleAgentOpenSource
								}
							/>
						</Suspense>
					</div>
				)}
			</div>
		</AgentSessionScopeContext.Provider>
	);
}

function SidebarTab({ api }: IDockviewPanelHeaderProps) {
	const { t } = useTranslation("app");
	const [title, setTitle] = useState(api.title);
	useEffect(() => {
		const subscription = api.onDidTitleChange(({ title }) => setTitle(title));
		return () => subscription.dispose();
	}, [api]);
	return (
		<DocumentTab
			data-sidebar-view={api.id}
			title={title}
			closeLabel={t("tabs.close", { title })}
			onClose={() => closeSidebarTab(api.id)}
		/>
	);
}

function SidebarNewTabButton() {
	const { t } = useTranslation("app");
	const origin = useRef<string | undefined>(undefined);
	const lastSidebarPdf = useRef<string | undefined>(undefined);
	useEffect(() => {
		const rememberSource = (event: Event) => {
			if (
				!(event.target instanceof Element) ||
				event.target.closest("[data-sidebar-new-tab]")
			)
				return;
			lastSidebarPdf.current = event.target.closest<HTMLElement>(
				"[data-sidebar-view]",
			)?.dataset.sidebarView;
		};
		document.addEventListener("pointerdown", rememberSource, true);
		document.addEventListener("focusin", rememberSource, true);
		return () => {
			document.removeEventListener("pointerdown", rememberSource, true);
			document.removeEventListener("focusin", rememberSource, true);
		};
	}, []);
	const sourcePdf = () => {
		const source = document.activeElement?.closest<HTMLElement>(
			"[data-sidebar-view]",
		)?.dataset.sidebarView;
		const view = source ?? lastSidebarPdf.current;
		return view ? sidebarPdfPath(view) : undefined;
	};
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			data-sidebar-new-tab
			aria-label={t("sidebarTabs.newTab")}
			onPointerDown={() => {
				origin.current = sourcePdf();
			}}
			onClick={(event) => {
				const pdf = (event.detail ? origin.current : undefined) ?? sourcePdf();
				origin.current = undefined;
				void openOrActivateSidebarTarget({
					kind: "launcher",
					notesPath:
						pdf || !uiStore.getState().agentWindowOpen
							? currentSidebarPaperNotes(pdf)
							: undefined,
				});
			}}
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
		<div
			data-sidebar-view={api.id}
			className="flex h-full flex-col items-start gap-2 overflow-auto p-4"
		>
			<Button
				type="button"
				variant="ghost"
				onClick={() =>
					openOrActivateSidebarTarget(
						{ kind: "agent", scopeId: `sidebar:${createViewId()}` },
						{
							replace: api.id,
						},
					)
				}
			>
				<MessageSquarePlus aria-hidden />
				{t("sidebarTabs.newAgent")}
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
			let agents: ReturnType<typeof listAgents> | undefined;
			disconnect.current = connectSidebarDock(api, vaultPath, {
				title: (target) =>
					target.kind === "agent"
						? target.sessionRef?.title || t("labels.agent")
						: target.kind === "launcher"
							? t("sidebarTabs.newTab")
							: basenameOf(target.vaultRelPath),
				restoreTarget: async (target) => {
					if (target.kind !== "agent")
						return restoreSidebarFile(vaultPath, target);
					const ref = target.sessionRef;
					if (!ref) return target;
					if (isDismissedAcpSession(ref.agentId, ref.providerSessionId))
						return null;
					agents ??= listAgents();
					const list = await agents.catch(() => null);
					return list && !list.agents.some((agent) => agent.id === ref.agentId)
						? null
						: target;
				},
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
