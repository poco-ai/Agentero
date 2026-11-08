/**
 * Side-effect import: dockview 7 registers optional modules
 * (ContextMenu, TabGroupChips, AdvancedDnD, Accessibility/keyboard dock)
 * only when the `dockview` package is evaluated. Importing `dockview-react`
 * alone can tree-shake that registration, leaving contextMenuService
 * undefined so tab right-click silently does nothing.
 */
import "dockview";

import {
	type DockviewApi,
	type DockviewDefaultTab,
	type DockviewDidDropEvent,
	type DockviewDndOverlayEvent,
	DockviewReact,
	type DockviewReadyEvent,
	type DockviewTabGroupColorEntry,
	type DockviewWillDropEvent,
	type GetTabContextMenuItemsParams,
	type GetTabGroupChipContextMenuItemsParams,
	type IDockviewPanelProps,
} from "dockview-react";
import { FileCode2 } from "lucide-react";
import {
	type ComponentProps,
	createContext,
	forwardRef,
	memo,
	useCallback,
	useContext,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { PaperTitle } from "@/components/paper/paper-title";
import { MathText } from "@/components/ui/math-text";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { TexLiveStatusDot } from "@/components/viewer/texlive/tex-live-status";
import { DocView, type DocViewProps } from "@/components/workspace/doc-view";
import { DocumentTab } from "@/components/workspace/document-tab";
import { PaperPathBar } from "@/components/workspace/paper-path-bar";
import { AgenteroTabGroupChip } from "@/components/workspace/tab-group-chip";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { displayPath } from "@/lib/core/path";
import { cn } from "@/lib/core/utils";
import { isLibraryVirtualPath, isTrashVirtualPath } from "@/lib/paper/api";
import { isPlazaVirtualPath } from "@/lib/plaza/sources";
import { moveDocToWindow } from "@/lib/shell/leaf";
import { formatShortcutById } from "@/lib/shell/shortcuts";
import { setLayoutMode, uiStore } from "@/lib/shell/ui-store";
import { TAG_COLOR_IDS, tagSwatchStyle } from "@/lib/ui/tag-colors";
import { openTexPdf } from "@/lib/workspace/actions";
import type { DockHandle } from "@/lib/workspace/dock-registry";
import { installDockviewDragSelectionGuard } from "@/lib/workspace/dockview-drag-selection";
import { installDockviewSashFrameLoop } from "@/lib/workspace/dockview-sash";
import { agenteroDockTheme } from "@/lib/workspace/dockview-theme";
import {
	ensureLibraryTabFirst,
	isLibraryPanel,
} from "@/lib/workspace/library-tab-position";
import { createMarkdownResizeFreeze } from "@/lib/workspace/markdown-resize-freeze";
import {
	rememberNotesSplitWidth,
	restoreNotesSplitWidth,
} from "@/lib/workspace/notes-split-width";
import { installResizeGesture } from "@/lib/workspace/resize-gesture";
import { useSelectionOverlayActive } from "@/lib/workspace/selection-overlay";
import { readDraggedVaultPaths } from "@/lib/workspace/tab-dnd";
import {
	type DocTab,
	type ReadingColumns,
	type SplitDirection,
	tabIdForPath,
	tabIsPaperNotes,
	tabNotesEligible,
} from "@/lib/workspace/tabs";
import { isTexPath } from "@/lib/workspace/viewer";
import { pdfHandleFor } from "@/lib/workspace/viewer/pdf-viewer-registry";
import { createWritingFocus } from "@/lib/workspace/writing-focus";

import {
	addPanelWithPlacement,
	applyTabPanelMeta,
	isExternalPathDrag,
	isInternalDockDrag,
	readingColumnAnchors,
	rebalanceGridGroupWidths,
	reconcileAfterLayoutRestore,
	reconcilePanelMembership,
	resolveDropOverlayModel,
	toSplitDirection,
	visiblePanelIds,
} from "./dock-layout";

/** Grey + paper tag palette (same swatches as library tags). */
const TAB_GROUP_COLORS = ["grey", ...TAG_COLOR_IDS] as const;

/**
 * Dockview's built-in menu items only support a plain `label` string.
 * Build a custom row so we can show a right-aligned shortcut hint (file-tree style).
 */
function buildTabContextMenuItem(opts: {
	label: string;
	shortcut?: string;
	action: () => void;
	disabled?: boolean;
}): { element: HTMLElement } {
	const el = document.createElement("div");
	el.className = "dv-context-menu-item";
	el.setAttribute("role", "menuitem");
	if (opts.disabled) {
		el.classList.add("dv-context-menu-item--disabled");
		el.setAttribute("aria-disabled", "true");
	}
	if (opts.shortcut) {
		el.classList.add("agentero-dv-context-menu-item--with-shortcut");
		const labelEl = document.createElement("span");
		labelEl.textContent = opts.label;
		const shortcutEl = document.createElement("span");
		shortcutEl.className = "agentero-dv-context-menu-shortcut";
		shortcutEl.textContent = opts.shortcut;
		el.append(labelEl, shortcutEl);
	} else {
		el.textContent = opts.label;
	}
	if (!opts.disabled) {
		el.addEventListener("click", () => {
			opts.action();
			// Custom `element` items skip dockview's built-in close(); drop the
			// popover wrapper. PopupService clears leftover listeners on next open.
			el.closest(".dv-context-menu")?.parentElement?.remove();
		});
	}
	return { element: el };
}

/** Virtual rows and `agentero:` paths have no filesystem location to copy. */
function tabPathCopyable(tab: DocTab | null): tab is DocTab {
	if (!tab?.path) return false;
	if (tab.kind === "library" || tab.kind === "trash" || tab.kind === "plaza") {
		return false;
	}
	if (tab.path.startsWith("agentero:")) return false;
	if (
		isLibraryVirtualPath(tab.path) ||
		isTrashVirtualPath(tab.path) ||
		isPlazaVirtualPath(tab.path)
	) {
		return false;
	}
	return true;
}

export type WorkspaceExternalDrop = {
	paths: string[];
	direction: SplitDirection;
	referencePanelId: string | null;
};

/** Imperative API for App: open with placement, cycle focus (visual dockview order). */
export type DockWorkspaceHandle = DockHandle;

type WorkspaceCtx = {
	tabsById: Map<string, DocTab>;
	activePanelId: string | null;
	centerProps: Omit<DocViewProps, "tab" | "active" | "keepMounted">;
	keepMountedIds: Set<string>;
	onToggleHtmlMode: (panelId: string) => void;
	onClosePanel: (panelId: string) => void;
};

const WorkspaceContext = createContext<WorkspaceCtx | null>(null);

function useWorkspace(): WorkspaceCtx {
	const ctx = useContext(WorkspaceContext);
	if (!ctx) throw new Error("DockWorkspace context missing");
	return ctx;
}

function WorkspacePane(props: IDockviewPanelProps<{ panelId: string }>) {
	const { tabsById, activePanelId, centerProps, keepMountedIds } =
		useWorkspace();
	const panelId = props.params.panelId;
	const tab = tabsById.get(panelId) ?? null;
	if (!tab) {
		return <div className="h-full w-full bg-background" />;
	}
	const notesActive =
		tab.mode === "html" &&
		tab.notesPath != null &&
		activePanelId === tabIdForPath(tab.notesPath);
	const focused = activePanelId === panelId;
	const active = focused || notesActive;
	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
			{focused ? (
				<PaperPathBar tab={tab} vaultPath={centerProps.vaultPath} />
			) : null}
			<DocView
				{...centerProps}
				tab={tab}
				active={active}
				keepMounted={keepMountedIds.has(tab.id)}
			/>
		</div>
	);
}

