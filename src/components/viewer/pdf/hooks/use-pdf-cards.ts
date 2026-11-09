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
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	pageElByIndex,
	selectionBoundsOnScreen,
} from "@/components/viewer/pdf/coords";
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
import {
	claimSelectionTranslation,
	ownsSelectionTranslation,
	releaseSelectionTranslation,
} from "@/lib/workspace/selection-card-owner";
import { workspaceStore } from "@/lib/workspace/store";

export type UsePdfCardsOptions = {
	isActive: boolean;
	hostRef: RefObject<HTMLDivElement | null>;
	pageTextMapRef: RefObject<Map<number, NormalizedRect[]>>;
	threadsRef: RefObject<PdfAskThread[]>;
	translatesRef: RefObject<PdfTranslateRecord[]>;
	visualTracesRef: RefObject<PdfVisualSessionTrace[]>;
	/** Cluster-owned chrome reset for the card being opened (ask / translate errors). */
	onCardOpen: (card: ActiveSelectionCard) => void;
	/**
	 * Cluster-owned cleanup for the card being closed: keep a started ask draft
	 * (the card deletes untouched ones itself), discard an unpinned translate,
	 * clear per-kind errors, and close the note editor.
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
	/** Re-anchor the open card after its page moved under it. */
	syncActiveCardPosition: () => void;
	cancelHoverHide: () => void;
	markCardHoverEnter: () => void;
	scheduleHoverHide: () => void;
};

export function usePdfCards({
	isActive,
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
		const card = activeCardRef.current;
		activeCardRef.current = null;
		releaseSelectionTranslation(hideActiveCard);
		onCardClose(card);
		cardHoverSurfaceRef.current = false;
		setActiveCard(null);
		cardScreenRef.current = null;
		setCardScreen(null);
	}, [onCardClose, cardHoverSurfaceRef]);
	hideActiveCardRef.current = hideActiveCard;

	useLayoutEffect(() => {
		return () => {
			releaseSelectionTranslation(hideActiveCard);
		};
	}, [hideActiveCard]);

	useLayoutEffect(() => {
		if (activeCard?.kind !== "translate") return;
		if (!isActive) {
			hideActiveCard();
			return;
		}
		// Embedded PDFs can be kept mounted with their parent editor. The
		// workspace tab and pointer also identify when the reader leaves one.
		const unsubscribe = workspaceStore.subscribe((next, previous) => {
			if (
				next.activeTabId !== previous.activeTabId &&
				ownsSelectionTranslation(hideActiveCard)
			)
				hideActiveCard();
		});
		const closeOnOtherPdf = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			const pdf = target.closest("[data-pdf-root]");
			if (
				pdf &&
				pdf !== hostRef.current &&
				ownsSelectionTranslation(hideActiveCard)
			)
				hideActiveCard();
		};
		document.addEventListener("pointerdown", closeOnOtherPdf, true);
		return () => {
			unsubscribe();
			document.removeEventListener("pointerdown", closeOnOtherPdf, true);
		};
	}, [activeCard, hideActiveCard, hostRef, isActive]);

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
			const pageEl = pageElByIndex(host, page - 1);
			const selectionBounds =
				card.kind === "translate"
					? selectionBoundsOnScreen(pageEl, rects)
					: null;
			const pt: CardScreenPoint | null = selectionBounds
				? {
						x: (selectionBounds.left + selectionBounds.right) / 2,
						y: selectionBounds.top,
						selectionBounds,
					}
				: popoverScreenPoint(
						pageEl,
						rects,
						pinFromRects(rects, pageTextMapRef.current.get(page - 1)),
					);
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
		// Conversations stay in the viewport while their source page scrolls
		// away (and may be virtualized) — only retry before the first placement.
		// Reading cards (translate / visual) stay anchored to the page instead.
		if (card.kind === "ask" && cardScreenRef.current) return;
		placeActiveCard(card);
	}, [placeActiveCard]);

	const openCard = useCallback(
		(card: ActiveSelectionCard) => {
			if (card.kind === "translate") {
				if (!isActive) return;
				claimSelectionTranslation(hideActiveCard);
			} else if (ownsSelectionTranslation(hideActiveCard)) {
				releaseSelectionTranslation(hideActiveCard);
			}
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
			} else if (
				previousCard?.kind === "ask" &&
				(card.kind !== "ask" || card.id !== previousCard.id)
			) {
				// Replacing an open quick chat closes it: an untouched draft must
				// not leave its pin/highlight behind when another card takes over.
				onCardClose(previousCard);
			}
			activeCardRef.current = card;
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
			hideActiveCard,
			isActive,
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
