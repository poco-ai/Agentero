import { useEffect, useSyncExternalStore } from "react";

/**
 * Tracks the floating text-selection overlays (the selection toolbar and the
 * ask / quick-chat card). They are viewport-fixed and, for a selection near the
 * top of a panel, sit right against the dockview tab strip. Without a guard a
 * stray drag that starts on the tab behind them splits the layout (#608), so
 * the workspace suspends dockview drag-and-drop while any overlay is open.
 *
 * The overlay components call {@link useSelectionOverlayGuard}; the workspace
 * reads {@link useSelectionOverlayActive}.
 */

type Listener = () => void;

let activeCount = 0;
const listeners = new Set<Listener>();

function emit(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Mark a floating selection overlay open. Repeated overlays ref-count, so the
 * store only reports a transition when the first opens or the last closes.
 * Returns a release function that is safe to call more than once.
 */
export function acquireSelectionOverlay(): () => void {
	activeCount += 1;
	if (activeCount === 1) emit();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeCount -= 1;
		if (activeCount === 0) emit();
	};
}

/** True while any floating selection overlay is open. */
export function isSelectionOverlayActive(): boolean {
	return activeCount > 0;
}

/** Keep a floating selection overlay registered for the component's lifetime. */
export function useSelectionOverlayGuard(): void {
	useEffect(() => acquireSelectionOverlay(), []);
}

/** Reactive {@link isSelectionOverlayActive} for the workspace. */
export function useSelectionOverlayActive(): boolean {
	return useSyncExternalStore(
		subscribe,
		isSelectionOverlayActive,
		isSelectionOverlayActive,
	);
}
