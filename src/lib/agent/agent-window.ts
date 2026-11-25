/**
 * Whole-window Agent workspace.
 *
 * Opening swaps the main shell into Agent mode: the left rail lists ACP
 * history, the center dock owns one tab per conversation, and the document
 * workspace stays mounted but hidden. Closing restores the rails the user had
 * before entering; the Agent slots themselves stay alive so runs continue.
 */

import { seedAgentWindowFromRail } from "@/lib/agent/zen-store";
import { layout, setAgentWindowOpen, uiStore } from "@/lib/shell/ui-store";
import { getVaultPath } from "@/lib/vault/store";

let rightSidebarWasOpen = false;
let sidebarWasCollapsed = false;

export function openAgentWindow(): void {
	const vaultPath = getVaultPath();
	if (!vaultPath || uiStore.getState().agentWindowOpen) return;
	const ui = uiStore.getState();
	rightSidebarWasOpen = ui.rightSidebarOpen;
	sidebarWasCollapsed = ui.sidebarCollapsed;
	seedAgentWindowFromRail(vaultPath);
	setAgentWindowOpen(true);
	layout()?.setRightCollapsed(true);
	if (sidebarWasCollapsed) layout()?.setLeftCollapsed(false);
}

export function closeAgentWindow(): void {
	if (!uiStore.getState().agentWindowOpen) return;
	setAgentWindowOpen(false);
	if (rightSidebarWasOpen) layout()?.setRightCollapsed(false);
	if (sidebarWasCollapsed) layout()?.setLeftCollapsed(true);
	rightSidebarWasOpen = false;
	sidebarWasCollapsed = false;
}

export function toggleAgentWindow(): void {
	if (uiStore.getState().agentWindowOpen) closeAgentWindow();
	else openAgentWindow();
}
