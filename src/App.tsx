/**
 * App shell: thin composition layer. Domain state lives in zustand vanilla
 * stores (`src/lib/<domain>/store.ts`) and behavior in plain action modules;
 * heavy surfaces (file tree, dockview workspace, right rail, dialogs)
 * subscribe to their own slices so the shell re-renders only on layout-level
 * changes (vault switch, rail collapse, PDF immersive mode).
 */

import { FolderOpen } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AppDialogs } from "@/components/shell/app-dialogs";
import { BackgroundTasksPanel } from "@/components/shell/background-tasks-panel";
import { ErrorBoundary } from "@/components/shell/error-boundary";
import { fileTreeHandle } from "@/components/shell/file-tree-registry";
import { RightSidebar } from "@/components/shell/right-sidebar";
import { TitleBar } from "@/components/shell/title-bar";
import { VaultSidebar } from "@/components/shell/vault-sidebar";
import { VaultWelcome } from "@/components/shell/vault-welcome";
import { WikiNavProvider } from "@/components/shell/wiki-nav-provider";
import {
	ResizableGroup,
	ResizableHandle,
	ResizablePanel,
} from "@/components/ui/resizable";
import { resolveActivePdfHandle } from "@/components/viewer/pdf-viewer-registry";
import { WorkspaceHost } from "@/components/workspace/workspace-host";
import { useAppBootstrap } from "@/hooks/use-app-bootstrap";
import { useAppShortcuts } from "@/hooks/use-app-shortcuts";
import {
	useUiStore,
	useVaultStore,
	useWorkspaceStore,
} from "@/hooks/use-app-stores";
import { useConnectorSync } from "@/hooks/use-connector-sync";
import { useExternalFileDrop } from "@/hooks/use-external-file-drop";
import { useLayoutModelPrefetch } from "@/hooks/use-layout-model-prefetch";
import { useNativeMenuEvents } from "@/hooks/use-native-menu-events";
import { useAnyOverlayOpen } from "@/hooks/use-overlay-registration";
import { SIDEBAR_DEFAULT_PX, useShellLayout } from "@/hooks/use-shell-layout";
import { useVaultFileEvents } from "@/hooks/use-vault-file-events";
import {
	listenOpenAgentWithPrompt,
	setPendingAgentComposerPrompt,
} from "@/lib/agent/composer-seed";
import { pinActiveSelection } from "@/lib/agent/selection-store";
import { closeTopOverlay } from "@/lib/core/overlay-stack";
import { isMacOS, isTauri } from "@/lib/core/tauri";
import { doctorSetDirtyPaths } from "@/lib/doctor/api";
import { openMagicWand } from "@/lib/paper/import-actions";
import { scheduleLibraryRefresh } from "@/lib/paper/library-store";
import { UI_SCALE_PRESETS } from "@/lib/settings";
import { getSettings, patchSettings } from "@/lib/settings/react-store";
import {
	openSettingsWindow,
	toggleSettingsWindow,
} from "@/lib/shell/settings-window";
import {
	layout,
	openPalette,
	openRightTab,
	setRightSidebarOpenState,
	setSidebarCollapsedState,
	toggleChat,
	toggleRightSidebar,
	toggleSidebar,
} from "@/lib/shell/ui-store";
import {
	createNewVault,
	deleteSelectedPath,
	migrateZoteroFromWelcome,
	newWindow,
	openRecentVault,
	openRemoteVault,
	openSelectedInTerminal,
	openVault,
	refreshAll,
	removeRecent,
	revealSelectedInFinder,
} from "@/lib/vault/actions";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { scheduleTreeRefresh, vaultStore } from "@/lib/vault/store";
import { renameMayAffectWikiTargets } from "@/lib/wiki";
import { handleExternalRename } from "@/lib/wiki/actions";
import {
	scheduleWikiRebuild,
	shouldIgnoreInternalRenameEvent,
} from "@/lib/wiki/store";
import {
	applyDiskChange,
	closeTabOrWindow,
	cycleActiveTab,
	dirtyVaultPaths,
	toggleNotesSplit,
} from "@/lib/workspace/actions";
import { workspaceStore } from "@/lib/workspace/store";
import {
	normalizeTabPath,
	tabHasNotesSplit,
	tabIsPaperNotes,
	tabNotesEligible,
} from "@/lib/workspace/tabs";

