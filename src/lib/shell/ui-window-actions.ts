import {
	DEFAULT_SIDEBAR_AGENT,
	openOrActivateSidebarTarget,
	toggleSidebarTabs,
} from "@/lib/shell/sidebar-tabs";
import { type FeatureViewType, uiStore } from "@/lib/shell/ui-store";

export const toggleChat = toggleSidebarTabs;

/**
 * Open a feature view. If its singleton native window is open, focus that
 * window and do not host a second copy in the main right rail (same policy for
 * Agent and Annotations).
 */
export async function openRightTab(tab: FeatureViewType): Promise<void> {
	if (uiStore.getState().featurePoppedOut[tab] || tab !== "agent") {
		const { focusFeatureWindow } = await import("@/lib/shell/feature-window");
		if (
			(await focusFeatureWindow(tab)) ||
			uiStore.getState().featurePoppedOut[tab]
		)
			return;
	}
	if (tab === "agent") await openOrActivateSidebarTarget(DEFAULT_SIDEBAR_AGENT);
}