const components = { pane: WorkspacePane };

/** Restore headers hidden by older single-preview layouts. */
function syncProjectPreviewHeaders(api: DockviewApi) {
	for (const group of api.groups) {
		if (group.model.header.hidden) group.model.header.hidden = false;
	}
}

function WorkspaceTab({
	api,
	containerApi: _containerApi,
	params: _params,
	onPointerDown,
	onPointerUp,
	onPointerLeave,
	tabLocation: _tabLocation,
	...rest
}: ComponentProps<typeof DockviewDefaultTab>) {
	const { t } = useTranslation("app");
	const { tabsById, onToggleHtmlMode, onClosePanel } = useWorkspace();
	const [title, setTitle] = useState(api.title);
	const middleClickRef = useRef(false);
	const tab = tabsById.get(api.id) ?? null;
	// Library is the resident tab — no close affordance.
	const isLibrary = Boolean(tab && isLibraryVirtualPath(tab.path));
	const canToggleHtml =
		tab?.paperMeta?.type !== "html" &&
		Boolean(tab?.htmlUrl) &&
		(tab?.mode === "pdf" || tab?.mode === "html");

	useEffect(() => {
		const disposable = api.onDidTitleChange((event) => setTitle(event.title));
		return () => disposable.dispose();
	}, [api]);

	const close = useCallback(() => onClosePanel(api.id), [api.id, onClosePanel]);
	const toggleHtml = useCallback(
		(event: React.MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			onToggleHtmlMode(api.id);
		},
		[api.id, onToggleHtmlMode],
	);

	return (
		<DocumentTab
			{...rest}
			title={
				tab?.paperMeta ? (
					<PaperTitle text={title ?? ""} />
				) : (
					<MathText text={title ?? ""} />
				)
			}
			closeLabel={t("tabs.close", { title })}
			onClose={isLibrary ? undefined : close}
			trailing={
				<>
					{tab?.texLive ? (
						<TexLiveStatusDot
							rootPath={tab.texRoot ?? tab.path.replace(/\.pdf$/i, ".tex")}
						/>
					) : null}
					{canToggleHtml ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									className="dv-default-tab-action"
									aria-label={
										tab?.mode === "pdf" ? t("tabs.showHtml") : t("tabs.showPdf")
									}
									onPointerDown={(event) => {
										event.preventDefault();
										event.stopPropagation();
									}}
									onClick={toggleHtml}
								>
									<FileCode2 className="size-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{tab?.mode === "pdf" ? t("tabs.showHtml") : t("tabs.showPdf")}
							</TooltipContent>
						</Tooltip>
					) : null}
				</>
			}
			onPointerDown={(event) => {
				middleClickRef.current = event.button === 1;
				onPointerDown?.(event);
			}}
			onPointerUp={(event) => {
				if (middleClickRef.current && event.button === 1 && !isLibrary) {
					close();
				}
				middleClickRef.current = false;
				onPointerUp?.(event);
			}}
			onPointerLeave={(event) => {
				middleClickRef.current = false;
				onPointerLeave?.(event);
			}}
		/>
	);
}