// macOS keeps native traffic lights (Overlay title bar) and a native menu bar.
// Other desktop platforms also use native decorations, but have no native menu
// bar, so the title bar shows a Settings gear as the entry point.
const isMacDesktop = isTauri() && isMacOS();
const showSettingsGear = isTauri() && !isMacOS();

function zoomIn(): void {
	const current = getSettings().uiScale;
	const idx = UI_SCALE_PRESETS.findIndex((s) => s > current);
	const next = idx === -1 ? current : UI_SCALE_PRESETS[idx];
	if (next !== current) patchSettings({ uiScale: next });
}

function zoomOut(): void {
	const current = getSettings().uiScale;
	let next = current;
	for (let i = UI_SCALE_PRESETS.length - 1; i >= 0; i--) {
		if (UI_SCALE_PRESETS[i] < current) {
			next = UI_SCALE_PRESETS[i];
			break;
		}
	}
	if (next !== current) patchSettings({ uiScale: next });
}

function zoomReset(): void {
	if (getSettings().uiScale !== 1) patchSettings({ uiScale: 1 });
}

/** Title bar wrapper: subscribes to tabs/ui itself so the shell stays still. */
function AppTitleBar() {
	const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
	const rightSidebarOpen = useUiStore((s) => s.rightSidebarOpen);
	const rightSidebarTab = useUiStore((s) => s.rightSidebarTab);
	const tabs = useWorkspaceStore((s) => s.tabs);
	const activeTabId = useWorkspaceStore((s) => s.activeTabId);

	/** NOTES toggle: active panel is a paper PDF/HTML, or its NOTES. */
	const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
	let notesEligiblePaper =
		activeTab && tabNotesEligible(activeTab) ? activeTab : null;
	if (
		!notesEligiblePaper &&
		activeTab?.notesPath &&
		tabIsPaperNotes(activeTab)
	) {
		const paperDir = activeTab.notesPath.replace(/[\\/]NOTES\.md$/i, "");
		notesEligiblePaper =
			tabs.find(
				(t) =>
					t.kind === "paper" &&
					normalizeTabPath(t.path) === normalizeTabPath(paperDir),
			) ?? null;
	}
	const notesSplitOpen = notesEligiblePaper
		? tabHasNotesSplit(tabs, notesEligiblePaper)
		: false;

	return (
		<TitleBar
			isMacDesktop={isMacDesktop}
			showSettingsGear={showSettingsGear}
			sidebarCollapsed={sidebarCollapsed}
			notesEligible={Boolean(notesEligiblePaper)}
			showNotes={notesSplitOpen}
			rightSidebarOpen={rightSidebarOpen}
			rightSidebarTab={rightSidebarTab}
			onToggleSidebar={toggleSidebar}
			onToggleNotes={toggleNotesSplit}
			onToggleRightSidebar={toggleRightSidebar}
			onOpenRightTab={openRightTab}
			onOpenSettings={openSettingsWindow}
		/>
	);
}

/** Welcome / no-vault center pane (desktop picker or web hint). */
function WelcomeCenter() {
	const { t } = useTranslation(["app"]);
	const busy = useVaultStore((s) => s.busy);
	const recentVaults = useVaultStore((s) => s.recentVaults);
	if (!isTauri()) {
		return (
			<div className="agentero-scroll flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-muted/30 p-6 text-center">
				<FolderOpen className="size-10 text-muted-foreground" />
				<div className="max-w-xs space-y-2">
					<p className="font-medium text-sm">{t("vault.noVaultOpenTitle")}</p>
					<p className="text-muted-foreground text-xs">
						{t("vault.runTauriPrefix")}{" "}
						<code className="rounded bg-muted px-1 py-0.5">pnpm tauri dev</code>{" "}
						{t("vault.runTauriSuffix")}
					</p>
				</div>
			</div>
		);
	}
	return (
		<VaultWelcome
			recentVaults={recentVaults}
			busy={busy}
			onOpenVault={() => void openVault()}
			onOpenRemoteVault={(args) => void openRemoteVault(args)}
			onCreateVault={() => void createNewVault()}
			onMigrateZotero={() => void migrateZoteroFromWelcome()}
			onOpenRecent={(path) => void openRecentVault(path)}
			onRemoveRecent={removeRecent}
		/>
	);
}

