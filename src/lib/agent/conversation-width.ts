/**
 * Width of the centered conversation column in the Agent workspace.
 *
 * The column contains both the transcript and the composer; the dock tab strip
 * stays full-width. Kept in one module store so every session tab follows the
 * same width and the value survives a mode round-trip.
 */

import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

const STORAGE_KEY = "agentero-agent-conversation-width";
export const MIN_CONVERSATION_WIDTH = 560;
export const MAX_CONVERSATION_WIDTH = 1600;
export const DEFAULT_CONVERSATION_WIDTH = 896;

/** Horizontal breathing room kept between the column and the panel edges. */
export const CONVERSATION_EDGE_MARGIN_PX = 32;

function clampWidth(px: number): number {
	return Math.min(
		MAX_CONVERSATION_WIDTH,
		Math.max(MIN_CONVERSATION_WIDTH, Math.round(px)),
	);
}

/** Positive available width for a column inside `containerWidth`. */
export function maxConversationWidthFor(containerWidth: number): number {
	return Math.max(
		MIN_CONVERSATION_WIDTH,
		containerWidth - CONVERSATION_EDGE_MARGIN_PX * 2,
	);
}

function readStoredWidth(): number {
	if (typeof window === "undefined") return DEFAULT_CONVERSATION_WIDTH;
	try {
		const raw = Number(window.localStorage.getItem(STORAGE_KEY));
		return Number.isFinite(raw) && raw > 0
			? clampWidth(raw)
			: DEFAULT_CONVERSATION_WIDTH;
	} catch {
		return DEFAULT_CONVERSATION_WIDTH;
	}
}

export const conversationWidthStore = createStore<{ width: number }>(() => ({
	width: readStoredWidth(),
}));

let saveTimer: number | undefined;

/** Persist on a trailing edge so pointer-move resizes do not hit localStorage. */
function scheduleSave(width: number): void {
	if (typeof window === "undefined") return;
	if (saveTimer != null) window.clearTimeout(saveTimer);
	saveTimer = window.setTimeout(() => {
		saveTimer = undefined;
		try {
			window.localStorage.setItem(STORAGE_KEY, String(width));
		} catch {
			// Private mode / quota: the in-memory width still works for this run.
		}
	}, 150);
}

export function setConversationWidth(px: number): void {
	const width = clampWidth(px);
	if (conversationWidthStore.getState().width === width) return;
	conversationWidthStore.setState({ width });
	scheduleSave(width);
}

export function resetConversationWidth(): void {
	setConversationWidth(DEFAULT_CONVERSATION_WIDTH);
}

export function useConversationWidth(): number {
	return useStore(conversationWidthStore, (state) => state.width);
}
