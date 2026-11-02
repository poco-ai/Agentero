/**
 * App shell UI state (zustand vanilla): side rails, palette and
 * dialog visibility, and one-shot open signals. Signal bumps only re-render
 * their subscribers instead of the whole App.
 */

import { createStore } from "zustand/vanilla";
import type { PaperSearchGroup, SkillDiscovery } from "@/lib/paper/lookup";
import type { PaletteMode } from "@/lib/shell/commands/types";
import {
	getShellLayoutPrefs,
	saveCustomRails,
	saveLastMode,
	saveLastPreset,
} from "@/lib/shell/layout-persist";
import {
	type LayoutPresetMode,
	layoutModeLeftCollapsed,
	layoutModeRightCollapsed,
} from "@/lib/shell/layout-presets";

export type RightSidebarTab = "agent" | "annotations";
/** Views that may live in a singleton native feature window (right-rail popouts). */
export type FeatureViewType = RightSidebarTab;
/** Layout presets plus the free-form arrangement after any manual change. */
export type LayoutMode = LayoutPresetMode | "custom";

/** A title-search result set awaiting the user's pick, plus its destination. */
export type PaperSearchDraftGroup = PaperSearchGroup & {
	parentDir: string;
	/** Host search still in flight — dialog shows shimmer skeletons. */
	pending?: boolean;
};

type UiStore = {
	sidebarCollapsed: boolean;
	/** Last layout preset selected from the title-bar menu. */
	layoutMode: LayoutMode;
	/**
	 * Preset whose width slot a manual drag commits into. Sticky: dragging
	 * inside a preset still updates that preset's remembered widths even
	 * though `layoutMode` itself flips to "custom".
	 */
	lastAppliedPreset: LayoutPresetMode | null;
	/** Right sidebar (⌘L): Agent (default) or Annotations. */
	rightSidebarOpen: boolean;
	rightSidebarTab: RightSidebarTab;
	/** Keep AgentPanel mounted when switching right-rail tabs. */
	agentPanelMounted: boolean;
	/**
	 * Feature views currently living in a singleton native window.
	 * Main window uses this to focus the popout instead of only expanding the rail.
	 */
	featurePoppedOut: Partial<Record<FeatureViewType, boolean>>;
	/** Increment to open magic-wand popover (⇧⌘I). */
	lookupOpenSignal: number;
	/** Zotero one-click migration dialog. */
	zoteroOpen: boolean;
	/** Zotero bidirectional sync dialog. */
	zoteroSyncOpen: boolean;
	commandOpen: boolean;
	commandMode: PaletteMode;
	settingsOpen: boolean;
	/**
	 * Vault-relative path of the retained Library preview (null = none).
	 * The left Paper Info panel previews this paper so users can inspect it
	 * without opening the row. Cleared when its Library context changes.
	 */
	hoveredPaperPath: string | null;
	skillImportDraft: SkillDiscovery[] | null;
	/** Title-search candidates queued for the picker; the head is shown first. */
	paperSearchDraft: PaperSearchDraftGroup[] | null;
};

export const uiStore = createStore<UiStore>(() => ({
	sidebarCollapsed: false,
	layoutMode: "custom",
	lastAppliedPreset: null,
	rightSidebarOpen: false,
	rightSidebarTab: "agent",
	agentPanelMounted: false,
	featurePoppedOut: {},
	lookupOpenSignal: 0,
	zoteroOpen: false,
	zoteroSyncOpen: false,
	commandOpen: false,
	commandMode: "go",
	settingsOpen: false,
	hoveredPaperPath: null,
	skillImportDraft: null,
	paperSearchDraft: null,
}));

export function setSidebarCollapsedState(collapsed: boolean): void {
	const prev = uiStore.getState().sidebarCollapsed;
	uiStore.setState({ sidebarCollapsed: collapsed });
	// The free-form arrangement is part of the persisted custom layout.
	if (prev !== collapsed && uiStore.getState().layoutMode === "custom") {
		saveCustomRails({
			leftCollapsed: collapsed,
			rightOpen: uiStore.getState().rightSidebarOpen,
		});
	}
}

