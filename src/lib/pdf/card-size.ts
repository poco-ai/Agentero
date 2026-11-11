/**
 * Remembered width for the PDF floating cards (translation today).
 *
 * The cards resize through CSS `resize: both`, which writes inline
 * width/height on the element. That state dies with the popup, so every new
 * selection reopened at the default width. Only the width is remembered: the
 * translation card is content-sized, and a remembered height would leave a
 * blank strip under shorter translations.
 *
 * The width is a per-machine UI preference, kept in localStorage next to the
 * reading position — never vault data.
 */

import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";

const KEY = "agentero-pdf-card-widths";

/** Anything smaller/larger is a layout accident, not a width the user picked. */
const MIN_WIDTH = 120;
const MAX_WIDTH = 4000;

/** How long after the last resize frame the width is considered settled. */
export const CARD_RESIZE_QUIET_MS = 200;

function clampWidth(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

function readMap(): Record<string, unknown> {
	const parsed = readJsonStorage<unknown>(KEY, {});
	return parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}

/** Last width the user dragged a card kind to, or null when none usable. */
export function readPdfCardWidth(kind: string): number | null {
	return clampWidth(readMap()[kind]);
}

/** Persist one card kind's width; best effort (quota / private mode). */
export function writePdfCardWidth(kind: string, width: number): void {
	const clamped = clampWidth(width);
	if (clamped === null) return;
	writeJsonStorage(KEY, { ...readMap(), [kind]: clamped });
}

/**
 * Watch the inline size CSS `resize` writes on `element` and report the width
 * the user actually dragged.
 *
 * A ResizeObserver is the only signal (the native corner dispatches no DOM
 * events here), so the callback filters everything else out:
 * - content growth never writes inline height → ignored;
 * - the viewport re-laying the card out changes the inline width only → ignored;
 * - the first observation primes the baseline.
 *
 * The height change is only used as the "this was a corner drag" marker; the
 * reported value is the width, because the cards stay content-sized.
 *
 * Returns a disposer that also drops a pending, not-yet-settled resize.
 */
export function watchCardWidthResize(
	element: HTMLElement,
	onWidth: (width: number) => void,
	options: { quietMs?: number } = {},
): () => void {
	const quietMs = options.quietMs ?? CARD_RESIZE_QUIET_MS;
	const ResizeObserverCtor = element.ownerDocument.defaultView?.ResizeObserver;
	if (!ResizeObserverCtor) return () => {};
	let lastWidth = element.style.width;
	let lastHeight = element.style.height;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let primed = false;
	const clearTimer = () => {
		if (timer === null) return;
		clearTimeout(timer);
		timer = null;
	};
	const observer = new ResizeObserverCtor(() => {
		// The first callback is the observation itself, not a gesture.
		if (!primed) {
			primed = true;
			return;
		}
		const widthChanged = element.style.width !== lastWidth;
		const heightChanged = element.style.height !== lastHeight;
		lastWidth = element.style.width;
		lastHeight = element.style.height;
		if (!widthChanged || !heightChanged || !element.style.height) return;
		clearTimer();
		timer = setTimeout(() => {
			timer = null;
			onWidth(element.offsetWidth);
		}, quietMs);
	});
	observer.observe(element);
	return () => {
		clearTimer();
		observer.disconnect();
	};
}
