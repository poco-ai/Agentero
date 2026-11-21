import { useCallback, useRef, useState } from "react";
import {
	IME_COMPOSITION_END_GRACE_MS,
	isImeKeyboardEvent,
} from "@/lib/core/ime";

type KeyLike = Parameters<typeof isImeKeyboardEvent>[0];

/**
 * Guard Enter / other hotkeys while an IME is composing (CJK etc.).
 *
 * Covers the compositionend-before-keydown race with a short grace window;
 * see `src/lib/core/ime.ts`.
 */
export function useImeGuard() {
	const [isComposing, setIsComposing] = useState(false);
	const compositionEndAtRef = useRef(0);

	const isBlockedByIme = useCallback(
		(event: KeyLike) => {
			if (isComposing || isImeKeyboardEvent(event)) {
				return true;
			}
			return (
				performance.now() - compositionEndAtRef.current <
				IME_COMPOSITION_END_GRACE_MS
			);
		},
		[isComposing],
	);

	const onCompositionStart = useCallback(() => {
		setIsComposing(true);
		compositionEndAtRef.current = 0;
	}, []);

	const onCompositionEnd = useCallback(() => {
		compositionEndAtRef.current = performance.now();
		setIsComposing(false);
	}, []);

	return {
		isBlockedByIme,
		isComposing,
		compositionProps: {
			onCompositionStart,
			onCompositionEnd,
		} as const,
	};
}
