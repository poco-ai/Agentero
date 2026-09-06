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
	type DockviewPanelRenderer,
	DockviewReact,
	type DockviewReadyEvent,
	type DockviewTabGroupColorEntry,
	type DockviewWillDropEvent,
	type DropOverlayModelParams,
	type GetTabContextMenuItemsParams,
	type GetTabGroupChipContextMenuItemsParams,
	type IDockviewPanel,
	type IDockviewPanelProps,
} from "dockview-react";
import { FileCode2, X } from "lucide-react";
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
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { DocView, type DocViewProps } from "@/components/workspace/doc-view";
import { AgenteroTabGroupChip } from "@/components/workspace/tab-group-chip";
import { cn } from "@/lib/core/utils";
import { isLibraryVirtualPath, isTrashVirtualPath } from "@/lib/paper/api";
import { moveDocToWindow } from "@/lib/shell/leaf";
import { TAG_COLOR_IDS, tagSwatchStyle } from "@/lib/ui/tag-colors";
import { installDockviewDragSelectionGuard } from "@/lib/workspace/dockview-drag-selection";
import { installDockviewSashFrameLoop } from "@/lib/workspace/dockview-sash";
import { agenteroDockTheme } from "@/lib/workspace/dockview-theme";
import {
	isSplitDragPayload,
	readDraggedVaultPaths,
} from "@/lib/workspace/tab-dnd";
import {
	type DocTab,
	type OpenPlacement,
	panelPersistParams,
	type SplitDirection,
	tabIdForPath,
	tabNotesEligible,
} from "@/lib/workspace/tabs";
import type { CenterViewMode } from "@/lib/workspace/viewer";

/** Grey + paper tag palette (same swatches as library tags). */
const TAB_GROUP_COLORS = ["grey", ...TAG_COLOR_IDS] as const;

export type WorkspaceExternalDrop = {
	paths: string[];
	direction: SplitDirection;
	referencePanelId: string | null;
};

/** Imperative API for App: open with placement, cycle focus (visual dockview order). */
export type DockWorkspaceHandle = {
	/** Add (or activate) a panel with optional split placement. */
	openPanel: (tab: DocTab, placement?: OpenPlacement) => void;
	/** Add a panel as a right split and rebalance visible grid columns. */
	splitPanelRight: (tab: DocTab, referencePanelId: string | null) => void;
	/** Replace a panel id after a filesystem move while preserving its group. */
	remapPanel: (previousPanelId: string, tab: DocTab) => void;
	/** Cycle active panel by dockview `api.panels` order (wraps). */
	cycleActive: (delta: number) => void;
	/** Activate an existing panel by id. */
	activatePanel: (panelId: string) => void;
	/** True when the panel is registered in this dock and can be activated. */
	canActivatePanel: (panelId: string) => boolean;
	/** Make all visible Dockview grid groups equal width. */
	equalizeGridGroups: () => void;
};

type WorkspaceCtx = {
	tabsById: Map<string, DocTab>;
	activePanelId: string | null;
	centerProps: Omit<DocViewProps, "tab" | "active" | "keepMounted">;
	keepMountedIds: Set<string>;
	onToggleHtmlMode: (panelId: string) => void;
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
	const active = activePanelId === panelId || notesActive;
	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
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
	const { tabsById, onToggleHtmlMode } = useWorkspace();
	const [title, setTitle] = useState(api.title);
	const middleClickRef = useRef(false);
	const tab = tabsById.get(api.id) ?? null;
	const canToggleHtml =
		tab?.paperMeta?.type !== "html" &&
		Boolean(tab?.htmlUrl) &&
		(tab?.mode === "pdf" || tab?.mode === "html");

	useEffect(() => {
		const disposable = api.onDidTitleChange((event) => setTitle(event.title));
		return () => disposable.dispose();
	}, [api]);

	const close = useCallback(() => api.close(), [api]);
	const toggleHtml = useCallback(
		(event: React.MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			onToggleHtmlMode(api.id);
		},
		[api.id, onToggleHtmlMode],
	);

	return (
		<div
			{...rest}
			className="dv-default-tab"
			onPointerDown={(event) => {
				middleClickRef.current = event.button === 1;
				onPointerDown?.(event);
			}}
			onPointerUp={(event) => {
				if (middleClickRef.current && event.button === 1) close();
				middleClickRef.current = false;
				onPointerUp?.(event);
			}}
			onPointerLeave={(event) => {
				middleClickRef.current = false;
				onPointerLeave?.(event);
			}}
		>
			<span className="dv-default-tab-content">{title}</span>
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
			<button
				type="button"
				className="dv-default-tab-action"
				aria-label={t("tabs.close", { title })}
				onPointerDown={(event) => event.preventDefault()}
				onClick={() => close()}
			>
				<X className="size-3.5" />
			</button>
		</div>
	);
}

