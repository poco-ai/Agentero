import {
	activeSidebarViewId,
	closeSidebarTab,
	cycleSidebarTab,
	onlySidebarViewId,
	openOrActivateSidebarTarget,
} from "@/lib/shell/sidebar-tabs";
import { uiStore } from "@/lib/shell/ui-store";
import { currentSidebarPaperNotes } from "@/lib/workspace/sidebar-files";

const WORKSPACE_VIEW = "[data-workspace-view]";
let lastWorkspaceViewId: string | undefined;
let rightSidebarFocused: boolean | undefined;

export function trackSidebarTabInteraction() {
	const remember = (event: Event) => {
		if (!(event.target instanceof Element)) return;
		rightSidebarFocused = Boolean(event.target.closest("[data-right-sidebar]"));
		const workspaceView = event.target.closest<HTMLElement>(WORKSPACE_VIEW);
		if (workspaceView)
			lastWorkspaceViewId = workspaceView.dataset.workspaceView;
	};
	document.addEventListener("pointerdown", remember, true);
	document.addEventListener("focusin", remember, true);
	return () => {
		document.removeEventListener("pointerdown", remember, true);
		document.removeEventListener("focusin", remember, true);
		lastWorkspaceViewId = undefined;
		rightSidebarFocused = undefined;
	};
}

export function sidebarLauncherNotesPath() {
	if (uiStore.getState().agentWindowOpen) return;
	const focused = document.activeElement?.closest<HTMLElement>(WORKSPACE_VIEW);
	return currentSidebarPaperNotes(
		lastWorkspaceViewId ?? focused?.dataset.workspaceView,
	);
}

export function newSidebarTab(): void {
	if (uiStore.getState().immersiveReading) return;
	void openOrActivateSidebarTarget({
		kind: "launcher",
		notesPath: sidebarLauncherNotesPath() ?? null,
		focusSearch: true,
	});
}

function isRightSidebarFocused(): boolean {
	const active = document.activeElement;
	const sidebar = active?.closest("[data-right-sidebar]");
	return (
		uiStore.getState().rightSidebarOpen &&
		Boolean(
			active instanceof HTMLIFrameElement
				? sidebar
				: (rightSidebarFocused ?? sidebar),
		)
	);
}

export function cycleFocusedSidebarTab(delta: -1 | 1): boolean {
	if (!isRightSidebarFocused()) return false;
	rightSidebarFocused = true;
	cycleSidebarTab(delta);
	return true;
}

export function closeFocusedSidebarTab(): boolean {
	if (!uiStore.getState().rightSidebarOpen) return false;
	const viewId =
		onlySidebarViewId() ??
		(isRightSidebarFocused() ? activeSidebarViewId() : undefined);
	if (!viewId) return false;
	void closeSidebarTab(viewId);
	return true;
}
