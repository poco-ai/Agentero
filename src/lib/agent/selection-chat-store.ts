/** Ephemeral selection menu draft, independent of the surface's live selection. */

import { createStore } from "zustand/vanilla";
import {
	createSelectionContext,
	type SelectionContext,
	type SelectionInput,
} from "@/lib/agent/selection-store";
import { toVaultRelative } from "@/lib/core/path";
import { vaultStore } from "@/lib/vault/store";
import { annotationRanges } from "./selection-annotations";
import type { SelectionSide } from "./selection-side";

/** Viewport anchor plus the box cards must not cover. */
export type SelectionDraftScreen = {
	x: number;
	y: number;
	/** Side of the selection where the gesture ended. */
	side?: SelectionSide;
	/** Viewport x of the gesture endpoint; the menu centers on this point. */
	cursorX?: number;
	selectionBounds?: {
		left: number;
		top: number;
		right: number;
		bottom: number;
	};
};

export type SelectionChatDraft = {
	selection: SelectionContext;
	screen: SelectionDraftScreen;
};
export const selectionChatStore = createStore<{
	draft: SelectionChatDraft | null;
	closedSource: { path: string } | null;
}>(() => ({ draft: null, closedSource: null }));

/** Invalidate transient actions when a mounted reader navigates or closes. */
export function closeSelectionSource(path: string): void {
	path = toVaultRelative(vaultStore.getState().vaultPath, path);
	const current = selectionChatStore.getState().draft;
	if (current?.selection.sourcePath === path) dismissSelectionChat();
	selectionChatStore.setState({ closedSource: { path } });
}

export function openSelectionChat(
	input: SelectionInput,
	screen: SelectionChatDraft["screen"],
): void {
	const selection = createSelectionContext(input);
	if (!selection) return;
	selectionChatStore.setState({
		draft: { selection, screen: { ...screen } },
	});
}

export function dismissSelectionChat(): void {
	selectionChatStore.setState({ draft: null });
}

// Quotes must never cross vault boundaries.
vaultStore.subscribe((state, previous) => {
	if (state.vaultPath !== previous.vaultPath) {
		dismissSelectionChat();
		annotationRanges.clear();
	}
});
