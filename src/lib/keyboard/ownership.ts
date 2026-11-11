import { isAnyModalOverlayOpen } from "@/lib/core/overlay-stack";

export function isKeyboardInput(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		Boolean(
			target.closest(
				"input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], .cm-editor, [data-shortcut-recording]",
			),
		)
	);
}

export function topKeyboardModal(doc: Document): HTMLElement | null {
	return (
		Array.from(
			doc.querySelectorAll<HTMLElement>(
				"[role='dialog'], [role='alertdialog'], dialog[open]",
			),
		)
			.filter(
				(el) =>
					el.isConnected &&
					!el.closest("[hidden], [inert], [aria-hidden='true']") &&
					el.getClientRects().length > 0,
			)
			.at(-1) ?? null
	);
}

/** Registered sheets without a DOM dialog still block background surfaces. */
export function keyboardModalOpen(doc: Document): boolean {
	return isAnyModalOverlayOpen() || topKeyboardModal(doc) !== null;
}
