// @vitest-environment happy-dom

import { MotionConfig } from "motion/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranslateCard } from "@/components/viewer/pdf/cards/translate-card";

vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init: () => undefined },
	useTranslation: () => ({ t: (key: string) => key }),
}));

const result = "第一行。\n\n第二行。";
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("innerWidth", 1000);
	vi.stubGlobal("innerHeight", 700);
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

async function renderCard(onHide = vi.fn()) {
	await act(() =>
		root.render(
			createElement(
				MotionConfig,
				{ isStatic: true },
				createElement(TranslateCard, {
					screen: { x: 600, y: 200 },
					result,
					streaming: false,
					error: null,
					onOpenSettings: vi.fn(),
					onTogglePin: vi.fn(),
					onHide,
				}),
			),
		),
	);
	const card = container.querySelector<HTMLElement>('[role="dialog"]');
	if (!card) throw new Error("Translation card did not render");
	return card;
}

it("keeps the PDF controls interactive, copies the translation, and dismisses on Escape", async () => {
	const onHide = vi.fn();
	const card = await renderCard(onHide);
	const pdfControl = document.createElement("button");
	const onPdfClick = vi.fn();
	pdfControl.addEventListener("click", onPdfClick);
	document.body.append(pdfControl);
	// Radix installs its outside pointer listener on the next task.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
		pdfControl.dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true }),
		);
		pdfControl.focus();
		pdfControl.click();
	});
	expect(onPdfClick).toHaveBeenCalledOnce();
	expect(onHide).not.toHaveBeenCalled();

	const writeText = vi
		.spyOn(navigator.clipboard, "writeText")
		.mockResolvedValue();
	const copy = card.querySelector<HTMLButtonElement>(
		'[aria-label="selection.copy"]',
	);
	expect(copy).not.toBeNull();
	await act(async () => copy?.click());
	expect(writeText).toHaveBeenCalledExactlyOnceWith(result);
	expect(copy?.getAttribute("aria-label")).toBe("selection.copied");
	expect(onHide).not.toHaveBeenCalled();

	await act(() => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		);
	});
	expect(onHide).toHaveBeenCalledOnce();
	const close = card.querySelector<HTMLButtonElement>(
		'[aria-label="selection.translateHide"]',
	);
	expect(close).not.toBeNull();
	await act(() => close?.click());
	expect(onHide).toHaveBeenCalledTimes(2);
});

it("keeps the grab offset and clamps dragging using the card's resized dimensions", async () => {
	const card = await renderCard();
	const handle = card.querySelector<HTMLElement>("header > div");
	if (!handle) throw new Error("Missing translation title handle");
	handle.setPointerCapture = vi.fn();
	card.getBoundingClientRect = () =>
		new DOMRect(
			parseFloat(card.style.left),
			parseFloat(card.style.top),
			400,
			260,
		);
	const { left, top } = card.getBoundingClientRect();
	const emitPointer = (type: string, clientX: number, clientY: number) =>
		act(() => {
			handle.dispatchEvent(
				new PointerEvent(type, {
					bubbles: true,
					pointerId: 1,
					clientX,
					clientY,
				}),
			);
		});
	await emitPointer("pointerdown", left + 30, top + 20);
	await emitPointer("pointermove", left + 80, top + 60);
	expect(card.style.left).toBe(`${left + 50}px`);
	expect(card.style.top).toBe(`${top + 40}px`);
	await emitPointer("pointermove", 1100, 800);
	expect(card.style.left).toBe("588px");
	expect(card.style.top).toBe("428px");
	await emitPointer("lostpointercapture", 1100, 800);
	await emitPointer("pointermove", 50, 50);
	expect(card.style.left).toBe("588px");
	expect(card.style.top).toBe("428px");
});
