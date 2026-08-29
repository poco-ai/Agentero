/**
 * App shell UI state (zustand vanilla): side rails, palette and
 * dialog visibility, and one-shot open signals. Signal bumps only re-render
 * their subscribers instead of the whole App.
 */

import { createStore } from "zustand/vanilla";
import type { PaperSearchGroup, SkillDiscovery } from "@/lib/paper/lookup";
import type { PaletteMode } from "@/lib/shell/commands/types";

export type RightSidebarTab = "agent" | "annotations";

/** Crop + multi-turn payload when opening a visual-trace pin in Agent. */
export type AgentSessionOpenVisualTrace = {
	/** Stable mark id (product session key). */
	traceId: string;
	page: number;
	comment: string;
	paperPath?: string;
	image?: { data: string; mimeType: string };
	messages: Array<{
		id: string;
		role: "user" | "assistant";
		content: string;
		createdAt: string;
		agentSessionId?: string;
	}>;
	status?: "running" | "completed" | "failed";
};

/** One-shot request to open a specific Agent session from PDF pins. */
export type AgentSessionOpenRequest = {
	/** Monotonic id so identical payloads still re-trigger. */
	nonce: number;
	agentId: string;
	/** Agentero runtime/event session id from runOnce. */
	runtimeSessionId: string;
	/** ACP provider session id when available. */
	providerSessionId?: string;
	messageId?: string;
	title?: string;
	/** Original user prompt / display text. */
	prompt?: string;
	/** Local answer fallback when provider history cannot be loaded. */
	answerSnapshot?: string;
	/**
	 * Full visual-trace transcript for Open in Agent.
	 * Prefer this over prompt+answerSnapshot alone (multi-turn + image chip).
	 */
	visualTrace?: AgentSessionOpenVisualTrace;
	/** Absolute paper path for mark finalizers on follow-up turns. */
	paperAbsPath?: string;
};

/** A title-search result set awaiting the user's pick, plus its destination. */
export type PaperSearchDraftGroup = PaperSearchGroup & { parentDir: string };

type UiStore = {
	sidebarCollapsed: boolean;
	/** Right sidebar (⌘L): Agent (default) or Annotations. */
	rightSidebarOpen: boolean;
	rightSidebarTab: RightSidebarTab;
	/** Keep AgentPanel mounted when switching right-rail tabs. */
	agentPanelMounted: boolean;
	/**
	 * Feature views currently living in a singleton native window.
	 * Main window uses this to focus the popout instead of only expanding the rail.
	 */
	featurePoppedOut: Partial<Record<RightSidebarTab, boolean>>;
	/** Increment to open magic-wand popover (⇧⌘I). */
	lookupOpenSignal: number;
	/** Zotero one-click migration dialog. */
	zoteroOpen: boolean;
	/** Zotero bidirectional sync dialog. */
	zoteroSyncOpen: boolean;
	commandOpen: boolean;
	commandMode: PaletteMode;
	settingsOpen: boolean;
	skillImportDraft: SkillDiscovery[] | null;
	/** Title-search candidates queued for the picker; the head is shown first. */
	paperSearchDraft: PaperSearchDraftGroup[] | null;
	/** PDF visual-trace → Agent session open (consumed once). */
	agentSessionOpenRequest: AgentSessionOpenRequest | null;
};

export const uiStore = createStore<UiStore>(() => ({
	sidebarCollapsed: false,
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
	skillImportDraft: null,
	paperSearchDraft: null,
	agentSessionOpenRequest: null,
}));

export function setSidebarCollapsedState(collapsed: boolean): void {
	uiStore.setState({ sidebarCollapsed: collapsed });
}

export function setRightSidebarOpenState(open: boolean): void {
	uiStore.setState({ rightSidebarOpen: open });
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

export function setCommandMode(mode: PaletteMode): void {
	uiStore.setState({ commandMode: mode });
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

export function setSkillImportDraft(draft: SkillDiscovery[] | null): void {
	uiStore.setState({ skillImportDraft: draft });
}

export function addPaperSearchDraft(groups: PaperSearchDraftGroup[]): void {
	if (groups.length === 0) return;
	uiStore.setState((s) => ({
		paperSearchDraft: [...(s.paperSearchDraft ?? []), ...groups],
	}));
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
	const { sidebarCollapsed } = uiStore.getState();
	// React state is source of truth — isCollapsed() can lag at 0px.
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
	tab: RightSidebarTab,
	poppedOut: boolean,
): void {
	uiStore.setState((s) => ({
		featurePoppedOut: {
			...s.featurePoppedOut,
			[tab]: poppedOut,
		},
	}));
}

export function clearAgentSessionOpenRequest(): void {
	if (!uiStore.getState().agentSessionOpenRequest) return;
	uiStore.setState({ agentSessionOpenRequest: null });
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
		zoteroOpen: false,
		zoteroSyncOpen: false,
		commandOpen: false,
		agentSessionOpenRequest: null,
	});
}
