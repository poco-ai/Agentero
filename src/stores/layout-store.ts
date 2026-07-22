/**
 * Workspace layout / chrome state: left sidebar, right sidebar (tab + open),
 * zen modes, the persistent AgentPanel mount flag, and the Notes column toggle.
 * Backed by a Zustand store with useState-compatible setters. Panel imperative
 * handles stay as refs in the component tree.
 */

import { createAppStore } from "@/stores/create";

export type RightSidebarTab = "agent" | "backlinks" | "annotations";

export type LayoutState = {
	sidebarCollapsed: boolean;
	/** Side Notes column while viewing a paper PDF/HTML. */
	showNotes: boolean;
	rightSidebarOpen: boolean;
	rightSidebarTab: RightSidebarTab;
	/** Agent zen / quest mode: hide vault chrome, full-width Agent chat. */
	agentZenMode: boolean;
	/** Immersive full-window PDF reading. */
	pdfZenMode: boolean;
	/** Keep AgentPanel mounted across sidebar ↔ zen so chat history is not lost. */
	agentPanelMounted: boolean;
};

export const layoutStore = createAppStore<LayoutState>(() => ({
	sidebarCollapsed: false,
	showNotes: true,
	rightSidebarOpen: false,
	rightSidebarTab: "agent",
	agentZenMode: false,
	pdfZenMode: false,
	agentPanelMounted: false,
}));

type Updater<T> = T | ((prev: T) => T);

function apply<K extends keyof LayoutState>(
	key: K,
	next: Updater<LayoutState[K]>,
): void {
	layoutStore.store.setState((s) => {
		const value =
			typeof next === "function"
				? (next as (prev: LayoutState[K]) => LayoutState[K])(s[key])
				: next;
		return { [key]: value } as Pick<LayoutState, K>;
	});
}

export function setSidebarCollapsed(next: Updater<boolean>): void {
	apply("sidebarCollapsed", next);
}

export function setShowNotes(next: Updater<boolean>): void {
	apply("showNotes", next);
}

export function setRightSidebarOpen(next: Updater<boolean>): void {
	apply("rightSidebarOpen", next);
}

export function setRightSidebarTab(next: Updater<RightSidebarTab>): void {
	apply("rightSidebarTab", next);
}

export function setAgentZenMode(next: Updater<boolean>): void {
	apply("agentZenMode", next);
}

export function setPdfZenMode(next: Updater<boolean>): void {
	apply("pdfZenMode", next);
}

export function setAgentPanelMounted(next: Updater<boolean>): void {
	apply("agentPanelMounted", next);
}

/** Read the live snapshot from async callbacks (replaces the showNotes ref). */
export function getLayoutState(): LayoutState {
	return layoutStore.store.getState();
}

/** Subscribe a component to the whole layout slice. */
export function useLayoutState(): LayoutState {
	return layoutStore.use((s) => s);
}