/** Alias preserves layout snapshots that stored tabComponent:"default". */
const tabComponents = { default: WorkspaceTab };

/**
 * Map dockview drop Position → addPanel Direction.
 * dockview uses top/bottom; addPanel uses above/below.
 * center → within (same group as a sibling tab).
 */
function toSplitDirection(
	position: DockviewDidDropEvent["position"],
): SplitDirection {
	if (position === "left") return "left";
	if (position === "top") return "above";
	if (position === "bottom") return "below";
	if (position === "center") return "within";
	return "right";
}

function isExternalPathDrag(native: DragEvent | PointerEvent): boolean {
	if (!(native instanceof DragEvent) || !native.dataTransfer) return false;
	return isSplitDragPayload(native.dataTransfer);
}

/**
 * True when the drag is a dockview-internal panel/group move (PanelTransfer
 * present). Group drags may have `panelId: null` — still internal. External
 * file-tree path drops return undefined from getData().
 */
function isInternalDockDrag(getData: () => unknown): boolean {
	return getData() != null;
}

/**
 * Per-target overlay geometry. Content gets a slightly larger edge activation
 * than dockview's 20% default so left/right/above/below splits are easier in
 * wide panels; header void stays generous for "merge as sibling tab".
 */
function resolveDropOverlayModel({ location }: DropOverlayModelParams):
	| {
			size?: { value: number; type: "percentage" };
			activationSize?: { value: number; type: "percentage" };
	  }
	| undefined {
	if (location === "content") {
		return {
			activationSize: { value: 25, type: "percentage" },
			size: { value: 50, type: "percentage" },
		};
	}
	if (location === "header_space") {
		return {
			activationSize: { value: 50, type: "percentage" },
		};
	}
	// tab / edge: keep dockview defaults (edge shaped by dndEdges).
	return undefined;
}

function resolveReferencePanel(
	api: DockviewApi,
	placement: OpenPlacement,
): string | undefined {
	if (placement?.referencePanelId && api.getPanel(placement.referencePanelId)) {
		return placement.referencePanelId;
	}
	if (api.activePanel?.id) return api.activePanel.id;
	return api.panels[0]?.id;
}

/**
 * PDF and Markdown panels use dockview `renderer: 'always'` so inactive
 * sibling tabs keep their React shell mounted (enables App-level PDF /
 * editor LRU keep-alive). Other modes stay `onlyWhenVisible` to free DOM
 * when not shown.
 */
function rendererForMode(mode: CenterViewMode): DockviewPanelRenderer {
	return mode === "pdf" || mode === "markdown" ? "always" : "onlyWhenVisible";
}

function applyPanelRenderer(panel: IDockviewPanel, mode: CenterViewMode): void {
	const want = rendererForMode(mode);
	if (panel.api.renderer !== want) {
		panel.api.setRenderer(want);
	}
}

