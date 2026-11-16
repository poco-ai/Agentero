import { useEffect, useRef, useState } from "react";

/** Characters revealed per second at minimum; backlog speeds it up. */
const BASE_CPS = 90;
/** A backlog is cleared in about this many seconds, however long it is. */
const CATCH_UP_SECONDS = 1.2;

/**
 * Typewriter reveal of `target`. Works for streamed deltas and for one-shot
 * results alike: the shown text chases the target every frame, faster when the
 * backlog is large. If `target` is not an extension of what is shown (a new
 * run replaced it), the display resets. `enabled=false` shows the target at
 * once and keeps the cursor there, so toggling it back on does not replay text.
 */
export function useTypewriter(
	target: string,
	enabled = true,
): { text: string; typing: boolean } {
	const [shown, setShown] = useState(0);
	const prevRef = useRef(target);
	const posRef = useRef(0);

	// A replaced (non-extending) target restarts the reveal.
	if (!target.startsWith(prevRef.current)) {
		posRef.current = 0;
		if (shown !== 0) setShown(0);
	}
	prevRef.current = target;
	// Disabled means "already fully shown": park the cursor (and the rendered
	// cursor) so re-enabling does not replay the text or strand it hidden.
	if (!enabled) {
		posRef.current = target.length;
		if (shown !== target.length) setShown(target.length);
	}

	useEffect(() => {
		if (!enabled) return;
		if (posRef.current >= target.length) return;
		let raf = 0;
		let last = performance.now();
		const tick = (now: number) => {
			const dt = Math.min((now - last) / 1000, 0.1);
			last = now;
			const backlog = target.length - posRef.current;
			const cps = Math.max(BASE_CPS, backlog / CATCH_UP_SECONDS);
			posRef.current = Math.min(target.length, posRef.current + cps * dt);
			setShown(Math.floor(posRef.current));
			if (posRef.current < target.length) raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [target, enabled]);

	if (!enabled) return { text: target, typing: false };
	const n = Math.min(shown, target.length);
	// Do not cut a surrogate pair in half.
	const code = target.charCodeAt(n - 1);
	const end = n > 0 && code >= 0xd800 && code <= 0xdbff ? n - 1 : n;
	return { text: target.slice(0, end), typing: end < target.length };
}
