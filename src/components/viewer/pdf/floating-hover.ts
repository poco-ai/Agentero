/**
 * Shared sticky-hover helpers for PDF floating cards (pin modals and
 * ephemeral citation / crossref previews).
 *
 * Selection / note / preview dialogs are portaled `role="dialog"`. After the
 * pointer leaves a link or pin, the hide timer may fire before (or without) a
 * card pointerenter — keep open while the pointer is still over a dialog or a
 * field inside it is focused.
 */

/** Grace period so the pointer can travel from a link / pin into its card. */
export const EPHEMERAL_PREVIEW_HIDE_MS = 400;

/**
 * Dwell before a link hover card opens. The pointer must rest on a citation /
 * cross-reference / external-URL hit target this long, so sweeping across
 * dense link text on the way somewhere else cannot flash a card (or start the
 * async crop behind it). See `useHoverIntent`.
 */
export const EPHEMERAL_PREVIEW_OPEN_MS = 300;

/** How long a pin-attached card survives after leaving every hover surface. */
export const CARD_HOVER_HIDE_MS = 700;

export function isFloatingDialogActive(): boolean {
	if (typeof document === "undefined") return false;
	const dialogs = document.querySelectorAll('[role="dialog"]');
	for (const node of dialogs) {
		if (!(node instanceof HTMLElement)) continue;
		// Fixed floating selection cards / annotation editors / previews only.
		if (!node.classList.contains("fixed")) continue;
		try {
			if (node.matches(":hover")) return true;
		} catch {
			// :hover may throw in non-browser test envs
		}
		const ae = document.activeElement;
		if (ae instanceof HTMLElement && node.contains(ae)) return true;
	}
	return false;
}
