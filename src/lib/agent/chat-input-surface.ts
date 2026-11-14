/**
 * Which chat surface owns app-wide inputs (file-tree "Add to chat", pinned
 * selections, external composer seeds)?
 *
 * - The Agent rail wins whenever it is actually visible with its agent tab.
 * - Otherwise an open Zen workspace owns them, so the active slot receives the
 *   chip even while a paper pane has selection focus in a split.
 */

import { isZenVirtualPath } from "@/lib/agent/zen-path";
import { uiStore } from "@/lib/shell/ui-store";
import { workspaceStore } from "@/lib/workspace/store";

type TabsLike = readonly { path: string }[];
type RailsLike = {
	rightSidebarOpen: boolean;
	rightSidebarTab: string;
	featurePoppedOut: Partial<Record<string, boolean>>;
};

/** A Zen tab exists in this window's center dock. */
export function zenTabIsOpen(tabs: TabsLike): boolean {
	return tabs.some((tab) => isZenVirtualPath(tab.path));
}

/** The right rail is the visible Agent surface (not popped into its window). */
export function railIsAgentSurface(ui: RailsLike): boolean {
	return (
		ui.rightSidebarOpen &&
		ui.rightSidebarTab === "agent" &&
		!ui.featurePoppedOut.agent
	);
}

/** Whether an open Zen workspace should receive app-wide chat inputs. */
export function zenOwnsChatInput(): boolean {
	const { tabs } = workspaceStore.getState();
	if (!zenTabIsOpen(tabs)) return false;
	return !railIsAgentSurface(uiStore.getState());
}
