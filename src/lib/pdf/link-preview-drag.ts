/**
 * Suppress citation / crossref / URL previews for the whole text-selection
 * gesture. English drags already do this via EmbedPDF `isSelecting`. A
 * translation drag is a DOM selection, so that flag never flips, and
 * `pointerenter.buttons` is often 0 while WebView is extending the range.
 * The card then covers the pointer and the selection snaps to the wrong span.
 */

type DragListener = () => void;

let pointerHeld = false;
let holds = 0;
let listening = false;
const listeners = new Set<DragListener>();

export function linkPreviewDragActive(): boolean {
	return pointerHeld || holds > 0;
}

/** Primary button is down, or a preview is suppressed for either reason. */
export function linkHoverSuppressed(buttons: number): boolean {
	return (buttons & 1) === 1 || linkPreviewDragActive();
}

function emit(): void {
	for (const listener of listeners) listener();
}

function detachIfIdle(): void {
	if (pointerHeld || holds > 0 || !listening || typeof window === "undefined") {
		return;
	}
	listening = false;
	window.removeEventListener("pointerup", onWindowPointerUp, true);
	window.removeEventListener("pointercancel", onWindowPointerUp, true);
}

function onWindowPointerUp(): void {
	pointerHeld = false;
	detachIfIdle();
}

function ensureListener(): void {
	if (listening || typeof window === "undefined") return;
	listening = true;
	window.addEventListener("pointerup", onWindowPointerUp, true);
	window.addEventListener("pointercancel", onWindowPointerUp, true);
}

/**
 * Call from the translated text's pointerdown (capture). Cleared on pointerup
 * unless {@link holdLinkPreviewDrag} is still held for the selection menu.
 */
export function beginLinkPreviewDrag(): void {
	if (pointerHeld) return;
	const wasActive = linkPreviewDragActive();
	pointerHeld = true;
	ensureListener();
	if (!wasActive) emit();
}

/**
 * Keep previews down after pointerup until the translation selection menu is
 * in place. Release is idempotent.
 */
export function holdLinkPreviewDrag(): () => void {
	const wasActive = linkPreviewDragActive();
	holds += 1;
	if (!wasActive) emit();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		holds = Math.max(0, holds - 1);
		detachIfIdle();
	};
}

/** Fired once when a drag starts, so an already-open preview can close. */
export function subscribeLinkPreviewDrag(listener: DragListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function resetLinkPreviewDragForTests(): void {
	pointerHeld = false;
	holds = 0;
	listeners.clear();
	detachIfIdle();
}
