/**
 * Escape cannot cross a cross-origin frame, so the web-view adapter relays an
 * in-frame Escape as this window event. Only the shared selection host listens,
 * which keeps the key from closing unrelated app chrome that owns its own
 * focus.
 */
export const SELECTION_DISMISS_EVENT = "agentero:selection-dismiss";

/** Ask the shared selection host to close its floating menu / cards. */
export function relaySelectionDismiss(): void {
	window.dispatchEvent(new CustomEvent(SELECTION_DISMISS_EVENT));
}
