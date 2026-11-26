/**
 * Right rail: Agent chat.
 * Subscribes to stores directly.
 */

import { Command as CommandPrimitive } from "cmdk";
import {
	DockviewReact,
	type DockviewReadyEvent,
	type IDockviewPanelHeaderProps,
	type IDockviewPanelProps,
} from "dockview-react";
import {
	FileCode,
	FileText,
	FolderOpen,
	MessageSquarePlus,
	NotebookPen,
	Plus,
	Search,
} from "lucide-react";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { PaneHeader } from "@/components/shell/pane-header";
import { Button } from "@/components/ui/button";
import { Command, CommandItem, CommandList } from "@/components/ui/command";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { DocumentTab } from "@/components/workspace/document-tab";
import {
	useLibraryStore,
	useSettings,
	useUiStore,
	useVaultStore,
	useWorkspaceStore,
} from "@/hooks/use-app-stores";
import { useShortcutLabel } from "@/hooks/use-shortcut-label";
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
	newSidebarTab,
	sidebarLauncherNotesPath,
} from "@/lib/shell/sidebar-tab-actions";
import {
	closeSidebarTab,
	connectSidebarDock,
	isSidebarView,
	openOrActivateSidebarTarget,
	type SidebarAgentTarget,
	type SidebarPanelParams,
	updateSidebarAgentTarget,
} from "@/lib/shell/sidebar-tabs";
import { setAgentPanelMounted } from "@/lib/shell/ui-store";
import { pickVaultPreviewFile } from "@/lib/vault/pick";
import { getVaultPath, vaultLoadGeneration } from "@/lib/vault/store";
import { searchWikiLinks, type WikiSearchCandidate } from "@/lib/wiki/api";
import { openCitation } from "@/lib/workspace/actions";
import { installDockviewDragSelectionGuard } from "@/lib/workspace/dockview-drag-selection";
import { agenteroDockTheme } from "@/lib/workspace/dockview-theme";
import { openSidebarCitation } from "@/lib/workspace/sidebar-citations";
import {
	collectSidebarSearchFiles,
	rankSidebarSearchFiles,
	readSidebarFile,
	restoreSidebarFile,
	sidebarFileTarget,
	sidebarPaperTitle,
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

function SidebarTab({
	api,
	params,
}: IDockviewPanelHeaderProps<SidebarPanelParams>) {
	const { t } = useTranslation("app");
	const [title, setTitle] = useState(api.title);
	const target = params.target;
	const pdfTitle = useLibraryStore((store) =>
		target.kind === "pdf"
			? (sidebarPaperTitle(target.vaultRelPath, store.paperMetaByRelPath) ??
				basenameOf(target.vaultRelPath))
			: undefined,
	);
	useEffect(() => {
		const subscription = api.onDidTitleChange(({ title }) => setTitle(title));
		return () => subscription.dispose();
	}, [api]);
	useEffect(() => {
		if (pdfTitle && api.title !== pdfTitle) api.setTitle(pdfTitle);
	}, [api, pdfTitle]);
	const label = pdfTitle ?? title;
	return (
		<DocumentTab
			data-sidebar-view={api.id}
			title={label}
			closeLabel={t("tabs.close", { title: label })}
			onClose={() => closeSidebarTab(api.id)}
		/>
	);
}

function SidebarNewTabButton() {
	const { t } = useTranslation("app");
	const shortcut = useShortcutLabel("newSidebarTab");
	return (
		<div className="flex h-full items-center px-0.5">
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				className="rounded-md hover:bg-foreground/10 active:bg-foreground/15 dark:hover:bg-foreground/15 dark:active:bg-foreground/20"
				aria-label={t("sidebarTabs.newTab")}
				title={
					shortcut
						? `${t("sidebarTabs.newTab")} (${shortcut})`
						: t("sidebarTabs.newTab")
				}
				onClick={() => newSidebarTab()}
			>
				<Plus className="size-4" aria-hidden />
			</Button>
		</div>
	);
}

function SidebarLauncher({
	api,
	params,
}: IDockviewPanelProps<SidebarPanelParams>) {
	const { t } = useTranslation("app");
	const [busy, setBusy] = useState(false);
	const [query, setQuery] = useState("");
	const vaultPath = useVaultStore((store) => store.vaultPath);
	const tree = useVaultStore((store) => store.tree);
	const papers = useLibraryStore((store) => store.paperMetaByRelPath);
	const agentWindowOpen = useUiStore((store) => store.agentWindowOpen);
	const rightSidebarOpen = useUiStore((store) => store.rightSidebarOpen);
	const searchInput = useRef<HTMLInputElement>(null);
	const focusSearch = useRef(
		params.target.kind === "launcher" && params.target.focusSearch,
	);
	useEffect(() => {
		if (!rightSidebarOpen || !focusSearch.current) return;
		const frame = requestAnimationFrame(() => {
			if (!api.isActive || !searchInput.current) return;
			focusSearch.current = false;
			searchInput.current.focus({ preventScroll: true });
		});
		return () => cancelAnimationFrame(frame);
	}, [api, rightSidebarOpen]);
	const fallbackNotesPath = useWorkspaceStore(() => sidebarLauncherNotesPath());
	const notesPath =
		params.target.kind === "launcher" ? params.target.notesPath : undefined;
	const sourceNotesPath =
		notesPath === undefined && !agentWindowOpen ? fallbackNotesPath : notesPath;
	const files = useMemo(
		() => (vaultPath ? collectSidebarSearchFiles(tree, vaultPath, papers) : []),
		[tree, vaultPath, papers],
	);
	const search = query.trim();
	const [wikiResult, setWikiResult] = useState<{
		vault: string;
		query: string;
		hits: WikiSearchCandidate[];
	}>();
	useEffect(() => {
		if (!vaultPath || !search) {
			setWikiResult(undefined);
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			void searchWikiLinks(vaultPath, search, { kind: "file" })
				.catch(() => [])
				.then((hits) => {
					if (!cancelled)
						setWikiResult({ vault: vaultPath, query: search, hits });
				});
		}, 150);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [vaultPath, search]);
	const wikiHits =
		wikiResult?.vault === vaultPath && wikiResult?.query === search
			? wikiResult.hits
			: undefined;
	const matches = useMemo(
		() =>
			vaultPath
				? rankSidebarSearchFiles(vaultPath, search, files, wikiHits ?? [])
				: [],
		[vaultPath, search, files, wikiHits],
	);
	const openFile = async (filePath?: string, openNotes = false) => {
		const vault = getVaultPath();
		if (!vault) return;
		const generation = vaultLoadGeneration();
		const canOpen = () =>
			getVaultPath() === vault &&
			vaultLoadGeneration() === generation &&
			api.isVisible;
		setBusy(true);
		try {
			const path = filePath ?? (await pickVaultPreviewFile(vault));
			if (!path || !canOpen()) return;
			const target = sidebarFileTarget(vault, path);
			if (!target) throw new Error(t("sidebarTabs.unsupportedFile"));
			const file = await readSidebarFile(vault, target, {
				allowMissingNotes: openNotes,
			});
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
	const cardClass =
		"h-auto min-h-[5.25rem] min-w-0 flex-col items-start justify-start gap-2.5 whitespace-normal rounded-xl p-3.5 text-start leading-snug focus-visible:border-ring active:scale-[0.99] motion-reduce:transition-none";
	return (
		<div
			data-sidebar-view={api.id}
			className="agentero-scroll flex h-full min-w-0 flex-col overflow-auto px-4 py-6 sm:px-6"
		>
			<div className="mx-auto my-auto w-full max-w-[35rem] min-w-0 space-y-6">
				<Command
					className="relative z-10 size-auto overflow-visible bg-transparent p-0"
					shouldFilter={false}
					label={t("sidebarTabs.searchFiles")}
				>
					<InputGroup className="h-10 rounded-full border-border/70 bg-muted/60 px-3 dark:bg-input/50">
						<InputGroupAddon className="pl-0 pr-1">
							<Search className="size-4" aria-hidden />
						</InputGroupAddon>
						<CommandPrimitive.Input
							ref={searchInput}
							data-slot="input-group-control"
							className="h-full min-w-0 flex-1 select-text bg-transparent text-sm outline-none placeholder:text-muted-foreground"
							value={query}
							onValueChange={setQuery}
							placeholder={t("sidebarTabs.searchFiles")}
						/>
					</InputGroup>
					<CommandList
						hidden={!search}
						aria-busy={Boolean(search && !wikiHits)}
						className="absolute inset-x-0 top-full mt-2 max-h-[min(13rem,32dvh)] rounded-xl border border-border/60 bg-popover p-1 shadow-md"
					>
						{matches.length ? (
							matches.map(({ vaultRelPath: path, kind, label }) => {
								const Icon =
									kind === "notes"
										? NotebookPen
										: kind === "html"
											? FileCode
											: FileText;
								return (
									<CommandItem
										key={path}
										value={path}
										disabled={busy}
										onSelect={() => void openFile(path)}
										title={path}
									>
										<Icon
											className="size-4 text-muted-foreground"
											aria-hidden
										/>
										<span className="min-w-0">
											<span className="block truncate">{label}</span>
											{path !== label && (
												<span className="block truncate text-muted-foreground text-xs">
													{path}
												</span>
											)}
										</span>
									</CommandItem>
								);
							})
						) : (
							<p className="px-3 py-2 text-muted-foreground text-xs">
								{t(
									wikiHits
										? "sidebarTabs.noMatchingFiles"
										: "commandPalette.searching",
								)}
							</p>
						)}
					</CommandList>
				</Command>
				<div className="space-y-2.5">
					<h2 className="font-medium text-muted-foreground text-xs">
						{t("sidebarTabs.open")}
					</h2>
					<div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,6.5rem),1fr))] gap-2">
						<Button
							type="button"
							variant="secondary"
							className={cardClass}
							disabled={busy}
							onClick={() =>
								openOrActivateSidebarTarget(
									{ kind: "agent", scopeId: `sidebar:${createViewId()}` },
									{
										replace: api.id,
									},
								)
							}
						>
							<MessageSquarePlus className="size-4.5" aria-hidden />
							{t("sidebarTabs.newAgent")}
						</Button>
						<Button
							type="button"
							variant="secondary"
							className={cardClass}
							disabled={busy || !sourceNotesPath}
							onClick={() =>
								sourceNotesPath && void openFile(sourceNotesPath, true)
							}
						>
							<NotebookPen className="size-4.5" aria-hidden />
							{t("sidebarTabs.currentNotes")}
						</Button>
						<Button
							type="button"
							variant="secondary"
							className={cardClass}
							disabled={busy}
							onClick={() => void openFile()}
						>
							<FolderOpen className="size-4.5" aria-hidden />
							{t("sidebarTabs.openFile")}
						</Button>
					</div>
				</div>
			</div>
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
	const root = useRef<HTMLElement>(null);
	const disconnect = useRef<(() => void) | null>(null);
	const onReady = useCallback(
		({ api }: DockviewReadyEvent) => {
			disconnect.current?.();
			let agents: ReturnType<typeof listAgents> | undefined;
			const dragGuard =
				root.current && installDockviewDragSelectionGuard(root.current, api);
			const disconnectDock = connectSidebarDock(api, vaultPath, {
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
			disconnect.current = () => {
				dragGuard?.dispose();
				disconnectDock();
			};
		},
		[t, vaultPath],
	);
	useEffect(() => () => disconnect.current?.(), []);

	return (
		<aside
			ref={root}
			data-right-sidebar
			className="agentero-dockview agentero-dock-global h-full min-h-0 min-w-0 bg-sidebar"
			aria-label={t("titlebar.showRightSidebar")}
		>
			<DockviewReact
				className="h-full w-full"
				theme={agenteroDockTheme}
				components={components}
				defaultTabComponent={SidebarTab}
				leftHeaderActionsComponent={SidebarNewTabButton}
				noPanelsOverlay="emptyGroup"
				disableFloatingGroups
				dndStrategy="pointer"
				dndEdges={false}
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
