/** DOM / error predicates the PDF viewer needs outside React state. */

/**
 * PDFium rejects work queued against a document that is already closing (tab
 * switch mid-render). Those rejections are expected, not failures to report.
 */
export function isPdfDocumentCloseRaceError(error: unknown): boolean {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: error && typeof error === "object" && "message" in error
					? String((error as { message?: unknown }).message)
					: "";
	return /document does not open/i.test(message);
}

/** True when a copy/paste target is a real editable field, not page text. */
export function isEditableClipboardTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const editable = target.closest(
		"input, textarea, select, [role='textbox'], [contenteditable]",
	);
	return (
		editable instanceof HTMLElement &&
		editable.getAttribute("contenteditable") !== "false"
	);
}

export function nativeSelectionBelongsToHost(
	host: HTMLElement | null,
): boolean {
	if (!host) return false;
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0)
		return false;
	const node = selection.getRangeAt(0).commonAncestorContainer;
	const el =
		node.nodeType === Node.ELEMENT_NODE
			? (node as Element)
			: node.parentElement;
	return Boolean(el && host.contains(el));
}

export function hasNativeSelectionOutsideHost(
	host: HTMLElement | null,
): boolean {
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed || !selection.toString().trim())
		return false;
	return !nativeSelectionBelongsToHost(host);
}
