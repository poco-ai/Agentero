// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CARD_HOVER_HIDE_MS } from "@/components/viewer/pdf/floating-hover";
import {
	type PdfCards,
	type UsePdfCardsOptions,
	usePdfCards,
} from "@/components/viewer/pdf/hooks/use-pdf-cards";
import type { PdfAskThread } from "@/lib/pdf/ask/types";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";
import { workspaceStore } from "@/lib/workspace/store";

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
let options: UsePdfCardsOptions;
const translation = { kind: "translate", id: "translate" } as const;

function Harness({ active = true }: { active?: boolean }) {
	cards = usePdfCards({ ...options, isActive: active });
	return null;
}

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
	options = {
		isActive: true,
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

it("keeps an unfocused conversation open after pointer leave, until explicitly hidden", async () => {
	await act(async () => cards.openCard({ kind: "ask", id: "ask" }));
	await act(async () => {
		cards.scheduleHoverHide();
		vi.advanceTimersByTime(CARD_HOVER_HIDE_MS + 1);
	});
	expect(cards.activeCard).toEqual({ kind: "ask", id: "ask" });
	expect(onCardClose).not.toHaveBeenCalled();
	await act(async () => cards.hideActiveCard());
	expect(cards.activeCard).toBeNull();
	expect(cards.cardScreen).toBeNull();
	expect(onCardClose).toHaveBeenCalledWith({ kind: "ask", id: "ask" });
});

it("keeps the conversation in place when its source scrolls out and is virtualized", async () => {
	await act(async () => cards.openCard({ kind: "ask", id: "ask" }));
	const openedAt = cards.cardScreen;
	expect(openedAt).not.toBeNull();
	pageTop = -1000;
	await act(async () => cards.syncActiveCardPosition());
	expect(cards.cardScreen).toBe(openedAt);
	page.remove();
	await act(async () => cards.syncActiveCardPosition());
	expect(cards.cardScreen).toBe(openedAt);
	// Explicitly reopening the same pin can anchor the card at its new location.
	document.body.firstElementChild?.append(page);
	pageTop = 200;
	await act(async () => cards.openCard({ kind: "ask", id: "ask" }));
	expect(cards.cardScreen?.y).not.toBe(openedAt?.y);
});

it("keeps an unpinned translation in place when its source moves and unmounts", async () => {
	await act(async () => cards.openCard({ kind: "translate", id: "translate" }));
	const openedAt = cards.cardScreen;
	expect(openedAt).not.toBeNull();
	pageTop = -1000;
	await act(async () => cards.syncActiveCardPosition());
	expect(cards.cardScreen).toBe(openedAt);
	page.remove();
	await act(async () => cards.syncActiveCardPosition());
	expect(cards.cardScreen).toBe(openedAt);
	expect(cards.activeCard).toEqual({ kind: "translate", id: "translate" });
	expect(onCardClose).not.toHaveBeenCalled();
});

it("restores screen placement when opening again at the previous card's coordinates", async () => {
	await act(async () => cards.openCard(translation));
	const openedAt = cards.cardScreen;
	expect(openedAt).not.toBeNull();
	await act(async () => {
		// The Ask cluster closes its card through the state setters.
		cards.setActiveCard(null);
		cards.setCardScreen(null);
	});
	await act(async () => cards.openCard(translation));
	expect(cards.cardScreen).toEqual(openedAt);
});

it("closes the previous translation when another opens in the same viewer", async () => {
	const next = { kind: "translate", id: "next" } as const;
	await act(async () => {
		cards.openCard(translation);
		cards.openCard(next);
	});
	expect(onCardClose).toHaveBeenCalledExactlyOnceWith(translation);
	expect(cards.activeCard).toEqual(next);
});

it("closes a translation on deactivation and leaves it closed on return", async () => {
	await act(async () => cards.openCard(translation));
	await act(async () => root.render(createElement(Harness, { active: false })));
	expect(cards.activeCard).toBeNull();
	expect(onCardClose).toHaveBeenCalledExactlyOnceWith(translation);
	await act(async () => cards.openCard(translation));
	expect(cards.activeCard).toBeNull();
	await act(async () => root.render(createElement(Harness, { active: true })));
	expect(cards.activeCard).toBeNull();
});

it("lets only one mounted viewer own a translation and closes it on a workspace tab change", async () => {
	let otherCards!: PdfCards;
	const otherClose = vi.fn();
	const otherOptions = { ...options, onCardClose: otherClose };
	function Other() {
		otherCards = usePdfCards(otherOptions);
		return null;
	}
	const otherRoot = createRoot(document.createElement("div"));
	const previousTabId = workspaceStore.getState().activeTabId;
	try {
		await act(async () => otherRoot.render(createElement(Other)));
		await act(async () => cards.openCard(translation));
		await act(async () => otherCards.openCard(translation));
		expect(cards.activeCard).toBeNull();
		expect(onCardClose).toHaveBeenCalledExactlyOnceWith(translation);
		expect(otherCards.activeCard).toEqual(translation);
		await act(async () =>
			workspaceStore.setState({ activeTabId: "another-pdf" }),
		);
		expect(otherCards.activeCard).toBeNull();
		expect(otherClose).toHaveBeenCalledExactlyOnceWith(translation);
	} finally {
		await act(async () => otherRoot.unmount());
		workspaceStore.setState({ activeTabId: previousTabId });
	}
});
