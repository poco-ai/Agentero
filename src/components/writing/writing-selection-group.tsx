/**
 * Keeps the source editor and compiled-PDF panes of one writing project from
 * showing text selections at the same time. Each pane announces a live
 * selection; the other pane drops its own selection instead of keeping both
 * highlighted.
 */

import { createContext, useContext } from "react";

export type WritingSelectionOrigin = "source" | "pdf";

export type WritingSelectionGroup = {
	announce(origin: WritingSelectionOrigin): void;
	subscribe(listener: (origin: WritingSelectionOrigin) => void): () => void;
};

export function createWritingSelectionGroup(): WritingSelectionGroup {
	const listeners = new Set<(origin: WritingSelectionOrigin) => void>();
	return {
		announce(origin) {
			for (const listener of [...listeners]) listener(origin);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

export const WritingSelectionGroupContext =
	createContext<WritingSelectionGroup | null>(null);

export function useWritingSelectionGroup(): WritingSelectionGroup | null {
	return useContext(WritingSelectionGroupContext);
}