export default function App() {
	useAppBootstrap();
	useConnectorSync();
	useLayoutModelPrefetch();
	// Cancel WebView navigation on any OS file drop (PDF import is tree-only).
	useExternalFileDrop();
	const {
		sidebarPanelRef,
		rightSidebarPanelRef,
		sourcePanelRef,
		sidebarAsideRef,
		editorPaneRef,
		leftWidthPxRef,
		rightWidthPxRef,
	} = useShellLayout();

	const vaultPath = useVaultStore((s) => s.vaultPath);
	const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
	const rightSidebarOpen = useUiStore((s) => s.rightSidebarOpen);

	// The Settings window is a separate WebView. Mirror unsaved Markdown paths
	// into Host state so Doctor can reject a batch before touching any file.
	useEffect(() => {
		if (!isTauri()) return;
		let lastPayload = "";
		const sync = () => {
			const root = vaultStore.getState().vaultPath;
			if (!root || isRemoteVaultHandle(root)) return;
			const paths = dirtyVaultPaths(root).sort();
			const payload = JSON.stringify([root, paths]);
			if (payload === lastPayload) return;
			lastPayload = payload;
			void doctorSetDirtyPaths(root, paths).catch((error) => {
				console.warn("[doctor] dirty-path sync failed", error);
			});
		};
		sync();
		const unsubscribeWorkspace = workspaceStore.subscribe(sync);
		const unsubscribeVault = vaultStore.subscribe(sync);
		return () => {
			unsubscribeWorkspace();
			unsubscribeVault();
		};
	}, []);

	// Settings Doctor → main: open Agent rail with a prefilled composer prompt.
	useEffect(() => {
		if (!isTauri()) return;
		let cancelled = false;
		let unlisten: (() => void) | undefined;
		void listenOpenAgentWithPrompt((payload) => {
			const text = payload.text.trim();
			if (!text) return;
			setPendingAgentComposerPrompt(text);
			openRightTab("agent");
			void (async () => {
				try {
					const { getCurrentWindow } = await import("@tauri-apps/api/window");
					await getCurrentWindow().setFocus();
				} catch {
					// ignore
				}
			})();
		}).then((off) => {
			if (cancelled) off();
			else unlisten = off;
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, []);

	// Host Vault filesystem watcher → editor reseed, tree refresh, wiki rebuild.
	useVaultFileEvents({
		vaultPath,
		onDiskChange: (absPath) => void applyDiskChange(absPath),
		onStructuralChange: scheduleTreeRefresh,
		onLibraryChange: scheduleLibraryRefresh,
		onWikiChange: scheduleWikiRebuild,
		shouldIgnoreEvent: shouldIgnoreInternalRenameEvent,
		onExternalRename: (rename, payload) => {
			if (renameMayAffectWikiTargets(payload.paths)) {
				void handleExternalRename(rename);
			}
		},
	});

	const anyOverlayOpen = useAnyOverlayOpen();
	useAppShortcuts(anyOverlayOpen, {
		settings: toggleSettingsWindow,
		// Esc → dismiss top overlay (settings, palette, dialogs…)
		closeSheet: () => {
			closeTopOverlay();
		},
		newWindow: () => void newWindow(),
		openVault: () => void openVault(),
		createVault: () => void createNewVault(),
		refreshTree: refreshAll,
		revealInFinder: revealSelectedInFinder,
		openInTerminal: openSelectedInTerminal,
		deleteTreeItem: deleteSelectedPath,
		collapseTreeCurrent: () => fileTreeHandle()?.collapseSelected(),
		collapseTreeDefault: () => fileTreeHandle()?.collapseToDefault(),
		magicWand: openMagicWand,
		quickOpen: () => openPalette("go"),
		commandPalette: () => openPalette("commands"),
		toggleSidebar,
		// ⌘L (Cursor-style): pin the live selection into the Agent context and
		// focus the chat; with no selection it just toggles the sidebar.
		toggleChat: () => {
			if (pinActiveSelection()) {
				openRightTab("agent");
			} else toggleChat();
		},
		focusSidebar: () => layout()?.focusSidebar(),
		focusEditor: () => layout()?.focusEditorPane(),
		focusNotes: () => layout()?.focusNotesEditor(),
		closeTab: closeTabOrWindow,
		nextTab: () => cycleActiveTab(1),
		prevTab: () => cycleActiveTab(-1),
		zoomIn,
		zoomOut,
		zoomReset,
		// ⌘. — toggle visual-region annotation for the paper being read.
		// Handles live on the PDF body tab; when NOTES is focused (default
		// split), resolve the sibling paper tab instead of requiring mode=pdf.
		visualAnnotation: () => {
			resolveActivePdfHandle()?.toggleVisualAnnotation();
		},
	});

	useNativeMenuEvents({
		onSettings: openSettingsWindow,
		onOpenVault: () => void openVault(),
		onCreateVault: () => void createNewVault(),
		onRefresh: refreshAll,
		onToggleSidebar: toggleSidebar,
		onToggleChat: toggleChat,
		onCloseTabOrWindow: closeTabOrWindow,
	});

	return (
		<WikiNavProvider>
			<div className="flex h-dvh max-h-dvh flex-col overflow-hidden bg-background text-foreground">
				{/*
				  macOS title bar (traffic lights row): Tauri Overlay + hiddenTitle.
				  Height must match trafficLightPosition math in tao (≈32px → h-8).
				*/}
				<AppTitleBar />

				<ErrorBoundary label="workspace">
					<ResizableGroup
						orientation="horizontal"
						className="h-full min-h-0 flex-1 overflow-hidden"
					>
						<ResizablePanel
							id="sidebar"
							panelRef={sidebarPanelRef}
							defaultSize={SIDEBAR_DEFAULT_PX}
							minSize={160}
							maxSize="30%"
							collapsible
							collapsedSize={0}
							// Keep pixel width when the right rail or Notes column toggles.
							groupResizeBehavior="preserve-pixel-size"
							className="min-h-0 overflow-hidden"
							onResize={(size) => {
								// Only mark collapsed after a real collapse, never mid-drag.
								if (size.inPixels <= 1) setSidebarCollapsedState(true);
								else if (size.inPixels >= 80) {
									setSidebarCollapsedState(false);
									leftWidthPxRef.current = size.inPixels;
								}
							}}
						>
							<aside
								ref={sidebarAsideRef}
								className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/20"
							>
								<VaultSidebar />
							</aside>
						</ResizablePanel>

						{sidebarCollapsed ? null : <ResizableHandle />}

						<ResizablePanel
							id="source"
							panelRef={sourcePanelRef}
							minSize={200}
							collapsible
							collapsedSize={0}
							className="min-h-0 min-w-0 overflow-hidden"
						>
							<div
								ref={editorPaneRef}
								className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
							>
								{/* Document panels + library toolbar live inside dockview. */}
								{!vaultPath ? (
									<WelcomeCenter />
								) : (
									<div className="relative min-h-0 flex-1 overflow-hidden">
										<WorkspaceHost />
									</div>
								)}
							</div>
						</ResizablePanel>

						{/* Right sidebar: always mounted + collapsible (same as left). */}
						{rightSidebarOpen ? <ResizableHandle /> : null}
						<ResizablePanel
							id="right-sidebar"
							panelRef={rightSidebarPanelRef}
							defaultSize={0}
							minSize={260}
							maxSize="50%"
							collapsible
							collapsedSize={0}
							groupResizeBehavior="preserve-pixel-size"
							className="min-h-0 overflow-hidden"
							onResize={(size) => {
								if (size.inPixels <= 1) setRightSidebarOpenState(false);
								else if (size.inPixels >= 80) {
									setRightSidebarOpenState(true);
									rightWidthPxRef.current = size.inPixels;
								}
							}}
						>
							<RightSidebar />
						</ResizablePanel>
					</ResizableGroup>
				</ErrorBoundary>

				<AppDialogs />

				<BackgroundTasksPanel />
			</div>
		</WikiNavProvider>
	);
}
