/**
 * Whole-window Agent workspace.
 *
 * Opening swaps the main shell into Agent mode: the left rail lists ACP
 * history, the center dock owns one tab per conversation, and the document
 * workspace stays mounted but hidden. Both modes share the right rail.
 */

import { seedAgentWindowFromRail } from "@/lib/agent/zen-store";
import { layout, setAgentWindowOpen, uiStore } from "@/lib/shell/ui-store";
import { getVaultPath } from "@/lib/vault/store";

let sidebarWasCollapsed = false;

export function openAgentWindow(): void {
	const vaultPath = getVaultPath();
	if (!vaultPath || uiStore.getState().agentWindowOpen) return;
	const ui = uiStore.getState();
	sidebarWasCollapsed = ui.sidebarCollapsed;
	seedAgentWindowFromRail(vaultPath);
	setAgentWindowOpen(true);
	if (sidebarWasCollapsed) layout()?.setLeftCollapsed(false);
}

export function closeAgentWindow(): void {
	if (!uiStore.getState().agentWindowOpen) return;
	setAgentWindowOpen(false);
	if (sidebarWasCollapsed) layout()?.setLeftCollapsed(true);
	sidebarWasCollapsed = false;
}

export function toggleAgentWindow(): void {
	if (uiStore.getState().agentWindowOpen) closeAgentWindow();
	else openAgentWindow();
}