export function setLayoutMode(layoutMode: LayoutMode): void {
	// Called from every resize commit; only persist real transitions.
	if (uiStore.getState().layoutMode === layoutMode) return;
	uiStore.setState({ layoutMode });
	saveLastMode(layoutMode);
	if (layoutMode === "custom") {
		const state = uiStore.getState();
		if (state.lastAppliedPreset) saveLastPreset(state.lastAppliedPreset);
		saveCustomRails({
			leftCollapsed: state.sidebarCollapsed,
			rightOpen: state.rightSidebarOpen,
		});
	}
}

export function setLastAppliedPreset(mode: LayoutPresetMode): void {
	uiStore.setState({ lastAppliedPreset: mode });
	saveLastPreset(mode);
}

export function setRightSidebarOpenState(open: boolean): void {
	const prev = uiStore.getState().rightSidebarOpen;
	uiStore.setState({ rightSidebarOpen: open });
	if (prev !== open && uiStore.getState().layoutMode === "custom") {
		saveCustomRails({
			leftCollapsed: uiStore.getState().sidebarCollapsed,
			rightOpen: open,
		});
	}
}

/**
 * Boot seed (desktop main window only, before first paint): restore the
 * persisted layout mode and rail flags so panels mount at the remembered
 * arrangement. Rail widths are seeded separately in `useShellLayout` from the
 * same prefs. Uses raw setState — going through `setLayoutMode` would write
 * the just-loaded value straight back to storage.
 */
export function initShellLayoutFromPrefs(): void {
	const prefs = getShellLayoutPrefs();
	if (prefs.lastMode !== "custom") {
		const mode = prefs.lastMode;
		// Reading is a transient maximize over the previous preset; it has no
		// width slot of its own (#764).
		const previousPreset =
			prefs.lastPreset && prefs.lastPreset !== "reading"
				? prefs.lastPreset
				: null;
		uiStore.setState({
			layoutMode: mode,
			lastAppliedPreset: mode === "reading" ? previousPreset : mode,
			sidebarCollapsed: layoutModeLeftCollapsed(mode),
			rightSidebarOpen: !layoutModeRightCollapsed(mode),
		});
		return;
	}
	uiStore.setState({
		layoutMode: "custom",
		lastAppliedPreset: prefs.lastPreset ?? null,
		sidebarCollapsed: prefs.customRails?.leftCollapsed ?? false,
		rightSidebarOpen: prefs.customRails?.rightOpen ?? false,
	});
}

export function setRightSidebarTab(tab: RightSidebarTab): void {
	uiStore.setState({ rightSidebarTab: tab });
}

export function setAgentPanelMounted(mounted: boolean): void {
	uiStore.setState({ agentPanelMounted: mounted });
}

export function bumpLookupOpenSignal(): void {
	uiStore.setState((s) => ({ lookupOpenSignal: s.lookupOpenSignal + 1 }));
}

export function setZoteroOpen(open: boolean): void {
	uiStore.setState({ zoteroOpen: open });
}

export function setZoteroSyncOpen(open: boolean): void {
	uiStore.setState({ zoteroSyncOpen: open });
}

export function setCommandOpen(open: boolean): void {
	uiStore.setState({ commandOpen: open });
}

export function openPalette(mode: PaletteMode): void {
	const { commandOpen, commandMode } = uiStore.getState();
	if (commandOpen && commandMode === mode) {
		uiStore.setState({ commandOpen: false });
		return;
	}
	uiStore.setState({ commandMode: mode, commandOpen: true });
}

export function setSettingsOpenState(open: boolean): void {
	uiStore.setState({ settingsOpen: open });
}

/** Retain the last intentionally hovered Library row for Paper Info. */
export function setHoveredPaperPath(path: string | null): void {
	if (uiStore.getState().hoveredPaperPath === path) return;
	uiStore.setState({ hoveredPaperPath: path });
}

