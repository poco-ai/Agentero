/**
 * Whole-window Agent workspace.
 *
 * Opening swaps the main shell into Agent mode: the left rail lists ACP
 * history, the center dock owns one tab per conversation, and the document
 * workspace stays mounted but hidden. Both modes share the right rail.
 */

import { zenStore } from "@/lib/agent/zen-store";
import { setAgentWindowOpen, uiStore } from "@/lib/shell/ui-store";
import { getVaultPath } from "@/lib/vault/store";

export function openAgentWindow(): void {
	const vaultPath = getVaultPath();
	if (!vaultPath || uiStore.getState().agentWindowOpen) return;
	if (!zenStore.getState().slots.length) zenStore.getState().addSlot();
	setAgentWindowOpen(true);
}

export function closeAgentWindow(): void {
	setAgentWindowOpen(false);
}

export function toggleAgentWindow(): void {
	if (uiStore.getState().agentWindowOpen) closeAgentWindow();
	else openAgentWindow();
}
