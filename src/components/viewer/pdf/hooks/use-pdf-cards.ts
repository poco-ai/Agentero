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

/**
 * Pin travel (px) below which a scroll event is treated as layout jitter or a
 * sub-pixel re-render rather than the reader moving through the document.
 */
const SCROLL_MOVE_TOLERANCE_PX = 2;

/**
 * Accumulated pin travel (px) that dismisses a translate card. Sized for a
 * couple of deliberate scroll gestures — one wheel notch or a short trackpad
 * flick is far less — so a nudge never closes a translation mid-read.
 */
const SCROLL_DISMISS_TRAVEL_PX = 200;

export type UsePdfCardsOptions = {
	hostRef: RefObject<HTMLDivElement | null>;
	pageTextMapRef: RefObject<Map<number, NormalizedRect[]>>;
	threadsRef: RefObject<PdfAskThread[]>;
	translatesRef: RefObject<PdfTranslateRecord[]>;
	visualTracesRef: RefObject<PdfVisualSessionTrace[]>;
	/** Cluster-owned chrome reset for the card being opened (ask / translate errors). */
	onCardOpen: (card: ActiveSelectionCard) => void;
	/**
	 * Cluster-owned chrome reset for the card being closed: discard an empty ask
	 * draft, clear per-kind errors, close the note editor.
	 */
	onCardClose: (card: ActiveSelectionCard | null) => void;
	/** Cancel an in-flight translate run when its card is replaced. */
	stopTranslateSession: () => void;
};

export type PdfCards = {
	activeCard: ActiveSelectionCard | null;
	activeCardRef: RefObject<ActiveSelectionCard | null>;
	cardScreen: CardScreenPoint | null;
	cardScreenRef: RefObject<CardScreenPoint | null>;
	setActiveCard: Dispatch<SetStateAction<ActiveSelectionCard | null>>;
	setCardScreen: Dispatch<SetStateAction<CardScreenPoint | null>>;
	openCard: (card: ActiveSelectionCard) => void;
	hideActiveCard: () => void;
	placeActiveCard: (card: ActiveSelectionCard) => boolean;
	/**
	 * Re-anchor the open card after the page moved under it. Returns true once
	 * the pin has travelled `SCROLL_DISMISS_TRAVEL_PX` since the card opened,
	 * i.e. the reader has scrolled a couple of gestures rather than nudged.
	 */
	rePlaceActiveCardOnScroll: () => boolean;
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
	/** Pin travel accumulated since the open card was placed (see scroll dismiss). */
	const scrollTravelRef = useRef(0);

	/**
	 * Sticky hover contract for the open card: hide `CARD_HOVER_HIDE_MS` after
	 * the pointer leaves every hover surface (pin / card / source fragment),
	 * never while the floating dialog is hovered / focused, and never
	 * auto-hide for translate — the user reads the translation. A translate
	 * card closes through its own dismiss action, Escape, outside interaction,
	 * or deliberate page scrolling. `hideActiveCard` needs the hook's
	 * surface ref, so the hook receives it through a ref assigned below —
	 * both stay identity-stable (`onCardClose` already is).
	 */
	const holdCardOpen = useCallback(
		() => activeCardRef.current?.kind === "translate",
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
		scrollTravelRef.current = 0;
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
				if (placeActiveCard(card)) return;
				tries += 1;
				if (tries >= attempts) return;
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		},
		[placeActiveCard],
	);

	/**
	 * Re-anchor the open card after the page moved under it, accumulating how
	 * far the pin has travelled since the card opened. Returns true once that
	 * travel passes `SCROLL_DISMISS_TRAVEL_PX`, so callers can tell a real
	 * scroll apart from scroll events that fire on listener (re)subscribe or
	 * from EmbedPDF selection / layout churn.
	 */
	const rePlaceActiveCardOnScroll = useCallback(() => {
		const card = activeCardRef.current;
		if (!card) return false;
		const before = cardScreenRef.current;
		placeActiveCard(card);
		const after = cardScreenRef.current;
		if (!before || !after) return false;
		if (before.preferRight !== after.preferRight) return true;
		const dx = Math.abs(before.x - after.x);
		const dy = Math.abs(before.y - after.y);
		if (dx <= SCROLL_MOVE_TOLERANCE_PX && dy <= SCROLL_MOVE_TOLERANCE_PX) {
			return false;
		}
		// Diagonal travel counts on its longer axis, so a pinch/zoom-style nudge
		// is not discounted for being partly horizontal.
		scrollTravelRef.current += Math.max(dx, dy);
		return scrollTravelRef.current > SCROLL_DISMISS_TRAVEL_PX;
	}, [placeActiveCard]);

	const openCard = useCallback(
		(card: ActiveSelectionCard) => {
			// Cancel pending hide and treat open as an active hover surface so
			// the card does not auto-close while the pointer is still over the
			// pin / newly mounted modal (mount under cursor skips pointerenter).
			cancelHoverHide();
			cardHoverSurfaceRef.current = true;
			scrollTravelRef.current = 0;
			if (
				activeCardRef.current?.kind === "translate" &&
				(card.kind !== "translate" || card.id !== activeCardRef.current.id)
			) {
				stopTranslateSession();
			}
			setActiveCard(card);
			onCardOpen(card);
			// Place now if the page is mounted. If not (far jump / virtualized),
			// clear stale coords so the modal does not flash at the old pin, then
			// retry for a few frames after instant scroll mounts the page.
			if (!placeActiveCard(card)) {
				cardScreenRef.current = null;
				setCardScreen(null);
				placeActiveCardWithRetry(card);
			}
		},
		[
			cancelHoverHide,
			cardHoverSurfaceRef,
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
		cardScreenRef,
		setActiveCard,
		setCardScreen,
		openCard,
		hideActiveCard,
		placeActiveCard,
		rePlaceActiveCardOnScroll,
		cancelHoverHide,
		markCardHoverEnter,
		scheduleHoverHide,
	};
}
