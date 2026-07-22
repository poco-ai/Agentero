/**
 * App-level modal / sheet stack.
 *
 * Popovers and tooltips stay local; full-screen sheets and Dialogs register
 * here so Esc / ⌘W and toggle shortcuts share one close path. Backed by a
 * Zustand store; React components read it through the hooks in
 * `@/hooks/use-overlay-registration`.
 */

import { createAppStore } from "@/stores/create";

export type OverlayHandle = {
	/** Stable id (e.g. "settings", "shortcuts"). Re-push moves to top. */
	id: string;
	/** Dismiss this overlay (idempotent). */
	close: () => void;
};

type OverlayState = {
	/** Registered overlays, bottom-first; the last entry is the top. */
	stack: OverlayHandle[];
};

export const overlayStore = createAppStore<OverlayState>(() => ({
	stack: [],
}));

export function getOverlayStackSnapshot(): readonly OverlayHandle[] {
	return overlayStore.store.getState().stack;
}

export function isAnyOverlayOpen(): boolean {
	return overlayStore.store.getState().stack.length > 0;
}

/**
 * Register an open overlay at the top of the stack.
 * Call the returned disposer when the overlay closes or the owner unmounts.
 */
export function pushOverlay(handle: OverlayHandle): () => void {
	overlayStore.store.setState((s) => {
		const stack = s.stack.filter((h) => h.id !== handle.id);
		stack.push(handle);
		return { stack };
	});
	return () => {
		overlayStore.store.setState((s) => {
			const i = s.stack.findIndex((h) => h.id === handle.id);
			if (i < 0) return s;
			const stack = s.stack.slice();
			stack.splice(i, 1);
			return { stack };
		});
	};
}

/** Close the topmost overlay. Returns true if something was closed. */
export function closeTopOverlay(): boolean {
	const top = overlayStore.store.getState().stack.at(-1);
	if (!top) return false;
	overlayStore.store.setState((s) => ({ stack: s.stack.slice(0, -1) }));
	// Owner's open→false effect will also dispose; dispose is idempotent.
	top.close();
	return true;
}

/** Close a specific overlay by id if present. */
export function closeOverlayById(id: string): boolean {
	const i = overlayStore.store.getState().stack.findIndex((h) => h.id === id);
	if (i < 0) return false;
	const entry = overlayStore.store.getState().stack[i];
	overlayStore.store.setState((s) => {
		const stack = s.stack.slice();
		stack.splice(i, 1);
		return { stack };
	});
	entry?.close();
	return true;
}