function addPanelWithPlacement(
	api: DockviewApi,
	tab: DocTab,
	placement: OpenPlacement,
): IDockviewPanel {
	const referencePanel = resolveReferencePanel(api, placement);
	const direction = placement?.direction ?? "within";
	return api.addPanel({
		id: tab.id,
		component: "pane",
		// Omit tabComponent so dockview uses its built-in default tab.
		// A string like "default" looks up tabComponents["default"] and throws
		// if not registered (undefined is not a React component).
		title: tab.title,
		params: panelPersistParams(tab),
		renderer: rendererForMode(tab.mode),
		...(referencePanel
			? {
					position: {
						direction: direction === "within" ? "within" : direction,
						referencePanel,
					},
				}
			: {}),
	});
}

function rebalanceGridGroupWidths(api: DockviewApi): void {
	const groups = api.groups.filter(
		(group) => group.api.location.type === "grid",
	);
	if (groups.length < 2 || api.width <= 0) return;
	const width = Math.max(1, Math.floor(api.width / groups.length));
	for (const group of groups) {
		group.api.setSize({ width });
	}
}

/** Remove grid groups that ended up with no panels (e.g. persisted empty split). */
function compactEmptyGroups(api: DockviewApi): void {
	const gridGroups = api.groups.filter(
		(group) => group.api.location.type === "grid",
	);
	if (gridGroups.length < 2) return;
	if (!gridGroups.some((group) => group.panels.length > 0)) return;

	let changed = false;
	for (const group of gridGroups) {
		if (group.panels.length === 0) {
			try {
				api.removeGroup(group);
				changed = true;
			} catch {
				// ignore: dockview may refuse to remove a locked group
			}
		}
	}
	if (changed) {
		rebalanceGridGroupWidths(api);
	}
}

/** Push React tab title / persist params / renderer onto an existing dockview panel. */
function applyTabPanelMeta(panel: IDockviewPanel, tab: DocTab): void {
	if (panel.title !== tab.title) {
		panel.api.setTitle(tab.title);
	}
	panel.api.updateParameters(panelPersistParams(tab));
	applyPanelRenderer(panel, tab.mode);
}

/**
 * Align dockview panel membership with React `tabs[]`:
 * drop stale panels, add missing ones (default placement).
 */
function reconcilePanelMembership(api: DockviewApi, list: DocTab[]): void {
	const wantIds = new Set(list.map((t) => t.id));
	for (const panel of [...api.panels]) {
		if (!wantIds.has(panel.id)) {
			api.removePanel(panel);
		}
	}
	for (const tab of list) {
		if (api.getPanel(tab.id)) continue;
		addPanelWithPlacement(api, tab, null);
	}
	compactEmptyGroups(api);
}

/**
 * After fromJSON restore: refresh meta for surviving panels, then membership.
 */
function reconcileAfterLayoutRestore(api: DockviewApi, list: DocTab[]): void {
	for (const tab of list) {
		const panel = api.getPanel(tab.id);
		if (!panel) continue;
		// Always re-apply: fromJSON may restore older title/params/renderer.
		panel.api.setTitle(tab.title);
		panel.api.updateParameters(panelPersistParams(tab));
		applyPanelRenderer(panel, tab.mode);
	}
	reconcilePanelMembership(api, list);
}

