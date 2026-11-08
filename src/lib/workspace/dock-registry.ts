/**
 * Imperative dockview handle registry. The DockWorkspace component registers
 * its handle here so plain action modules (openTab/closeTab/…) can place and
 * activate panels without threading a React ref through every call site.
 * Defines the shared contract aliased by `DockWorkspaceHandle` (lib must not
 * import components — see .dependency-cruiser.cjs).
 */

import type {
	DocTab,
	OpenPlacement,
	ReadingColumns,
} from "@/lib/workspace/tabs";

export type DockHandle = {
	/** Add (or activate) a panel with optional split placement. */
	openPanel: (tab: DocTab, placement?: OpenPlacement) => void;
	/** Add a panel as a right split and rebalance visible grid columns. */
	splitPanelRight: (tab: DocTab, referencePanelId: string | null) => void;
	/** Replace a panel id after a filesystem move while preserving its group. */
	remapPanel: (previousPanelId: string, tab: DocTab) => void;
	/** Cycle active panel by dockview `api.panels` order (wraps). */
	cycleActive: (delta: number) => void;
	/** Active panel id of every visible dock group (one per column). */
	visiblePanelIds: () => string[];
	/**
	 * Activate an existing panel by id. When `skipSetGroupActive` is true, sets
	 * the active panel within its group without activating the group itself.
	 */
	activatePanel: (
		panelId: string,
		options?: { skipSetGroupActive?: boolean },
	) => void;
	/**
	 * True when `activatePanel` can actually bring the panel to a visible
	 * group (i.e. the panel is registered in this dock, not in a split
	 * pane / popout window this handle cannot see).
	 */
	canActivatePanel: (panelId: string) => boolean;
	/** Maximize the active group (other splits hidden, layout preserved). */
	maximizeActivePanel: () => boolean;
	/** Restore the grid behind any maximized group. */
	exitMaximizedPanel: () => void;
	/** True while a dock group is maximized. */
	isMaximizedPanel: () => boolean;
	/** Remember / restore the shared two-column PDF / Notes proportion. */
	rememberNotesSplitWidth: (paperId: string, notesId: string) => void;
	restoreNotesSplitWidth: (paperId: string, notesId: string) => void;
	/**
	 * Anchors of the standard two-column reading layout, or null when the dock
	 * is not exactly two side-by-side columns.
	 */
	readingColumns: () => ReadingColumns | null;
};

let handle: DockHandle | null = null;

export function registerDockHandle(next: DockHandle | null): void {
	handle = next;
}

export function dockHandle(): DockHandle | null {
	return handle;
}
