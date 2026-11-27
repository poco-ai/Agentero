/**
 * Source-peek reports for the translation reader.
 *
 * The right button still drags to pan; a right press that ends without travel
 * opens the read-only source card. The middle button is hold-to-reveal: its
 * press hides the translated page so the original text underneath shows, and
 * the release restores it. Both reports name only the pointer target; the page
 * overlay that owns the translated block resolves it against its own items.
 * Keeping this out of React props lets the page layers stay memoized.
 */

export type LayoutSourcePeekPress = {
	/** Viewer document id; layout block ids are only unique inside a paper. */
	docId: string;
	/** Element under the pointer when the button went down. */
	target: Element;
	/** Pointer position at release, used as the card anchor. */
	point: { x: number; y: number };
};

type Listener = (press: LayoutSourcePeekPress) => void;

const listeners = new Set<Listener>();

export function reportLayoutSourcePeekPress(
	docId: string,
	target: EventTarget | null,
	point: { x: number; y: number },
): void {
	if (!(target instanceof Element)) return;
	const press: LayoutSourcePeekPress = {
		docId,
		target,
		point: { x: point.x, y: point.y },
	};
	for (const listener of [...listeners]) listener(press);
}

export function subscribeLayoutSourcePeekPress(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export type LayoutSourcePeekHold = {
	/** Viewer document id; layout block ids are only unique inside a paper. */
	docId: string;
	/** Element under the pointer when the middle button went down. */
	target: Element;
	/** Pointer position at press, used to resolve the surrounding blocks. */
	point: { x: number; y: number };
};

type HoldListener = (hold: LayoutSourcePeekHold | null) => void;

const holdListeners = new Set<HoldListener>();

/** Start revealing; `null` is never sent here, only by the end report. */
export function reportLayoutSourcePeekHoldStart(
	docId: string,
	target: EventTarget | null,
	point: { x: number; y: number },
): void {
	if (!(target instanceof Element)) return;
	const hold: LayoutSourcePeekHold = {
		docId,
		target,
		point: { x: point.x, y: point.y },
	};
	for (const listener of [...holdListeners]) listener(hold);
}

/** Release: every page restores its translated blocks. */
export function reportLayoutSourcePeekHoldEnd(): void {
	for (const listener of [...holdListeners]) listener(null);
}

export function subscribeLayoutSourcePeekHold(
	listener: HoldListener,
): () => void {
	holdListeners.add(listener);
	return () => holdListeners.delete(listener);
}