export function setSkillImportDraft(draft: SkillDiscovery[] | null): void {
	uiStore.setState({ skillImportDraft: draft });
}

export function addPaperSearchDraft(groups: PaperSearchDraftGroup[]): void {
	if (groups.length === 0) return;
	uiStore.setState((s) => ({
		paperSearchDraft: [...(s.paperSearchDraft ?? []), ...groups],
	}));
}

/**
 * Replace a pending title-search placeholder with real candidates, or drop it
 * when the Host path did not yield a picker (identifier hit / no results /
 * error). No-op if the user already cancelled (pending row gone).
 */
export function settlePaperSearchDraft(
	query: string,
	group: PaperSearchDraftGroup | null,
): void {
	uiStore.setState((s) => {
		const list = [...(s.paperSearchDraft ?? [])];
		const idx = list.findIndex((g) => g.pending && g.query === query);
		if (idx < 0) return s;
		if (group && group.candidates.length > 0) {
			list[idx] = { ...group, pending: false };
		} else {
			list.splice(idx, 1);
		}
		return { paperSearchDraft: list.length > 0 ? list : null };
	});
}

/** Drop the group the user just resolved; null once the queue drains. */
export function shiftPaperSearchDraft(): void {
	uiStore.setState((s) => {
		const rest = (s.paperSearchDraft ?? []).slice(1);
		return { paperSearchDraft: rest.length > 0 ? rest : null };
	});
}

export function clearPaperSearchDraft(): void {
	uiStore.setState({ paperSearchDraft: null });
}

/**
 * Imperative layout controller registered by the App shell (panel refs and
 * panel resize lives in the React layer; plain actions call through here).
 */
export type LayoutController = {
	setLeftCollapsed: (collapsed: boolean) => void;
	setRightCollapsed: (
		collapsed: boolean,
		opts?: { focusAgent?: boolean },
	) => void;
	applyLayoutMode: (mode: Exclude<LayoutMode, "custom">) => void;
	/** Expand the left rail and move focus into it. */
	focusSidebar: () => void;
	focusEditorPane: () => void;
	focusNotesEditor: () => void;
};

let layoutController: LayoutController | null = null;

export function registerLayoutController(next: LayoutController | null): void {
	layoutController = next;
}

export function layout(): LayoutController | null {
	return layoutController;
}

export function toggleSidebar(): void {
	const { sidebarCollapsed, layoutMode } = uiStore.getState();
	// React state is source of truth — isCollapsed() can lag at 0px.
	if (layoutMode !== "reading") {
		setLayoutMode("custom");
	}
	layout()?.setLeftCollapsed(!sidebarCollapsed);
}

/**
 * Expand the right rail on `tab` (main window only). Callers must have already
 * ruled out an open singleton feature window for this tab.
 */
export function openRightTabInRail(tab: RightSidebarTab): void {
	setRightSidebarTab(tab);
	if (tab === "agent") setAgentPanelMounted(true);
	if (!uiStore.getState().rightSidebarOpen) {
		layout()?.setRightCollapsed(false, { focusAgent: tab === "agent" });
	}
}

export function setFeaturePoppedOut(
	view: FeatureViewType,
	poppedOut: boolean,
): void {
	uiStore.setState((s) => ({
		featurePoppedOut: {
			...s.featurePoppedOut,
			[view]: poppedOut,
		},
	}));
}

/**
 * Close dialogs and drop one-shot requests that reference the vault being
 * closed. Deliberately narrow: user chrome (rail state), live window truth
 * (`agentPanelMounted`, `featurePoppedOut`, `settingsOpen`) and the monotonic
 * `lookupOpenSignal` all outlive a vault switch.
 */
export function clearUiVaultState(): void {
	uiStore.setState({
		skillImportDraft: null,
		paperSearchDraft: null,
		hoveredPaperPath: null,
		zoteroOpen: false,
		zoteroSyncOpen: false,
		commandOpen: false,
	});
}
