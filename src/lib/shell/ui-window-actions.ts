/**
 * Right-rail / feature-window opening actions split from `ui-store`.
 *
 * The store must not import `feature-window` (which reads the store back),
 * so these actions live here: ui-window-actions → feature-window → ui-store.
 */

import {
	DEFAULT_SIDEBAR_AGENT,
	openOrActivateSidebarTarget,
	toggleSidebarTabs,
} from "@/lib/shell/sidebar-tabs";
import {
	openRightTabInRail,
	type RightSidebarTab,
	setLayoutMode,
	uiStore,
} from "@/lib/shell/ui-store";

/**
 * Bumped on every rail open/close so a slow feature-window probe cannot
 * collapse or reopen a rail the user has already toggled again.
 */
let railOpenGeneration = 0;

/**
 * Expand the rail now. A known singleton window is focused instead, with no
 * flash. An unknown window is probed in parallel; if one exists, the rail
 * yields back to it.
 */
function revealRightRail(tab: RightSidebarTab, wasOpen: boolean): void {
	const generation = ++railOpenGeneration;
	if (uiStore.getState().featurePoppedOut[tab]) {
		void import("@/lib/shell/feature-window").then(
			async ({ preferFeatureWindow }) => {
				if (generation !== railOpenGeneration) return;
				await preferFeatureWindow(tab);
			},
		);
		return;
	}
	if (!wasOpen || uiStore.getState().rightSidebarTab !== tab) {
		openRightTabInRail(tab);
	}
	if (tab === "agent") openOrActivateSidebarTarget(DEFAULT_SIDEBAR_AGENT);
	void import("@/lib/shell/feature-window").then(
		async ({ preferFeatureWindow }) => {
			if (generation !== railOpenGeneration) return;
			if (!(await preferFeatureWindow(tab))) return;
			if (generation !== railOpenGeneration) return;
			// This view lives in its own window. Close a rail we opened only
			// for it. A rail that was already open keeps its width; the probe
			// moves the selected tab off this view.
			if (!wasOpen && uiStore.getState().rightSidebarOpen) toggleSidebarTabs();
		},
	);
}

/** ⌘L — toggle right sidebar (defaults to agent). */
export function toggleChat(): void {
	railOpenGeneration += 1;
	toggleSidebarTabs();
}

/**
 * Open a feature view. If its singleton native window is open, focus that
 * window and do not host a second copy in the main right rail (same policy for
 * Agent and Annotations).
 */
export function openRightTab(tab: RightSidebarTab): void {
	setLayoutMode("custom");
	revealRightRail(tab, uiStore.getState().rightSidebarOpen);
}
