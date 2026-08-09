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
import { pageElByIndex } from "@/components/viewer/embed/geometry";
import type { CardScreenPoint } from "@/components/viewer/embed/pdf-viewer-types";
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

/** How long a card survives after the pointer leaves every hover surface. */
const CARD_HOVER_HIDE_MS = 1000;

export type UsePdfCardsOptions = {
	hostRef: RefObject<HTMLDivElement | null>;
	pageTextMapRef: RefObject<Map<number, NormalizedRect[]>>;
	threadsRef: RefObject<PdfAskThread[]>;
	translatesRef: RefObject<PdfTranslateRecord[]>;
	visualTracesRef: RefObject<PdfVisualSessionTrace[]>;
	/** Translate cards stay open past hover while their run is still streaming. */
	translateStreamingRef: RefObject<boolean>;
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
	/** Re-anchor the open card after the page moved under it. */
	rePlaceActiveCardOnScroll: () => void;
	cancelHoverHide: () => void;
	markCardHoverEnter: () => void;
	scheduleHoverHide: () => void;
	/** True while the pointer is over the active card, pin, or source fragment. */
	cardHoverSurfaceRef: RefObject<boolean>;
};

/**
 * Selection / note modals are portaled `role="dialog"`. After pin leave the
 * hide timer may fire before (or without) a card pointerenter — keep open
 * while the pointer is still over a dialog or a field inside it is focused.
 */
function isFloatingDialogActive(): boolean {
	if (typeof document === "undefined") return false;
	const dialogs = document.querySelectorAll('[role="dialog"]');
	for (const node of dialogs) {
		if (!(node instanceof HTMLElement)) continue;
		// Fixed floating selection cards / annotation editors only.
		if (!node.classList.contains("fixed")) continue;
		try {
			if (node.matches(":hover")) return true;
		} catch {
			// :hover may throw in non-browser test envs
		}
		const ae = document.activeElement;
		if (ae instanceof HTMLElement && node.contains(ae)) return true;
	}
	return false;
}

export function usePdfCards({
	hostRef,
	pageTextMapRef,
	threadsRef,
	translatesRef,
	visualTracesRef,
	translateStreamingRef,
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
	const hidePopoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	/** True while pointer is over the active card, pin, or source fragment. */
	const cardHoverSurfaceRef = useRef(false);

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
			const pageText = pageTextMapRef.current.get(page - 1);
			const pin = pinFromRects(rects, pageText);
			const pageEl = pageElByIndex(host, page - 1);
			const pt = popoverScreenPoint(pageEl, rects, pin);
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

	const rePlaceActiveCardOnScroll = useCallback(() => {
		if (activeCardRef.current) placeActiveCard(activeCardRef.current);
	}, [placeActiveCard]);

	const cancelHoverHide = useCallback(() => {
		if (hidePopoverTimerRef.current) {
			clearTimeout(hidePopoverTimerRef.current);
			hidePopoverTimerRef.current = null;
		}
	}, []);

	const hideActiveCard = useCallback(() => {
		onCardClose(activeCardRef.current);
		cardHoverSurfaceRef.current = false;
		setActiveCard(null);
		cardScreenRef.current = null;
		setCardScreen(null);
	}, [onCardClose]);

	const markCardHoverEnter = useCallback(() => {
		cardHoverSurfaceRef.current = true;
		cancelHoverHide();
	}, [cancelHoverHide]);

	/**
	 * Leave pin / card / source fragment. Translate cards hide when nothing is
	 * hovered (unless still streaming). Ask / visual / note editors keep a 1s
	 * delay, and never dismiss while the floating dialog is hovered or focused.
	 */
	const scheduleHoverHide = useCallback(() => {
		cardHoverSurfaceRef.current = false;
		cancelHoverHide();
		hidePopoverTimerRef.current = setTimeout(() => {
			hidePopoverTimerRef.current = null;
			if (cardHoverSurfaceRef.current) return;
			// Still interacting with the floating note / chat modal.
			if (isFloatingDialogActive()) {
				cardHoverSurfaceRef.current = true;
				return;
			}
			// Ephemeral translate result: stay open only while streaming or hovered.
			if (
				activeCardRef.current?.kind === "translate" &&
				translateStreamingRef.current
			) {
				return;
			}
			hideActiveCard();
		}, CARD_HOVER_HIDE_MS);
	}, [cancelHoverHide, hideActiveCard, translateStreamingRef]);

	const openCard = useCallback(
		(card: ActiveSelectionCard) => {
			// Cancel pending hide and treat open as an active hover surface so
			// the card does not auto-close while the pointer is still over the
			// pin / newly mounted modal (mount under cursor skips pointerenter).
			cancelHoverHide();
			cardHoverSurfaceRef.current = true;
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
		cardHoverSurfaceRef,
	};
}
