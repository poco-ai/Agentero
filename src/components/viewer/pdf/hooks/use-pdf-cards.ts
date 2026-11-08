/**
 * Floating-card lifecycle for the EmbedPDF viewer: which mark card is open,
 * where it is anchored on screen, and the sticky hover contract that keeps it
 * open while the pointer travels between pin, source fragment and modal.
 *
 * Shared by the ask / translate / visual-mark / note-editor clusters and by the
 * per-page layer stack, so it lives in one hook instead of one closure. It is
 * deliberately not a React context: consumers would re-render on every
 * `cardScreen` change, which would defeat the per-page `memo`.
 */

import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useRef,
	useState,
} from "react";
import { pageElByIndex } from "@/components/viewer/pdf/coords";
import { CARD_HOVER_HIDE_MS } from "@/components/viewer/pdf/floating-hover";
import { useStickyHoverHide } from "@/components/viewer/pdf/hooks/use-sticky-hover-hide";
import type { CardScreenPoint } from "@/components/viewer/pdf/types";
import {
	isVisualMarkKind,
	type PdfVisualSessionTrace,
} from "@/lib/pdf/agent-trace";
import { popoverScreenPoint } from "@/lib/pdf/ask";
import type { PdfAskAnchor, PdfAskThread } from "@/lib/pdf/ask/types";
import {
	type ActiveSelectionCard,
	type NormalizedRect,
	pinFromRects,
} from "@/lib/pdf/selection";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";

export type UsePdfCardsOptions = {
	hostRef: RefObject<HTMLDivElement | null>;
	pageTextMapRef: RefObject<Map<number, NormalizedRect[]>>;
	threadsRef: RefObject<PdfAskThread[]>;
	translatesRef: RefObject<PdfTranslateRecord[]>;
	visualTracesRef: RefObject<PdfVisualSessionTrace[]>;
	/** Cluster-owned chrome reset for the card being opened (ask / translate errors). */
	onCardOpen: (card: ActiveSelectionCard) => void;
	/**
	 * Cluster-owned cleanup for the card being closed: keep an empty ask draft
	 * so its highlight stays, discard an unpinned translate, clear per-kind
	 * errors, and close the note editor.
	 */
	onCardClose: (card: ActiveSelectionCard | null) => void;
	/** Cancel an in-flight translate run when its card is replaced. */
	stopTranslateSession: () => void;
};

export type PdfCards = {
	activeCard: ActiveSelectionCard | null;
	activeCardRef: RefObject<ActiveSelectionCard | null>;
	cardScreen: CardScreenPoint | null;
	setActiveCard: Dispatch<SetStateAction<ActiveSelectionCard | null>>;
	setCardScreen: Dispatch<SetStateAction<CardScreenPoint | null>>;
	openCard: (card: ActiveSelectionCard) => void;
	hideActiveCard: () => void;
	/** Keep reading cards in place after their first placement. */
	syncActiveCardPosition: () => void;
	cancelHoverHide: () => void;
	markCardHoverEnter: () => void;
	scheduleHoverHide: () => void;
};

