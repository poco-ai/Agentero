/**
 * "Jump back" for internal PDF link jumps (issue #505): clicking an in-text
 * reference (Appendix, figure, citation …) scrolls the reader far away with no
 * way back. Every accepted jump pushes the pre-jump viewport position onto a
 * stack; a floating chip restores it.
 *
 * Own hook because it is one self-contained state machine around the viewport
 * capability: capture → commit (only when the link actually navigated) → pop.
 * Scrolling deliberately does NOT clear the stack — the whole point is to read
 * the appendix for a while, then return.
 */

import { useScrollCapability } from "@embedpdf/plugin-scroll/react";
import { useViewportCapability } from "@embedpdf/plugin-viewport/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	createJumpBackStack,
	type JumpBackStack,
	type JumpOrigin,
	popJumpOrigin,
	pushJumpOrigin,
} from "@/lib/pdf/jump-back-stack";

const EMPTY_STACK = createJumpBackStack();

export type UsePdfJumpBackOptions = {
	docId: string;
	hostRef?: RefObject<HTMLDivElement | null>;
};

export type PdfJumpBack = {
	/** Origin the chip would restore right now (null = chip hidden). */
	backTarget: JumpOrigin | null;
	/** Read the viewport before `navigateTarget` fires. */
	captureJumpOrigin: () => void;
	/** Push the captured origin; call only when the link actually navigated. */
	commitJumpOrigin: () => void;
	/** Restore the newest origin and pop it. */
	goBack: () => void;
	readerRestore: JumpOrigin | null;
};

export function usePdfJumpBack({
	docId,
	hostRef,
}: UsePdfJumpBackOptions): PdfJumpBack {
	const viewportCap = useViewportCapability().provides;
	const scrollCap = useScrollCapability().provides;
	const [stack, setStack] = useState<JumpBackStack>(EMPTY_STACK);
	const [readerRestore, setReaderRestore] = useState<JumpOrigin | null>(null);
	/** Mirror so `goBack` reads the live stack without a stale closure. */
	const stackRef = useRef(stack);
	stackRef.current = stack;
	/** Captured between `captureJumpOrigin` and `commitJumpOrigin`. */
	const pendingRef = useRef<JumpOrigin | null>(null);

	// New document (or viewer unmount/remount cycle) invalidates old origins.
	// biome-ignore lint/correctness/useExhaustiveDependencies: docId is the effect trigger, not a value read inside the effect.
	useEffect(() => {
		setStack(EMPTY_STACK);
		setReaderRestore(null);
		pendingRef.current = null;
	}, [docId]);

	const readOrigin = useCallback((): JumpOrigin | null => {
		if (!viewportCap || !scrollCap) return null;
		try {
			// `getCurrentPage` is 1-based, like `scrollToPage({ pageNumber })`.
			const page = scrollCap.forDocument(docId).getCurrentPage();
			if (!Number.isFinite(page) || page < 1) return null;
			const metrics = viewportCap.forDocument(docId).getMetrics();
			const reader =
				hostRef?.current?.querySelector<HTMLElement>("[data-pdf-reader]");
			const top = reader?.getBoundingClientRect().top ?? 0;
			const block =
				reader &&
				Array.from(
					reader.querySelectorAll<HTMLElement>("[data-reader-block]"),
				).find((element) => element.getBoundingClientRect().bottom > top + 48);
			return {
				x: metrics.scrollLeft,
				y: metrics.scrollTop,
				page,
				...(reader
					? {
							reader: {
								blockId: block?.dataset.readerBlock ?? null,
								top: block ? block.getBoundingClientRect().top - top : 0,
								scrollTop: reader.scrollTop,
							},
						}
					: {}),
			};
		} catch {
			// Viewport metrics may not be available yet; nothing to remember.
			return null;
		}
	}, [viewportCap, scrollCap, docId, hostRef]);

	const captureJumpOrigin = useCallback(() => {
		pendingRef.current = readOrigin();
	}, [readOrigin]);

	const commitJumpOrigin = useCallback(() => {
		const origin = pendingRef.current;
		pendingRef.current = null;
		if (!origin) return;
		setStack((prev) => pushJumpOrigin(prev, origin));
	}, []);

	const goBack = useCallback(() => {
		// Side-effect-free state update: the scroll lives outside the updater
		// so StrictMode's double-invoked updaters cannot re-scroll.
		const popped = popJumpOrigin(stackRef.current);
		if (!popped) return;
		stackRef.current = popped.stack;
		setStack(popped.stack);
		setReaderRestore(popped.origin);
		if (viewportCap) {
			try {
				viewportCap
					.forDocument(docId)
					// Instant: smooth jumps across distant pages feel like slow render.
					.scrollTo({
						x: popped.origin.x,
						y: popped.origin.y,
						behavior: "instant",
					});
			} catch {
				// Ignore transient scroll failures; the origin is popped either way.
			}
		}
	}, [viewportCap, docId]);

	const backTarget = stack.entries[stack.entries.length - 1] ?? null;

	return {
		backTarget,
		captureJumpOrigin,
		commitJumpOrigin,
		goBack,
		readerRestore,
	};
}