/** Alias preserves layout snapshots that stored tabComponent:"default". */
const tabComponents = { default: WorkspaceTab };

type DockWorkspaceProps = {
	tabs: DocTab[];
	activePanelId: string | null;
	/** Global dockview layout snapshot (null = rebuild from panel list). */
	layout: unknown | null;
	/** Panel ids whose heavyweight content (PDF viewer / Plate editor) stays mounted. */
	keepMountedIds: string[];
	centerProps: Omit<DocViewProps, "tab" | "active" | "keepMounted">;
	onActivePanelChange: (panelId: string | null) => void;
	onVisiblePanelIdsChange: (panelIds: string[]) => void;
	onClosePanel: (panelId: string) => void;
	onLayoutChange: (layout: unknown) => void;
	/** Switch an HTML-backed paper panel between its PDF and HTML views. */
	onToggleHtmlMode: (panelId: string) => void;
	/** Tab context menu: open the NOTES.md companion of a paper body panel. */
	onOpenNotesPanel?: (panelId: string) => void;
	/** File-tree path drop into a split zone (title-bar tabs gone — only paths). */
	onExternalDrop: (drop: WorkspaceExternalDrop) => void;
	className?: string;
};

/**
 * Global center workspace: one DockviewReact owns all open document panels.
 * Split, tab chrome, close, reorder, and layout persistence are native dockview.
 *
 * React owns document content (`tabs[]`) + active path for sidebars / Paper Info.
 * Open-with-placement and focus cycling go through the imperative handle.
 *
 * @see https://dockview.dev/docs/core/dnd/external
 */