export function usePdfCards({
	hostRef,
	pageTextMapRef,
	threadsRef,
	translatesRef,
	visualTracesRef,
	onCardOpen,
	onCardClose,
	stopTranslateSession,
}: UsePdfCardsOptions): PdfCards {
	const [activeCard, setActiveCard] = useState<ActiveSelectionCard | null>(
		null,
	);
	const [cardScreen, setCardScreen] = useState<CardScreenPoint | null>(null);
	const activeCardRef = useRef<ActiveSelectionCard | null>(null);
	activeCardRef.current = activeCard;
	const cardScreenRef = useRef<CardScreenPoint | null>(null);

	/**
	 * Sticky hover contract for the open card: hide `CARD_HOVER_HIDE_MS` after
	 * the pointer leaves every hover surface (pin / card / source fragment),
	 * never while the floating dialog is hovered / focused, and never
	 * auto-hide for ask / translate — the user reads the response. A translate
	 * card closes through its own dismiss action or Escape. `hideActiveCard` needs the hook's
	 * surface ref, so the hook receives it through a ref assigned below —
	 * both stay identity-stable (`onCardClose` already is).
	 */
	const holdCardOpen = useCallback(
		() =>
			activeCardRef.current?.kind === "translate" ||
			activeCardRef.current?.kind === "ask",
		[],
	);
	const hideActiveCardRef = useRef<() => void>(() => undefined);
	const hideViaRef = useCallback(() => hideActiveCardRef.current(), []);

	const {
		hoverSurfaceRef: cardHoverSurfaceRef,
		cancelHide: cancelHoverHide,
		markHoverEnter: markCardHoverEnter,
		scheduleHide: scheduleHoverHide,
	} = useStickyHoverHide({
		delayMs: CARD_HOVER_HIDE_MS,
		hide: hideViaRef,
		hold: holdCardOpen,
	});

	const hideActiveCard = useCallback(() => {
		onCardClose(activeCardRef.current);
		cardHoverSurfaceRef.current = false;
		setActiveCard(null);
		cardScreenRef.current = null;
		setCardScreen(null);
	}, [onCardClose, cardHoverSurfaceRef]);
	hideActiveCardRef.current = hideActiveCard;

	/**
	 * Place the open pin card next to its gutter pin. Returns false when the
	 * page DOM is not mounted yet (virtualized) so callers can retry — never
	 * flash a top-left fallback while EmbedPDF is still scrolling/rendering.
	 *
	 * Uses the same pinFromRects(+pageText) side choice as the gutter so a
	 * left-side pin does not open the dialog on the far right of the selection.
	 */
	const placeActiveCard = useCallback(
		(card: ActiveSelectionCard): boolean => {
			const host = hostRef.current;
			if (!host) return false;
			let page = 1;
			let rects: PdfAskAnchor["rects"] = [];
			if (card.kind === "ask") {
				const thread = threadsRef.current.find((th) => th.id === card.id);
				if (!thread) return false;
				page = thread.anchor.page;
				rects = thread.anchor.rects;
			} else if (card.kind === "translate") {
				const tr = translatesRef.current.find((r) => r.id === card.id);
				if (!tr) return false;
				page = tr.page;
				rects = tr.rects;
			} else if (isVisualMarkKind(card.kind)) {
				const tr = visualTracesRef.current.find((item) => item.id === card.id);
				if (!tr) return false;
				page = tr.page;
				rects = tr.rects;
			} else {
				return false;
			}
			// Same side choice as the gutter pin (page text → may flip left).
			// Translate cards always open on the left of the selection so they
			// don't cover the reading column; the gutter pin side is unchanged.
			const pageText = pageTextMapRef.current.get(page - 1);
			const pin = pinFromRects(rects, pageText);
			const pageEl = pageElByIndex(host, page - 1);
			const cardPin =
				card.kind === "translate"
					? (() => {
							let minX = 1;
							for (const r of rects) minX = Math.min(minX, r.x);
							const leftX = Math.min(0.98, Math.max(0.02, minX - 0.014));
							return { x: leftX, y: pin.y, side: "left" as const };
						})()
					: pin;
			const pt = popoverScreenPoint(pageEl, rects, cardPin);
			// Target page not in the virtual DOM yet — keep cardScreen null so the
			// modal stays hidden until onScroll / rAF retry can place it for real.
			if (!pt) return false;
			// Skip identical coords — avoids re-rendering the open card (and its
			// input) on every scroll tick when the pin did not actually move.
			const prev = cardScreenRef.current;
			if (
				prev &&
				Math.round(prev.x) === Math.round(pt.x) &&
				Math.round(prev.y) === Math.round(pt.y) &&
				prev.preferRight === pt.preferRight
			) {
				return true;
			}
			cardScreenRef.current = pt;
			setCardScreen(pt);
			return true;
		},
		[hostRef, pageTextMapRef, threadsRef, translatesRef, visualTracesRef],
	);

	/** After instant page jumps, the virtual page may land a few frames later. */
	const placeActiveCardWithRetry = useCallback(
		(card: ActiveSelectionCard, attempts = 12) => {
			let tries = 0;
			const tick = () => {
				if (activeCardRef.current !== card || cardScreenRef.current) return;
				if (placeActiveCard(card)) return;
				tries += 1;
				if (tries >= attempts) return;
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		},
		[placeActiveCard],
	);

	const syncActiveCardPosition = useCallback(() => {
		const card = activeCardRef.current;
		if (!card) return;
		if (
			cardScreenRef.current &&
			(card.kind === "ask" || card.kind === "translate")
		)
			return;
		placeActiveCard(card);
	}, [placeActiveCard]);

	const openCard = useCallback(
		(card: ActiveSelectionCard) => {
			// Cancel pending hide and treat open as an active hover surface so
			// the card does not auto-close while the pointer is still over the
			// pin / newly mounted modal (mount under cursor skips pointerenter).
			cancelHoverHide();
			cardHoverSurfaceRef.current = true;
			const previousCard = activeCardRef.current;
			if (
				previousCard?.kind === "translate" &&
				(card.kind !== "translate" || card.id !== previousCard.id)
			) {
				onCardClose(previousCard);
				stopTranslateSession();
			}
			setActiveCard(card);
			onCardOpen(card);
			// Place now if the page is mounted. If not (far jump / virtualized),
			// clear stale coords so the modal does not flash at the old pin, then
			// retry for a few frames after instant scroll mounts the page.
			cardScreenRef.current = null;
			if (!placeActiveCard(card)) {
				setCardScreen(null);
				placeActiveCardWithRetry(card);
			}
		},
		[
			cancelHoverHide,
			cardHoverSurfaceRef,
			onCardClose,
			onCardOpen,
			placeActiveCard,
			placeActiveCardWithRetry,
			stopTranslateSession,
		],
	);

	return {
		activeCard,
		activeCardRef,
		cardScreen,
		setActiveCard,
		setCardScreen,
		openCard,
		hideActiveCard,
		syncActiveCardPosition,
		cancelHoverHide,
		markCardHoverEnter,
		scheduleHoverHide,
	};
}
