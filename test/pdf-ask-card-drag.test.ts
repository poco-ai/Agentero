// @vitest-environment happy-dom

import { MotionConfig } from "motion/react";
import { act, type ComponentProps, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AskPopover } from "@/components/viewer/pdf/cards/ask-popover";
import type { PdfAskThread } from "@/lib/pdf/ask/types";

vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init: () => undefined },
	useTranslation: () => ({ t: (key: string) => key }),
}));

const thread: PdfAskThread = {
	version: 1,
	kind: "ask",
	id: "thread-1",
	paperPath: "papers/paper",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	status: "open",
	anchor: {
		page: 1,
		rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.03 }],
		trigger: "selection",
	},
	messages: [
		{
			id: "message-1",
			role: "user",
			content: "What does this mean?",
			createdAt: "2026-01-01T00:00:00.000Z",
		},
		{
			id: "message-2",
			role: "assistant",
			content: "It explains the selected passage.",
			createdAt: "2026-01-01T00:00:01.000Z",
		},
	],
};

const baseProps: ComponentProps<typeof AskPopover> = {
	thread,
	screen: { x: 100, y: 200 },
	streaming: false,
	error: null,
	onSend: vi.fn(),
	onHide: vi.fn(),
	onDelete: vi.fn(),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("innerWidth", 1200);
	vi.stubGlobal("innerHeight", 900);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(() => root.unmount());
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function renderAsk(
	overrides: Partial<ComponentProps<typeof AskPopover>> = {},
) {
	await act(() =>
		root.render(
			createElement(
				MotionConfig,
				{ isStatic: true },
				createElement(AskPopover, { ...baseProps, ...overrides }),
			),
		),
	);
	const card = container.querySelector<HTMLElement>('[role="dialog"]');
	if (!card) throw new Error("Ask card did not render");
	return card;
}

/** happy-dom has no layout: mirror the inline position/size for drag math. */
function patchRect(card: HTMLElement) {
	card.getBoundingClientRect = () =>
		new DOMRect(
			Number.parseFloat(card.style.left) || 0,
			Number.parseFloat(card.style.top) || 0,
			Number.parseFloat(card.style.width) || 0,
			Number.parseFloat(card.style.height) || 0,
		);
}

function heading(card: HTMLElement) {
	const header = card.querySelector<HTMLElement>("header");
	if (!header) throw new Error("Ask card has no title bar");
	header.setPointerCapture = vi.fn();
	return header;
}

async function pointer(
	target: Element,
	type: string,
	clientX: number,
	clientY: number,
) {
	await act(() => {
		target.dispatchEvent(
			new PointerEvent(type, {
				bubbles: true,
				pointerId: 1,
				button: 0,
				clientX,
				clientY,
			}),
		);
	});
}

function action(card: HTMLElement, label: string) {
	const button = card.querySelector<HTMLButtonElement>(
		`button[aria-label="${label}"]`,
	);
	if (!button) throw new Error(`Missing card action: ${label}`);
	return button;
}

it("keeps the dragged position when the anchor moves and across expand/restore", async () => {
	const card = await renderAsk();
	patchRect(card);
	const titleBar = heading(card);
	const startLeft = Number.parseFloat(card.style.left);
	const startTop = Number.parseFloat(card.style.top);

	await pointer(titleBar, "pointerdown", startLeft + 20, startTop + 20);
	await pointer(titleBar, "pointermove", startLeft + 80, startTop + 60);
	expect(card.style.left).toBe(`${startLeft + 60}px`);
	expect(card.style.top).toBe(`${startTop + 40}px`);
	await pointer(titleBar, "lostpointercapture", startLeft + 80, startTop + 60);

	// A moved card is independent of the source anchor.
	await renderAsk({ screen: { x: 700, y: 600 } });
	expect(card.style.left).toBe(`${startLeft + 60}px`);
	expect(card.style.top).toBe(`${startTop + 40}px`);

	// Header action buttons never start a drag.
	const expand = action(card, "pdfAsk.expand");
	await pointer(expand, "pointerdown", 320, 320);
	await pointer(expand, "pointermove", 520, 520);
	expect(card.style.left).toBe(`${startLeft + 60}px`);
	expect(card.style.top).toBe(`${startTop + 40}px`);

	// Expand / restore only changes the size and keeps the dragged position.
	await act(() => expand.click());
	expect(card.style.width).toBe("720px");
	expect(card.style.height).toBe("600px");
	expect(card.style.left).toBe(`${startLeft + 60}px`);
	expect(card.style.top).toBe(`${startTop + 40}px`);

	await act(() => action(card, "pdfAsk.restoreSize").click());
	expect(card.style.width).toBe("360px");
	expect(card.style.height).toBe("360px");
	expect(card.style.left).toBe(`${startLeft + 60}px`);
	expect(card.style.top).toBe(`${startTop + 40}px`);
});

it("shrinks the locked height on a short viewport instead of overflowing", async () => {
	vi.stubGlobal("innerHeight", 380);
	const card = await renderAsk({ screen: { x: 100, y: 300 } });

	const height = Number.parseFloat(card.style.height);
	expect(height).toBeLessThan(360);
	expect(height).toBeLessThanOrEqual(380 - 24);
	expect(Number.parseFloat(card.style.top) + height).toBeLessThanOrEqual(
		380 - 12 + 0.5,
	);

	// Expanding still fits: the placement cap wins over the preferred 600px.
	await act(() => action(card, "pdfAsk.expand").click());
	const expandedHeight = Number.parseFloat(card.style.height);
	expect(expandedHeight).toBeLessThanOrEqual(380 - 24);
	expect(
		Number.parseFloat(card.style.top) + expandedHeight,
	).toBeLessThanOrEqual(380 - 12 + 0.5);
});

it("clamps the expanded card height to the room below its dragged top", async () => {
	vi.stubGlobal("innerHeight", 600);
	const card = await renderAsk({ screen: { x: 100, y: 200 } });
	patchRect(card);
	const titleBar = heading(card);
	const startLeft = Number.parseFloat(card.style.left);
	const startTop = Number.parseFloat(card.style.top);

	// Drag to the bottom edge the card can reach at its compact 360px height.
	await pointer(titleBar, "pointerdown", startLeft + 20, startTop + 20);
	await pointer(titleBar, "pointermove", startLeft + 20, 520);
	const draggedTop = Number.parseFloat(card.style.top);
	expect(draggedTop).toBeGreaterThan(startTop);
	expect(draggedTop + 360).toBeLessThanOrEqual(600 - 12 + 0.5);

	// Expanding at that top must not grow past the viewport bottom.
	await act(() => action(card, "pdfAsk.expand").click());
	expect(card.style.width).toBe("720px");
	expect(card.style.top).toBe(`${draggedTop}px`);
	const expandedHeight = Number.parseFloat(card.style.height);
	expect(draggedTop + expandedHeight).toBeLessThanOrEqual(600 - 12 + 0.5);
	expect(expandedHeight).toBeLessThan(600);
});