export const DockWorkspace = memo(
	forwardRef<DockWorkspaceHandle, DockWorkspaceProps>(function DockWorkspace(
		{
			tabs,
			activePanelId,
			layout,
			keepMountedIds,
			centerProps,
			onActivePanelChange,
			onVisiblePanelIdsChange,
			onClosePanel,
			onLayoutChange,
			onToggleHtmlMode,
			onOpenNotesPanel,
			onExternalDrop,
			className,
		},
		ref,
	) {
		const { t } = useTranslation(["app", "viewer"]);
		const apiRef = useRef<DockviewApi | null>(null);
		const workspaceRootRef = useRef<HTMLDivElement>(null);
		// Suspend dockview DnD while a floating selection overlay (toolbar or
		// ask card) is open — they can sit against the tab strip and a stray
		// drag would split the layout (#608).
		const selectionOverlayActive = useSelectionOverlayActive();
		const syncingRef = useRef(false);
		const layoutTimerRef = useRef<number | null>(null);
		const disposablesRef = useRef<{ dispose: () => void }[]>([]);
		const tabsRef = useRef(tabs);
		tabsRef.current = tabs;
		const writingFocus = useRef(createWritingFocus());
		const vaultRef = useRef(centerProps.vaultPath);
		vaultRef.current = centerProps.vaultPath;
		const syncWritingFocus = useCallback((api: DockviewApi) => {
			writingFocus.current(
				api,
				tabsRef.current.find((tab) => tab.id === api.activePanel?.id),
				vaultRef.current,
			);
		}, []);
		const layoutRef = useRef(layout);
		layoutRef.current = layout;
		const onCloseRef = useRef(onClosePanel);
		onCloseRef.current = onClosePanel;
		const onActiveRef = useRef(onActivePanelChange);
		onActiveRef.current = onActivePanelChange;
		const onVisibleRef = useRef(onVisiblePanelIdsChange);
		onVisibleRef.current = onVisiblePanelIdsChange;
		const onLayoutRef = useRef(onLayoutChange);
		onLayoutRef.current = onLayoutChange;
		const onToggleHtmlRef = useRef(onToggleHtmlMode);
		onToggleHtmlRef.current = onToggleHtmlMode;
		const onOpenNotesRef = useRef(onOpenNotesPanel);
		onOpenNotesRef.current = onOpenNotesPanel;
		const onDropRef = useRef(onExternalDrop);
		onDropRef.current = onExternalDrop;
		const activePanelIdRef = useRef(activePanelId);
		activePanelIdRef.current = activePanelId;
		const cachedReadingColumnsRef = useRef<ReadingColumns | null>(null);

		useEffect(() => {
			const root = workspaceRootRef.current;
			if (!root) return;
			// One gesture signal for every pane resize source: the sash hook below
			// reports divider drags, and the gesture's own root observer covers
			// shell rail drags and native window resizes (see resize-gesture.ts).
			const gesture = installResizeGesture(root);
			// A dragged divider re-runs the editor's container query every frame;
			// pin the query containers for the gesture so only the pane edges move.
			const freeze = createMarkdownResizeFreeze(root, gesture);
			const disposeSashLoop = installDockviewSashFrameLoop(root, {
				onSashDragBegin: gesture.begin,
				onSashDragEnd: gesture.end,
			});
			return () => {
				disposeSashLoop();
				freeze.dispose();
				gesture.dispose();
			};
		}, []);

		const tabGroupColors = useMemo<DockviewTabGroupColorEntry[]>(
			() =>
				TAB_GROUP_COLORS.map((id) => ({
					id,
					value:
						id === "grey"
							? "var(--muted-foreground)"
							: (tagSwatchStyle(id)?.backgroundColor ?? ""),
					label: t(`tabs.tabGroupColor.${id}` as const),
				})),
			[t],
		);

		const scheduleLayoutSave = useCallback((api: DockviewApi) => {
			if (layoutTimerRef.current != null) {
				window.clearTimeout(layoutTimerRef.current);
			}
			layoutTimerRef.current = window.setTimeout(() => {
				layoutTimerRef.current = null;
				if (syncingRef.current) {
					// Still mutating — try again after the batch settles.
					scheduleLayoutSave(api);
					return;
				}
				try {
					if (api.panels.length > 0) {
						onLayoutRef.current(api.toJSON());
					}
				} catch {
					// ignore
				}
			}, 120);
		}, []);

		const publishVisiblePanels = useCallback((api: DockviewApi) => {
			onVisibleRef.current(visiblePanelIds(api));
		}, []);

		const endSync = useCallback(
			(api: DockviewApi) => {
				requestAnimationFrame(() => {
					syncingRef.current = false;
					syncWritingFocus(api);
					if (
						uiStore.getState().layoutMode === "reading" &&
						!api.hasMaximizedGroup()
					) {
						const activeId = activePanelIdRef.current ?? api.activePanel?.id;
						const target =
							(activeId && api.getPanel(activeId)) ??
							api.panels.find((p) => {
								const t = tabsRef.current.find((tab) => tab.id === p.id);
								return t && !tabIsPaperNotes(t);
							}) ??
							api.activePanel;
						if (target) {
							api.maximizeGroup(target);
						}
					}
					onActiveRef.current(api.activePanel?.id ?? null);
					publishVisiblePanels(api);
					scheduleLayoutSave(api);
				});
			},
			[publishVisiblePanels, scheduleLayoutSave, syncWritingFocus],
		);

		const keepSet = useMemo(() => new Set(keepMountedIds), [keepMountedIds]);

		const tabsById = useMemo(() => {
			const m = new Map<string, DocTab>();
			for (const t of tabs) m.set(t.id, t);
			return m;
		}, [tabs]);

		const ctx = useMemo<WorkspaceCtx>(
			() => ({
				tabsById,
				activePanelId,
				centerProps,
				keepMountedIds: keepSet,
				onToggleHtmlMode: (panelId) => onToggleHtmlRef.current(panelId),
				onClosePanel: (panelId) => onCloseRef.current(panelId),
			}),
			[tabsById, activePanelId, centerProps, keepSet],
		);

		/** Membership only: add missing / remove closed. Placement is imperative. */
		const syncPanels = useCallback(
			(api: DockviewApi) => {
				syncingRef.current = true;
				try {
					reconcilePanelMembership(api, tabsRef.current);
				} finally {
					endSync(api);
				}
			},
			[endSync],
		);

		useImperativeHandle(
			ref,
			() => ({
				openPanel(tab, placement = null) {
					const api = apiRef.current;
					if (!api) return;
					const existing = api.getPanel(tab.id);
					if (existing) {
						existing.api.setActive();
						return;
					}
					syncingRef.current = true;
					try {
						const isBackgroundNote =
							api.hasMaximizedGroup() &&
							tabIsPaperNotes(tab) &&
							Boolean(placement && placement.direction === "within");
						addPanelWithPlacement(api, tab, placement, {
							inactive: isBackgroundNote,
						});
					} finally {
						endSync(api);
					}
				},
				splitPanelRight(tab, referencePanelId) {
					const api = apiRef.current;
					if (!api) return;
					const existing = api.getPanel(tab.id);
					if (existing) {
						existing.api.setActive();
						rebalanceGridGroupWidths(api);
						return;
					}
					syncingRef.current = true;
					try {
						addPanelWithPlacement(api, tab, {
							direction: "right",
							referencePanelId,
						});
						rebalanceGridGroupWidths(api);
					} finally {
						endSync(api);
					}
				},
				remapPanel(previousPanelId, tab) {
					const api = apiRef.current;
					if (!api || previousPanelId === tab.id) return;
					const previous = api.getPanel(previousPanelId);
					if (!previous) return;
					const activate = api.activePanel?.id === previousPanelId;
					syncingRef.current = true;
					try {
						const existing = api.getPanel(tab.id);
						if (!existing) {
							addPanelWithPlacement(api, tab, {
								direction: "within",
								referencePanelId: previousPanelId,
							});
						}
						api.removePanel(previous);
						if (activate) {
							api.getPanel(tab.id)?.api.setActive();
						}
					} finally {
						endSync(api);
					}
				},
				cycleActive(delta) {
					const api = apiRef.current;
					if (!api || api.panels.length < 2) return;
					const panels = api.panels;
					const cur = api.activePanel?.id;
					const idx = panels.findIndex((p) => p.id === cur);
					const base = idx < 0 ? 0 : idx;
					const nextIdx = (base + delta + panels.length) % panels.length;
					panels[nextIdx]?.api.setActive();
				},
				visiblePanelIds() {
					const api = apiRef.current;
					return api ? visiblePanelIds(api) : [];
				},
				activatePanel(panelId, options) {
					const api = apiRef.current;
					const panel = api?.getPanel(panelId);
					if (!panel) return;
					if (
						options?.skipSetGroupActive ||
						(api?.hasMaximizedGroup() && !panel.group.api.isMaximized())
					) {
						panel.group.model.openPanel(panel, { skipSetGroupActive: true });
					} else {
						panel.api.setActive();
					}
				},
				canActivatePanel(panelId) {
					return Boolean(apiRef.current?.getPanel(panelId));
				},
				maximizeActivePanel() {
					const api = apiRef.current;
					const activeId = activePanelIdRef.current ?? api?.activePanel?.id;
					const panel =
						(activeId && api?.getPanel(activeId)) ??
						api?.panels.find((p) => {
							const t = tabsRef.current.find((tab) => tab.id === p.id);
							return t && !tabIsPaperNotes(t);
						}) ??
						api?.activePanel;
					if (!api || !panel) return false;
					if (!api.hasMaximizedGroup()) api.maximizeGroup(panel);
					return true;
				},
				exitMaximizedPanel() {
					apiRef.current?.exitMaximizedGroup();
				},
				isMaximizedPanel() {
					return apiRef.current?.hasMaximizedGroup() ?? false;
				},
				rememberNotesSplitWidth(paperId, notesId) {
					const api = apiRef.current;
					if (api) rememberNotesSplitWidth(api, paperId, notesId);
				},
				restoreNotesSplitWidth(paperId, notesId) {
					const api = apiRef.current;
					if (api) restoreNotesSplitWidth(api, paperId, notesId);
				},
				readingColumns() {
					const api = apiRef.current;
					if (!api) return null;
					const resolved = readingColumnAnchors(
						api,
						cachedReadingColumnsRef.current,
					);
					if (resolved && !api.hasMaximizedGroup()) {
						cachedReadingColumnsRef.current = resolved;
					}
					return resolved;
				},
			}),
			[endSync],
		);

		const onReady = useCallback(
			(event: DockviewReadyEvent) => {
				const api = event.api;
				apiRef.current = api;

				disposablesRef.current = [
					api.onWillDragPanel((e) => {
						if (isLibraryPanel(e.panel)) e.nativeEvent.preventDefault();
					}),
					api.onWillDragGroup((e) => {
						if (e.group.panels.some(isLibraryPanel)) {
							e.nativeEvent.preventDefault();
						}
					}),
					installDockviewDragSelectionGuard(
						workspaceRootRef.current as HTMLDivElement,
						api,
					),
					api.onUnhandledDragOver((e: DockviewDndOverlayEvent) => {
						if (!isExternalPathDrag(e.nativeEvent)) return;
						e.accept();
					}),
					// Veto overlay for unknown external drags (keep internal + path drops).
					api.onWillShowOverlay((e) => {
						if (
							e.kind === "tab" &&
							isLibraryPanel(e.panel) &&
							e.position === "left"
						) {
							e.preventDefault();
							return;
						}
						if (isInternalDockDrag(() => e.getData())) return;
						if (!isExternalPathDrag(e.nativeEvent)) {
							e.preventDefault();
						}
					}),
					api.onDidActivePanelChange((ev) => {
						if (syncingRef.current) return;
						syncWritingFocus(api);
						onActiveRef.current(ev.panel?.id ?? null);
						publishVisiblePanels(api);
					}),
					api.onDidMaximizedGroupChange((event) => {
						if (event.isMaximized) {
							if (uiStore.getState().layoutMode !== "reading") {
								setLayoutMode("reading");
							}
						}
					}),
					api.onDidRemovePanel((panel) => {
						if (syncingRef.current) return;
						onCloseRef.current(panel.id);
					}),
					// Single layout-save path (debounce). Programmatic + user changes
					// (incl. tab-group rename / color / membership via toJSON).
					api.onDidLayoutChange(() => {
						ensureLibraryTabFirst(api);
						syncProjectPreviewHeaders(api);
						if (!syncingRef.current) publishVisiblePanels(api);
						scheduleLayoutSave(api);
					}),
				];

				// Restore layout as the sole geometry source; rebuild only on failure.
				const list = tabsRef.current;
				const snap = layoutRef.current;
				if (snap && typeof snap === "object") {
					syncingRef.current = true;
					try {
						api.fromJSON(snap as Parameters<DockviewApi["fromJSON"]>[0]);
						// fromJSON may restore older title/params/renderer; drop stale /
						// add missing panels.
						reconcileAfterLayoutRestore(api, list);
						endSync(api);
					} catch {
						api.clear();
						// syncPanels owns endSync
						syncPanels(api);
					}
				} else {
					syncPanels(api);
				}
			},
			[
				endSync,
				publishVisiblePanels,
				scheduleLayoutSave,
				syncPanels,
				syncWritingFocus,
			],
		);

		// Sync membership when panel ids change (not titles).
		const panelIdsKey = tabs.map((t) => t.id).join("|");
		useEffect(() => {
			void panelIdsKey;
			const api = apiRef.current;
			if (!api) return;
			syncPanels(api);
		}, [panelIdsKey, syncPanels]);

		// Title + persist params + renderer channel (mode/path without full membership).
		const metaKey = tabs
			.map(
				(t) =>
					`${t.id}:${t.title}:${t.mode}:${t.texRoot ?? ""}:${t.writingRoot ?? ""}`,
			)
			.join("|");
		useEffect(() => {
			void metaKey;
			const api = apiRef.current;
			if (!api) return;
			for (const tab of tabsRef.current) {
				const panel = api.getPanel(tab.id);
				if (!panel) continue;
				applyTabPanelMeta(panel, tab);
			}
			syncProjectPreviewHeaders(api);
			syncWritingFocus(api);
			// Param updates (e.g. resolved title) don't emit onDidLayoutChange;
			// re-save so the next restore shows titles before hydration (#410).
			scheduleLayoutSave(api);
		}, [metaKey, scheduleLayoutSave, syncWritingFocus]);

		// Activate panel when React activePanelId changes (openTab / library).
		useEffect(() => {
			const api = apiRef.current;
			if (!api || !activePanelId || syncingRef.current) return;
			const panel = api.getPanel(activePanelId);
			if (panel && api.activePanel?.id !== activePanelId) {
				panel.api.setActive();
			}
			syncWritingFocus(api);
		}, [activePanelId, syncWritingFocus]);

		useEffect(() => {
			return () => {
				if (layoutTimerRef.current != null) {
					window.clearTimeout(layoutTimerRef.current);
					layoutTimerRef.current = null;
				}
				for (const d of disposablesRef.current) d.dispose();
				disposablesRef.current = [];
				apiRef.current = null;
			};
		}, []);

		const handleExternalDrop = useCallback((e: DockviewDidDropEvent) => {
			if (!isExternalPathDrag(e.nativeEvent)) return;
			const native = e.nativeEvent;
			if (!(native instanceof DragEvent) || !native.dataTransfer) return;
			const paths = readDraggedVaultPaths(native.dataTransfer);
			if (!paths.length) return;
			const direction = toSplitDirection(e.position);
			const referencePanelId =
				e.panel?.id ??
				e.group?.activePanel?.id ??
				e.group?.panels[0]?.id ??
				null;
			onDropRef.current({ paths, direction, referencePanelId });
		}, []);

		/** Protect Library's first slot and reject unknown external payloads. */
		const handleWillDrop = useCallback((e: DockviewWillDropEvent) => {
			if (
				e.kind === "tab" &&
				isLibraryPanel(e.panel) &&
				e.position === "left"
			) {
				e.preventDefault();
				return;
			}
			if (isInternalDockDrag(() => e.getData())) return;
			if (!isExternalPathDrag(e.nativeEvent)) {
				e.preventDefault();
			}
		}, []);

		/**
		 * Tab right-click menu (dockview opt-in). Close actions + tab-group
		 * create/remove. Close requests go through workspace actions before removing panels.
		 */
		const getTabContextMenuItems = useCallback(
			({ panel, group, api }: GetTabContextMenuItemsParams) => {
				const existing = api.getTabGroupForPanel({
					groupId: group.id,
					panelId: panel.id,
				});
				const tab = tabsRef.current.find((t) => t.id === panel.id) ?? null;
				const isLibraryPanel = (panelId: string) => {
					const found =
						tabsRef.current.find((candidate) => candidate.id === panelId) ??
						null;
					return Boolean(found && isLibraryVirtualPath(found.path));
				};
				const panelIsLibrary = isLibraryPanel(panel.id);
				const closableOthers = group.panels.filter(
					(p) => p !== panel && !isLibraryPanel(p.id),
				).length;
				const menu: Array<
					| "separator"
					| { label: string; disabled?: boolean; action: () => void }
					| { element: HTMLElement }
				> = [];
				if (onOpenNotesRef.current && tabNotesEligible(tab) && tab?.notesPath) {
					menu.push(
						buildTabContextMenuItem({
							label: t("tabs.contextOpenNotes"),
							shortcut: formatShortcutById("splitPane"),
							action: () => onOpenNotesRef.current?.(panel.id),
						}),
						"separator",
					);
				}
				if (tab != null && isTexPath(tab.path)) {
					menu.push(
						buildTabContextMenuItem({
							label: t("tabs.openTexPdf"),
							shortcut: formatShortcutById("splitPane"),
							action: () => {
								void openTexPdf(tab.path, { referencePanelId: panel.id });
							},
						}),
						"separator",
					);
				}
				const canMoveToWindow =
					tab != null &&
					tab.kind !== "library" &&
					tab.kind !== "trash" &&
					!isLibraryVirtualPath(tab.path) &&
					!isTrashVirtualPath(tab.path);
				if (canMoveToWindow && tab) {
					menu.push({
						label: t("tabs.contextMoveToNewWindow"),
						action: () => {
							void moveDocToWindow(tab.path, tab.mode);
						},
					});
				}
				if (tab?.mode === "pdf") {
					const handle = pdfHandleFor(panel.id);
					if (handle) {
						menu.push({
							label: t("viewer:pdf.exportAnnotatedPdf"),
							action: () => {
								handle
									.exportAnnotatedPdf()
									.catch((error: unknown) => notifyError(errorText(error)));
							},
						});
					}
				}
				if (tabPathCopyable(tab)) {
					menu.push(
						buildTabContextMenuItem({
							label: t("tabs.contextCopyPath"),
							action: () => {
								void copyTextToClipboard(displayPath(tab.path), {
									successMessage: t("tabs.copiedPath"),
									errorMessage: t("tabs.copyPathFailed"),
									successNotify: { duration: 2000 },
								});
							},
						}),
					);
				}
				menu.push(
					buildTabContextMenuItem({
						label: t("tabs.contextClose"),
						shortcut: formatShortcutById("closeTab"),
						disabled: panelIsLibrary,
						action: () => onCloseRef.current(panel.id),
					}),
					{
						label: t("tabs.contextCloseOthers"),
						disabled: closableOthers === 0,
						action: () => {
							for (const p of group.panels) {
								if (p !== panel && !isLibraryPanel(p.id))
									onCloseRef.current(p.id);
							}
						},
					},
					{
						label: t("tabs.contextCloseAll"),
						action: () => {
							for (const p of [...group.panels]) {
								if (!isLibraryPanel(p.id)) onCloseRef.current(p.id);
							}
						},
					},
					"separator",
				);

				if (existing) {
					menu.push({
						label: t("tabs.contextRemoveFromTabGroup"),
						action: () => {
							api.removePanelFromTabGroup({
								groupId: group.id,
								panelId: panel.id,
							});
						},
					});
				} else {
					menu.push({
						label: t("tabs.contextCreateTabGroup"),
						action: () => {
							const tg = api.createTabGroup({
								groupId: group.id,
								label: t("tabs.tabGroupDefaultName"),
								color: "blue",
							});
							api.addPanelToTabGroup({
								groupId: group.id,
								tabGroupId: tg.id,
								panelId: panel.id,
							});
						},
					});
				}

				return menu;
			},
			[t],
		);

		const getTabGroupChipContextMenuItems = useCallback(
			({ tabGroup, group, api }: GetTabGroupChipContextMenuItemsParams) => {
				return [
					"rename" as const,
					"colorPicker" as const,
					"separator" as const,
					{
						label: t("tabs.tabGroupDissolve"),
						action: () => {
							api.dissolveTabGroup({
								groupId: group.id,
								tabGroupId: tabGroup.id,
							});
						},
					},
				];
			},
			[t],
		);

		return (
			<WorkspaceContext.Provider value={ctx}>
				<div
					ref={workspaceRootRef}
					className={cn(
						"agentero-dockview agentero-dock-global h-full min-h-0 min-w-0 w-full",
						className,
					)}
				>
					<DockviewReact
						className="h-full w-full"
						theme={agenteroDockTheme}
						components={components}
						tabComponents={tabComponents}
						defaultTabComponent={WorkspaceTab}
						disableFloatingGroups
						// Tauri WKWebView: HTML5 DnD is unreliable; pointer covers mouse+touch.
						// Floating/popout already disabled — no cross-window HTML5 drag needed.
						dndStrategy="pointer"
						// Floating selection overlays sit against the tab strip; freeze
						// tab/group drag while one is open so a stray drag cannot split (#608).
						disableDnd={selectionOverlayActive}
						dndEdges={{ size: { value: 24, type: "pixels" } }}
						dropOverlayModel={resolveDropOverlayModel}
						// Within-group tabs + between groups + Ctrl+M keyboard dock.
						// Orthogonal to App ⌥⌘←/→ which cycles all panels by visual order.
						keyboardNavigation
						tabGroupAccent="palette"
						tabGroupColors={tabGroupColors}
						tabGroupChipComponent={AgenteroTabGroupChip}
						getTabContextMenuItems={getTabContextMenuItems}
						getTabGroupChipContextMenuItems={getTabGroupChipContextMenuItems}
						onReady={onReady}
						onWillDrop={handleWillDrop}
						onDidDrop={handleExternalDrop}
					/>
				</div>
			</WorkspaceContext.Provider>
		);
	}),
);

DockWorkspace.displayName = "DockWorkspace";
