/**
 * App shell: thin composition layer. Domain state lives in zustand vanilla
 * stores (`src/lib/<domain>/store.ts`) and behavior in plain action modules;
 * heavy surfaces (file tree, dockview workspace, right rail, dialogs)
 * subscribe to their own slices so the shell re-renders only on layout-level
 * changes (vault switch, rail collapse, PDF immersive mode).
 */

import { FolderOpen } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { OnboardingRoot } from "@/components/onboarding/onboarding-root";
import { AppDialogs } from "@/components/shell/app-dialogs";
import { BackgroundTasksPanel } from "@/components/shell/background-tasks-panel";
import { ErrorBoundary } from "@/components/shell/error-boundary";
import { fileTreeHandle } from "@/components/shell/file-tree-registry";
import { HintModeProvider } from "@/components/shell/hint-mode-provider";
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
import { resolveActivePdfHandle } from "@/components/viewer";
import { WorkspaceHost } from "@/components/workspace/workspace-host";
import { WritingDialogs } from "@/components/writing/writing-dialogs";
import { useAgentCatalogPrefetch } from "@/hooks/use-agent-catalog-prefetch";
import { useAppBootstrap } from "@/hooks/use-app-bootstrap";
import { useAppShortcuts } from "@/hooks/use-app-shortcuts";
import { useUiStore, useVaultStore } from "@/hooks/use-app-stores";
import { useConfigReminders } from "@/hooks/use-config-reminders";
import { useConnectorSync } from "@/hooks/use-connector-sync";
import { useExternalFileDrop } from "@/hooks/use-external-file-drop";
import { useFeatureTour } from "@/hooks/use-feature-tour";
import { useFlushMarkdownOnClose } from "@/hooks/use-flush-markdown-on-close";
import { useLayoutModelPrefetch } from "@/hooks/use-layout-model-prefetch";
import { useMcpSync } from "@/hooks/use-mcp-sync";
import { useNativeMenuEvents } from "@/hooks/use-native-menu-events";
import { useAnyModalOverlayOpen } from "@/hooks/use-overlay-registration";
import { usePaperBackfillPrompt } from "@/hooks/use-paper-backfill-prompt";
import {
	RAIL_COLLAPSED_MAX_PX,
	RIGHT_SIDEBAR_MAX_RATIO,
	RIGHT_SIDEBAR_MIN_PX,
	SIDEBAR_MAX_RATIO,
	SIDEBAR_MIN_PX,
	useShellLayout,
} from "@/hooks/use-shell-layout";
import { useVaultFileEvents } from "@/hooks/use-vault-file-events";
import {
	agentChromeStore,
	getAgentChromeState,
} from "@/lib/agent/agent-chrome-store";
import { listAgents } from "@/lib/agent/api";
import { focusAgentComposer } from "@/lib/agent/composer-focus";
import {
	listenOpenAgentWithPrompt,
	setPendingAgentComposerPrompt,
} from "@/lib/agent/composer-seed";
import {
	runSelectionAddToChat,
	runSelectionQuickChat,
} from "@/lib/agent/selection-quick-chat";
import { pinActiveSelection } from "@/lib/agent/selection-store";
import { closeTopOverlay } from "@/lib/core/overlay-stack";
import { isMacOS, isTauri } from "@/lib/core/tauri";
import { doctorSetDirtyPaths } from "@/lib/doctor/api";
import {
	isCommittedRefreshPath,
	noteExternalLibraryPaths,
	noteTreePaths,
} from "@/lib/lifecycle/refresh-wave";
import { openMagicWand } from "@/lib/paper/import-actions";
import { UI_SCALE_PRESETS } from "@/lib/settings";
import { getSettings, patchSettings } from "@/lib/settings/react-store";
import {
	commitShellRailWidths,
	RAIL_RECORD_MIN_PX,
} from "@/lib/shell/layout-persist";
import {
	openSettingsWindow,
	toggleSettingsWindow,
} from "@/lib/shell/settings-window";
import {
	type LayoutMode,
	layout,
	openPalette,
	setLayoutMode,
	setRightSidebarOpenState,
	setSidebarCollapsedState,
	toggleSidebar,
	uiStore,
} from "@/lib/shell/ui-store";
import { openRightTab, toggleChat } from "@/lib/shell/ui-window-actions";
import { toggleBorderlessFullscreen } from "@/lib/shell/window-fullscreen";
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
import { vaultStore } from "@/lib/vault/store";
import { renameMayAffectWikiTargets } from "@/lib/wiki";
import { handleExternalRename } from "@/lib/wiki/actions";
import {
	scheduleWikiRebuild,
	shouldIgnoreInternalRenameEvent,
} from "@/lib/wiki/store";
import {
	applyDiskChange,
	closeTabOrWindow,
	cycleActiveGroupTab,
	cycleActiveTab,
	dirtyVaultPaths,
	reopenClosedTab,
	splitActivePane,
} from "@/lib/workspace/actions";
import { toggleActiveMarkdownSource } from "@/lib/workspace/markdown-source-toggle";
import { workspaceStore } from "@/lib/workspace/store";

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
	const layoutMode = useUiStore((s) => s.layoutMode);
	// PERF: stable identity — an inline arrow would break TitleBar's memo.
	const applyLayoutMode = useCallback(
		(mode: Exclude<LayoutMode, "custom">) => layout()?.applyLayoutMode(mode),
		[],
	);

	return (
		<TitleBar
			isMacDesktop={isMacDesktop}
			showSettingsGear={showSettingsGear}
			sidebarCollapsed={sidebarCollapsed}
			rightSidebarOpen={rightSidebarOpen}
			layoutMode={layoutMode}
			onToggleSidebar={toggleSidebar}
			onToggleAgent={toggleChat}
			onApplyLayoutMode={applyLayoutMode}
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
			<div className="agentero-scroll flex min-h-0 flex-1 select-none flex-col items-center justify-center gap-4 bg-muted/30 p-6 text-center">
				<FolderOpen className="size-10 text-muted-foreground" />
				<div className="max-w-xs space-y-2">
					<p className="font-medium text-sm">{t("vault.noVaultOpenTitle")}</p>
					<p className="text-muted-foreground text-xs">
						{t("vault.runTauriPrefix")}{" "}
						<code className="select-text rounded bg-muted px-1 py-0.5">
							pnpm tauri dev
						</code>{" "}
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
	useTranslation(["app"]);
	useAppBootstrap();
	useConnectorSync();
	useMcpSync();
	useLayoutModelPrefetch();
	// Soft-probe catalog ACP agents at open (sidebar panel is lazy-mounted).
	useAgentCatalogPrefetch();
	// Cancel WebView navigation and route unclaimed external PDF drops globally.
	useExternalFileDrop();
	// First-vault highlight tour (driver.js) + Settings replay listener.
	useFeatureTour();
	// Low-frequency config reminders (#658): startup layout-model hint.
	useConfigReminders();
	// Vault backfill prompt: lib decides when, this window renders the toast.
	usePaperBackfillPrompt();
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const {
		sidebarPanelRef,
		rightSidebarPanelRef,
		sourcePanelRef,
		sidebarAsideRef,
		editorPaneRef,
		leftWidthPxRef,
		rightWidthPxRef,
		initialLeftPx,
		initialRightPx,
	} = useShellLayout(vaultPath);

	const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
	const rightSidebarOpen = useUiStore((s) => s.rightSidebarOpen);
	const isResizingRightRef = useRef(false);

	// Seed the chrome agent icon with the registry default before the Agent panel
	// is ever opened. If the panel mounts first, it wins via agentChromeStore.
	useEffect(() => {
		if (!isTauri()) return;
		if (getAgentChromeState().agentId) return;
		void listAgents().then((res) => {
			if (!res.defaultId) return;
			const agent = res.agents.find((a) => a.id === res.defaultId);
			if (agent) {
				agentChromeStore.setState({
					agentId: agent.id,
					name: agent.name,
					template: agent.template,
				});
			}
		});
	}, []);

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
		onStructuralChange: (paths) => {
			noteTreePaths(paths.filter((path) => !isCommittedRefreshPath(path)));
		},
		onLibraryChange: noteExternalLibraryPaths,
		onWikiChange: scheduleWikiRebuild,
		shouldIgnoreEvent: shouldIgnoreInternalRenameEvent,
		onExternalRename: (rename, payload) => {
			if (renameMayAffectWikiTargets(payload.paths)) {
				void handleExternalRename(rename);
			}
		},
		onUnverifiedRename: (payload) => {
			// Incomplete OS rename pairs cannot authorize link rewrites. Path-extension
			// heuristics still run (md/pdf/images/dirs), but toasting every echo was
			// noisy for ordinary saves — log only.
			if (renameMayAffectWikiTargets(payload.paths)) {
				console.warn(
					"[wiki] unverified external rename; links left unchanged",
					payload.paths,
				);
			}
		},
	});

	const anyModalOverlayOpen = useAnyModalOverlayOpen();
	useFlushMarkdownOnClose();
	useAppShortcuts(anyModalOverlayOpen, {
		settings: toggleSettingsWindow,
		// Esc → dismiss top overlay (settings, palette, dialogs…)
		closeSheet: () => {
			closeTopOverlay();
		},
		newWindow: () => void newWindow(),
		openVault: () => void openVault(),
		createVault: () => void createNewVault(),
		refreshTree: refreshAll,
		revealInFinder: () => {
			revealSelectedInFinder();
		},
		openInTerminal: () => {
			openSelectedInTerminal();
		},
		deleteTreeItem: () => {
			deleteSelectedPath();
		},
		collapseTreeCurrent: () => {
			fileTreeHandle()?.collapseSelected();
		},
		collapseTreeDefault: () => {
			fileTreeHandle()?.collapseToDefault();
		},
		cutTreeItem: () => {
			fileTreeHandle()?.cutSelected();
		},
		pasteTreeItem: () => {
			fileTreeHandle()?.pasteIntoSelected();
		},
		magicWand: openMagicWand,
		quickOpen: () => openPalette("go"),
		commandPalette: () => openPalette("commands"),
		toggleMarkdownSource: () => toggleActiveMarkdownSource(),
		toggleSidebar,
		toggleChat,
		// ⌘K: in-page Quick chat (Ask) from the armed PDF / Plaza selection.
		quickChat: () => {
			runSelectionQuickChat();
		},
		// Pin a staged selection, open Agent, and focus the composer.
		addSelectionToChat: () => {
			if (runSelectionAddToChat()) return;
			pinActiveSelection();
			openRightTab("agent");
			focusAgentComposer();
		},
		focusSidebar: () => layout()?.focusSidebar(),
		focusEditor: () => layout()?.focusEditorPane(),
		focusNotes: () => layout()?.focusNotesEditor(),
		closeTab: () => {
			closeTabOrWindow();
		},
		reopenTab: reopenClosedTab,
		splitPane: splitActivePane,
		nextTab: () => cycleActiveTab(1),
		prevTab: () => cycleActiveTab(-1),
		nextGroupTab: () => cycleActiveGroupTab(1),
		prevGroupTab: () => cycleActiveGroupTab(-1),
		zoomIn,
		zoomOut,
		zoomReset,
		// ⌘. — toggle visual-region annotation for the paper being read.
		// Handles live on the PDF body tab; when NOTES is focused (default
		// split), resolve the sibling paper tab instead of requiring mode=pdf.
		visualAnnotation: () => {
			resolveActivePdfHandle()?.toggleVisualAnnotation();
		},
		// ⌥A — toggle full-text (layout) translation for the paper being read.
		// Same dual-pane-aware path as the toolbar Languages button.
		layoutTranslate: () => {
			resolveActivePdfHandle()?.toggleLayoutTranslate();
		},
		// F11 — Windows borderless fullscreen (no-op on other platforms).
		toggleFullscreen: () => {
			void toggleBorderlessFullscreen();
		},
	});

	useNativeMenuEvents({
		onSettings: openSettingsWindow,
		onOpenVault: () => void openVault(),
		onCreateVault: () => void createNewVault(),
		onRefresh: refreshAll,
		onToggleSidebar: toggleSidebar,
		onSplitPane: splitActivePane,
		onToggleChat: toggleChat,
		onCloseTabOrWindow: closeTabOrWindow,
	});

	// Persist a completed user resize into the active layout's width slot.
	// Ratios are stored as fractions of the window width — the same base
	// the restore path (railPxFromRatio) uses — so measured panel px map
	// 1:1 onto the saved values. Sub-threshold px (rails dragged shut)
	// keep the previously remembered width.
	const commitUserRailPx = (leftPx?: number, rightPx?: number) => {
		const ratio = (px?: number) =>
			px !== undefined && px >= RAIL_RECORD_MIN_PX
				? px / window.innerWidth
				: undefined;
		commitShellRailWidths(
			{ leftRatio: ratio(leftPx), rightRatio: ratio(rightPx) },
			uiStore.getState().lastAppliedPreset ?? "custom",
			window.innerWidth,
		);
	};
	// Double-click resets the adjacent rail to its session default via an
	// imperative resize (isUserInteraction stays false), so persist the
	// known reset target directly instead of racing a DOM read-back.
	const commitRailReset = (side: "left" | "right") => {
		if (side === "right" && uiStore.getState().layoutMode !== "reading") {
			setLayoutMode("custom");
		}
		commitUserRailPx(
			side === "left" ? initialLeftPx : undefined,
			side === "right" ? initialRightPx : undefined,
		);
	};

	return (
		<HintModeProvider>
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
							onLayoutChanged={(_nextLayout, meta) => {
								// Only genuine user resizes (drag release / keyboard) update
								// the remembered widths; mount echoes, window resizes and
								// programmatic preset applies are filtered out here.
								if (!meta.isUserInteraction) return;
								// Only user resize of the right (Agent) rail transitions the
								// layout into custom. The left Vault sidebar is independent of
								// Agent / Notes presets.
								if (
									isResizingRightRef.current &&
									uiStore.getState().layoutMode !== "reading"
								) {
									setLayoutMode("custom");
								}
								isResizingRightRef.current = false;
								commitUserRailPx(
									vaultPath
										? sidebarPanelRef.current?.getSize().inPixels
										: undefined,
									rightSidebarPanelRef.current?.getSize().inPixels,
								);
							}}
						>
							{vaultPath ? (
								<Fragment>
									<ResizablePanel
										id="sidebar"
										panelRef={sidebarPanelRef}
										defaultSize={sidebarCollapsed ? 0 : initialLeftPx}
										minSize={SIDEBAR_MIN_PX}
										maxSize={`${Math.round(SIDEBAR_MAX_RATIO * 100)}%`}
										collapsible
										collapsedSize={0}
										// Keep pixel width when the right rail or Notes column toggles.
										groupResizeBehavior="preserve-pixel-size"
										className="min-h-0 overflow-hidden"
										onResize={(size) => {
											// Only mark collapsed after a real collapse, never mid-drag.
											if (size.inPixels <= RAIL_COLLAPSED_MAX_PX) {
												setSidebarCollapsedState(true);
											} else if (size.inPixels >= RAIL_RECORD_MIN_PX) {
												setSidebarCollapsedState(false);
												leftWidthPxRef.current = size.inPixels;
											}
										}}
									>
										{/*
									  `isolate` (stacking context) separates the rail from the PDF
									  pane, but a whole-rail `transform-gpu` GPU layer goes
									  unpainted in WKWebView after paper open / tab switch /
									  import and only recovers on scroll. Rows use `top`, not
									  `translateY`, so no compositing layer is needed here.
									*/}
										<aside
											ref={sidebarAsideRef}
											data-vault-sidebar
											className="flex h-full min-h-0 flex-col overflow-hidden bg-sidebar isolate"
										>
											<VaultSidebar />
										</aside>
									</ResizablePanel>

									{sidebarCollapsed ? null : (
										<ResizableHandle
											onDoubleClick={() => commitRailReset("left")}
											onPointerDown={() => {
												isResizingRightRef.current = false;
											}}
											onKeyDown={() => {
												isResizingRightRef.current = false;
											}}
										/>
									)}
								</Fragment>
							) : null}

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
										<div className="relative h-full min-h-0 flex-1 overflow-hidden">
											<WorkspaceHost />
											<WritingDialogs />
										</div>
									)}
								</div>
							</ResizablePanel>

							{/* Right sidebar: always mounted + collapsible (same as left). */}
							{rightSidebarOpen ? (
								<ResizableHandle
									onDoubleClick={() => commitRailReset("right")}
									onPointerDown={() => {
										isResizingRightRef.current = true;
									}}
									onKeyDown={() => {
										isResizingRightRef.current = true;
									}}
								/>
							) : null}
							<ResizablePanel
								id="right-sidebar"
								panelRef={rightSidebarPanelRef}
								defaultSize={rightSidebarOpen ? initialRightPx : 0}
								minSize={RIGHT_SIDEBAR_MIN_PX}
								maxSize={`${Math.round(RIGHT_SIDEBAR_MAX_RATIO * 100)}%`}
								collapsible
								collapsedSize={0}
								groupResizeBehavior="preserve-pixel-size"
								className="min-h-0 overflow-hidden"
								onResize={(size) => {
									if (size.inPixels <= RAIL_COLLAPSED_MAX_PX) {
										setRightSidebarOpenState(false);
									} else if (size.inPixels >= RAIL_RECORD_MIN_PX) {
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

					{/* First-run setup wizard (Raycast-style full-window overlay). */}
					<OnboardingRoot />
				</div>
			</WikiNavProvider>
		</HintModeProvider>
	);
}
