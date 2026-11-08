// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CARD_HOVER_HIDE_MS } from "@/components/viewer/pdf/floating-hover";
import {
	type PdfCards,
	usePdfCards,
} from "@/components/viewer/pdf/hooks/use-pdf-cards";
import type { PdfAskThread } from "@/lib/pdf/ask/types";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";

vi.mock("@/components/viewer/pdf/floating-hover", () => ({
	CARD_HOVER_HIDE_MS: 300,
	isFloatingDialogActive: () => false,
}));

const anchor = {
	page: 1,
	rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.03 }],
	trigger: "selection" as const,
};
let root: Root;
let cards: PdfCards;
let page: HTMLDivElement;
let pageTop: number;
let onCardClose: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	pageTop = 100;
	const host = document.createElement("div");
	page = document.createElement("div");
	page.setAttribute("data-embed-pdf-page", "0");
	page.getBoundingClientRect = () => new DOMRect(100, pageTop, 600, 800);
	host.append(page);
	document.body.append(host);
	onCardClose = vi.fn();
	const options = {
		hostRef: { current: host },
		pageTextMapRef: { current: new Map() },
		threadsRef: { current: [{ id: "ask", anchor } as PdfAskThread] },
		translatesRef: {
			current: [{ id: "translate", ...anchor } as PdfTranslateRecord],
		},
		visualTracesRef: { current: [] },
		onCardOpen: vi.fn(),
		onCardClose,
		stopTranslateSession: vi.fn(),
	};
	function Harness() {
		cards = usePdfCards(options);
		return null;
	}
	root = createRoot(document.createElement("div"));
	await act(async () => root.render(createElement(Harness)));
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

it.each([
	"ask",
	"translate",
] as const)("keeps an unfocused %s card open after pointer leave, until explicitly hidden", async (kind) => {
	await act(async () => cards.openCard({ kind, id: kind }));
	await act(async () => {
		cards.scheduleHoverHide();
		vi.advanceTimersByTime(CARD_HOVER_HIDE_MS + 1);
	});
	expect(cards.activeCard).toEqual({ kind, id: kind });
	expect(onCardClose).not.toHaveBeenCalled();
	await act(async () => cards.hideActiveCard());
	expect(cards.activeCard).toBeNull();
	expect(cards.cardScreen).toBeNull();
	expect(onCardClose).toHaveBeenCalledWith({ kind, id: kind });
});

it.each([
	"ask",
	"translate",
] as const)("keeps the %s card in place when its source scrolls out and is virtualized", async (kind) => {
	await act(async () => cards.openCard({ kind, id: kind }));
	const openedAt = cards.cardScreen;
	expect(openedAt).not.toBeNull();
	pageTop = -1000;
	await act(async () => cards.rePlaceActiveCardOnScroll());
	expect(cards.cardScreen).toBe(openedAt);
	page.remove();
	await act(async () => cards.rePlaceActiveCardOnScroll());
	expect(cards.cardScreen).toBe(openedAt);
	// Explicitly reopening the same pin can anchor the card at its new location.
	document.body.firstElementChild?.append(page);
	pageTop = 200;
	await act(async () => cards.openCard({ kind, id: kind }));
	expect(cards.cardScreen?.y).not.toBe(openedAt?.y);
});
