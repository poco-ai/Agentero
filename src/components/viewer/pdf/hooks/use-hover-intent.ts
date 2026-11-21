/**
 * Hover-intent gate for the PDF link previews (citation metadata card,
 * figure / table / equation crop card, external-URL tip).
 *
 * A card must not open just because the pointer crossed a link on its way
 * somewhere else: the anchor only asks for a card after the pointer has rested
 * on it for `delayMs`. Leaving the anchor cancels the pending open right away
 * and hands off to the card's own sticky-hide timer, so an already-open card
 * still bridges the pointer travelling into it.
 *
 * Only the open is delayed. Hiding stays owned by `useStickyHoverHide`; the
 * two hooks compose (`enter` → `onOpen`, `leave` → `onLeave` schedules a hide).
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

export type HoverIntent<T> = {
	/** Pointer entered an anchor: open after the dwell unless cancelled. */
	enter: (payload: T) => void;
	/** Pointer left an anchor: drop a pending open, then run `onLeave`. */
	leave: () => void;
	/** Drop a pending open without opening or notifying (drag / doc switch). */
	cancel: () => void;
};

export type UseHoverIntentOptions<T> = {
	/** How long the pointer must rest on an anchor before its card opens. */
	delayMs: number;
	/** Pointer rested on the anchor; show / refresh the card. */
	onOpen: (payload: T) => void;
	/** Pointer left the anchor without this intent opening anything. */
	onLeave: () => void;
};

export function useHoverIntent<T>({
	delayMs,
	onOpen,
	onLeave,
}: UseHoverIntentOptions<T>): HoverIntent<T> {
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Mirrored so the callbacks can change per render (sidecar / suppress
	// state) without re-creating the intent API our handlers depend on.
	const onOpenRef = useRef(onOpen);
	onOpenRef.current = onOpen;
	const onLeaveRef = useRef(onLeave);
	onLeaveRef.current = onLeave;

	const cancel = useCallback(() => {
		if (timerRef.current == null) return;
		clearTimeout(timerRef.current);
		timerRef.current = null;
	}, []);

	const enter = useCallback(
		(payload: T) => {
			cancel();
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				onOpenRef.current(payload);
			}, delayMs);
		},
		[cancel, delayMs],
	);

	const leave = useCallback(() => {
		cancel();
		onLeaveRef.current();
	}, [cancel]);

	useEffect(
		() => () => {
			cancel();
		},
		[cancel],
	);

	return useMemo(() => ({ enter, leave, cancel }), [enter, leave, cancel]);
}
