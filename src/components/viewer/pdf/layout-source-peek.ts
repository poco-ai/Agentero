/**
 * Middle-click report for the translation reader.
 *
 * Middle- and right-drag both pan (`bindPanDragGesture`); the right button
 * keeps that behavior untouched. A middle press that ends without travel is
 * reported here instead of panning, and the page overlay that owns the
 * translated block resolves it against its own items to open the read-only
 * source card. Keeping the report out of React props lets the page layers stay
 * memoized.
 */

export type LayoutSourcePeekPress = {
	/** Viewer document id; layout block ids are only unique inside a paper. */
	docId: string;
	/** Element under the pointer when the right button went down. */
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