function visiblePanelIds(api: DockviewApi): string[] {
	return api.groups.flatMap((group) =>
		group.activePanel ? [group.activePanel.id] : [],
	);
}

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
		const { t } = useTranslation("app");
		const apiRef = useRef<DockviewApi | null>(null);
		const workspaceRootRef = useRef<HTMLDivElement>(null);
		const syncingRef = useRef(false);
		const layoutTimerRef = useRef<number | null>(null);
		const disposablesRef = useRef<{ dispose: () => void }[]>([]);
		const tabsRef = useRef(tabs);
		tabsRef.current = tabs;
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

		useEffect(() => {
			const root = workspaceRootRef.current;
			if (!root) return;
			return installDockviewSashFrameLoop(root);
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
					onActiveRef.current(api.activePanel?.id ?? null);
					publishVisiblePanels(api);
					scheduleLayoutSave(api);
				});
			},
			[publishVisiblePanels, scheduleLayoutSave],
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
						addPanelWithPlacement(api, tab, placement);
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
				activatePanel(panelId) {
					apiRef.current?.getPanel(panelId)?.api.setActive();
				},
				canActivatePanel(panelId) {
					return Boolean(apiRef.current?.getPanel(panelId));
				},
				equalizeGridGroups() {
					const api = apiRef.current;
					if (!api) return;
					rebalanceGridGroupWidths(api);
				},
			}),
			[endSync],
		);

		const onReady = useCallback(
			(event: DockviewReadyEvent) => {
				const api = event.api;
				apiRef.current = api;

				disposablesRef.current = [
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
						if (isInternalDockDrag(() => e.getData())) return;
						if (!isExternalPathDrag(e.nativeEvent)) {
							e.preventDefault();
						}
					}),
					api.onDidActivePanelChange((ev) => {
						if (syncingRef.current) return;
						onActiveRef.current(ev.panel?.id ?? null);
						publishVisiblePanels(api);
					}),
					api.onDidRemovePanel((panel) => {
						if (syncingRef.current) return;
						onCloseRef.current(panel.id);
					}),
					// Single layout-save path (debounce). Programmatic + user changes
					// (incl. tab-group rename / color / membership via toJSON).
					api.onDidLayoutChange(() => {
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
			[endSync, publishVisiblePanels, scheduleLayoutSave, syncPanels],
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
		const metaKey = tabs.map((t) => `${t.id}:${t.title}:${t.mode}`).join("|");
		useEffect(() => {
			void metaKey;
			const api = apiRef.current;
			if (!api) return;
			for (const tab of tabsRef.current) {
				const panel = api.getPanel(tab.id);
				if (!panel) continue;
				applyTabPanelMeta(panel, tab);
			}
			// Param updates (e.g. resolved title) don't emit onDidLayoutChange;
			// re-save so the next restore shows titles before hydration (#410).
			scheduleLayoutSave(api);
		}, [metaKey, scheduleLayoutSave]);

		// Activate panel when React activePanelId changes (openTab / library).
		useEffect(() => {
			const api = apiRef.current;
			if (!api || !activePanelId || syncingRef.current) return;
			const panel = api.getPanel(activePanelId);
			if (panel && api.activePanel?.id !== activePanelId) {
				panel.api.setActive();
			}
		}, [activePanelId]);

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

		/** Cancel drop for unknown external payloads; internal moves always ok. */
		const handleWillDrop = useCallback((e: DockviewWillDropEvent) => {
			if (isInternalDockDrag(() => e.getData())) return;
			if (!isExternalPathDrag(e.nativeEvent)) {
				e.preventDefault();
			}
		}, []);

		/**
		 * Tab right-click menu (dockview opt-in). Close actions + tab-group
		 * create/remove. Closures go through panel.api.close() → onDidRemovePanel.
		 */
		const getTabContextMenuItems = useCallback(
			({ panel, group, api }: GetTabContextMenuItemsParams) => {
				const hasOthers = group.panels.length > 1;
				const existing = api.getTabGroupForPanel({
					groupId: group.id,
					panelId: panel.id,
				});
				const tab = tabsRef.current.find((t) => t.id === panel.id) ?? null;
				const menu: Array<
					| "separator"
					| { label: string; disabled?: boolean; action: () => void }
				> = [];
				if (onOpenNotesRef.current && tabNotesEligible(tab) && tab?.notesPath) {
					menu.push(
						{
							label: t("tabs.contextOpenNotes"),
							action: () => onOpenNotesRef.current?.(panel.id),
						},
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
				menu.push(
					{
						label: t("tabs.contextClose"),
						action: () => panel.api.close(),
					},
					{
						label: t("tabs.contextCloseOthers"),
						disabled: !hasOthers,
						action: () => {
							for (const p of group.panels) {
								if (p !== panel) p.api.close();
							}
						},
					},
					{
						label: t("tabs.contextCloseAll"),
						action: () => {
							for (const p of [...group.panels]) {
								p.api.close();
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
