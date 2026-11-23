/**
 * Click versus drag, and hover across the glyphs of one translated link.
 *
 * The browser fires `click` after a text-selection drag that started on the
 * token. A non-empty selection is not proof of a drag: a stationary click can
 * leave the glyph under the pointer selected. Travel is the signal, the same
 * threshold layout regions already use.
 *
 * A reflow line is one hit target, but a token can still wrap. The strip
 * between those lines must not cancel the dwell timer.
 */

import { useCallback, useEffect, useRef } from "react";
import { isLayoutRegionActivation } from "@/lib/pdf/layout/click-guard";
import type { PreservedLinkAssignment } from "@/lib/pdf/layout/translated-links";
import { linkPreviewDragActive } from "@/lib/pdf/link-preview-drag";

/**
 * How long the pointer may sit in the gap between two lines of one link
 * before the dwell is cancelled. Line spacing leaves a strip between the hit
 * boxes; a 0ms clear fires while the pointer is still crossing that strip.
 */
export const TRANSLATED_LINK_HOVER_GAP_MS = 100;

export type TranslatedLinkPoint = {
	x: number;
	y: number;
	top: number;
	bottom: number;
};

export function translatedLinkIdentity(
	assignment: PreservedLinkAssignment,
): string {
	return `${assignment.key ?? ""}\0${assignment.url ?? ""}\0${assignment.start}\0${assignment.end}`;
}

const origins = new WeakMap<EventTarget, { x: number; y: number }>();

export function rememberTranslatedLinkOrigin(
	target: EventTarget,
	point: { x: number; y: number },
): void {
	origins.set(target, point);
}

type TranslatedLinkClick = {
	preventDefault(): void;
	stopPropagation(): void;
	detail: number;
	clientX: number;
	clientY: number;
	currentTarget: EventTarget | null;
};

/** Follow the link when the gesture stayed inside the click threshold. */
export function activateTranslatedLinkClick(
	event: TranslatedLinkClick,
	open: () => void,
): void {
	event.preventDefault();
	event.stopPropagation();
	const origin = event.currentTarget
		? (origins.get(event.currentTarget) ?? null)
		: null;
	if (
		!isLayoutRegionActivation({
			detail: event.detail,
			origin,
			end: { x: event.clientX, y: event.clientY },
		})
	) {
		return;
	}
	// A stationary click can select the glyph it landed on. Drop that range
	// so the selection menu does not open on top of the navigation.
	window.getSelection()?.removeAllRanges();
	open();
}

/**
 * Pointer movement inside one link (another glyph, or the next wrapped line)
 * keeps the dwell that is already running. A different link starts its own.
 */
export function useCoalescedTranslatedLinkHover(
	onHoverLink:
		| ((
				assignment: PreservedLinkAssignment | null,
				point: TranslatedLinkPoint | null,
		  ) => void)
		| undefined,
): {
	enter: (
		assignment: PreservedLinkAssignment,
		point: TranslatedLinkPoint,
	) => void;
	leave: () => void;
} {
	const onHoverRef = useRef(onHoverLink);
	onHoverRef.current = onHoverLink;
	const current = useRef<string | null>(null);
	const clearTimer = useRef<number | null>(null);
	const cancelClear = useCallback(() => {
		if (clearTimer.current == null) return;
		window.clearTimeout(clearTimer.current);
		clearTimer.current = null;
	}, []);
	useEffect(
		() => () => {
			if (clearTimer.current != null) window.clearTimeout(clearTimer.current);
		},
		[],
	);
	const enter = useCallback(
		(assignment: PreservedLinkAssignment, point: TranslatedLinkPoint) => {
			cancelClear();
			const id = translatedLinkIdentity(assignment);
			if (current.current === id) return;
			if (current.current) onHoverRef.current?.(null, null);
			current.current = id;
			onHoverRef.current?.(assignment, point);
		},
		[cancelClear],
	);
	const leave = useCallback(() => {
		if (linkPreviewDragActive()) {
			current.current = null;
			return;
		}
		cancelClear();
		clearTimer.current = window.setTimeout(() => {
			clearTimer.current = null;
			if (current.current == null) return;
			current.current = null;
			onHoverRef.current?.(null, null);
		}, TRANSLATED_LINK_HOVER_GAP_MS);
	}, [cancelClear]);
	return { enter, leave };
}
