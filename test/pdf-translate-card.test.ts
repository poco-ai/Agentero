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

async function renderCard(
	onHide = vi.fn(),
	onTogglePin = vi.fn(),
	screen: Parameters<typeof TranslateCard>[0]["screen"] = { x: 600, y: 200 },
	text = result,
	sourceText?: string,
) {
	await act(() =>
		root.render(
			createElement(
				MotionConfig,
				{ isStatic: true },
				createElement(TranslateCard, {
					screen,
					result: text,
					sourceText,
					streaming: false,
					error: null,
					onOpenSettings: vi.fn(),
					onTogglePin,
					onHide,
				}),
			),
		),
	);
	const card = container.querySelector<HTMLElement>('[role="dialog"]');
	if (!card) throw new Error("Translation card did not render");
	return card;
}

it("opens below the selected lines instead of covering them", async () => {
	const card = await renderCard(vi.fn(), vi.fn(), {
		x: 600,
		y: 200,
		selectionBounds: { left: 500, top: 200, right: 700, bottom: 260 },
	});
	expect(Number.parseFloat(card.style.top)).toBeGreaterThanOrEqual(260);
});

it("keeps the PDF controls interactive, copies the translation, and dismisses on Escape", async () => {
	const onHide = vi.fn();
	const card = await renderCard(onHide);
	const pdfControl = document.createElement("button");
	const onPdfClick = vi.fn();
	pdfControl.addEventListener("click", onPdfClick);
	document.body.append(pdfControl);
	await act(() => {
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
		document.body.dispatchEvent(
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

it("uses P for the pin action and leaves typing, composing and modified keys alone", async () => {
	const onHide = vi.fn();
	const onTogglePin = vi.fn();
	const card = await renderCard(onHide, onTogglePin);
	const input = document.createElement("input");
	document.body.append(input);
	const key = (target: HTMLElement, init: KeyboardEventInit) => {
		const event = new KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			...init,
		});
		target.dispatchEvent(event);
		return event.defaultPrevented;
	};
	expect(key(input, { key: "p" })).toBe(false);
	expect(key(input, { key: "Escape" })).toBe(false);
	expect(key(document.body, { key: "Escape", isComposing: true })).toBe(false);
	expect(key(document.body, { key: "p", ctrlKey: true })).toBe(false);
	expect(key(document.body, { key: "p", repeat: true })).toBe(false);
	expect(onTogglePin).not.toHaveBeenCalled();
	expect(onHide).not.toHaveBeenCalled();

	const pin = card.querySelector<HTMLButtonElement>('[aria-keyshortcuts="P"]');
	expect(pin).not.toBeNull();
	await act(() => expect(key(document.body, { key: "p" })).toBe(true));
	expect(onTogglePin).toHaveBeenCalledOnce();
	await act(() => pin?.click());
	expect(onTogglePin).toHaveBeenCalledTimes(2);
});

it("copies the latest translation with C and shows the copied feedback", async () => {
	const writeText = vi
		.spyOn(navigator.clipboard, "writeText")
		.mockResolvedValue();
	const card = await renderCard();
	const copy = card.querySelector<HTMLButtonElement>('[aria-keyshortcuts="C"]');
	expect(copy).not.toBeNull();
	const key = () =>
		document.body.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "c",
				bubbles: true,
				cancelable: true,
			}),
		);
	await act(async () => expect(key()).toBe(false));
	expect(writeText).toHaveBeenCalledExactlyOnceWith(result);
	expect(copy?.getAttribute("aria-label")).toBe("selection.copied");

	await renderCard(vi.fn(), vi.fn(), { x: 600, y: 200 }, "更新后的译文。");
	await act(async () => expect(key()).toBe(false));
	expect(writeText).toHaveBeenLastCalledWith("更新后的译文。");
});

it("leaves C to text fields, other dialogs, composing and modified keys", async () => {
	const writeText = vi
		.spyOn(navigator.clipboard, "writeText")
		.mockResolvedValue();
	await renderCard();
	const input = document.createElement("input");
	const editor = document.createElement("div");
	editor.setAttribute("contenteditable", "true");
	const dialog = document.createElement("div");
	dialog.setAttribute("role", "dialog");
	document.body.append(input, editor, dialog);
	const key = (target: HTMLElement, init: KeyboardEventInit = {}) => {
		const event = new KeyboardEvent("keydown", {
			key: "c",
			bubbles: true,
			cancelable: true,
			...init,
		});
		target.dispatchEvent(event);
		return event.defaultPrevented;
	};
	expect(key(input)).toBe(false);
	expect(key(editor)).toBe(false);
	expect(key(dialog)).toBe(false);
	for (const init of [
		{ isComposing: true },
		{ repeat: true },
		{ ctrlKey: true },
		{ metaKey: true },
		{ altKey: true },
		{ shiftKey: true },
	]) {
		expect(key(document.body, init)).toBe(false);
	}
	expect(writeText).not.toHaveBeenCalled();
});

it("leaves C alone without a translation or after the card closes", async () => {
	const writeText = vi
		.spyOn(navigator.clipboard, "writeText")
		.mockResolvedValue();
	const card = await renderCard(vi.fn(), vi.fn(), { x: 600, y: 200 }, " ");
	expect(card.querySelector('[aria-keyshortcuts="C"]')).toBeNull();
	const key = () =>
		document.body.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "c",
				bubbles: true,
				cancelable: true,
			}),
		);
	expect(key()).toBe(true);
	await renderCard();
	await act(() => root.render(null));
	expect(key()).toBe(true);
	expect(writeText).not.toHaveBeenCalled();
});

it("clamps dragging using the resized dimensions and keeps the offset as the page scrolls", async () => {
	const card = await renderCard(vi.fn(), vi.fn(), {
		x: 600,
		y: 200,
		selectionBounds: { left: 500, top: 200, right: 700, bottom: 260 },
	});
	const handle = card.querySelector<HTMLElement>("header");
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
	await renderCard(vi.fn(), vi.fn(), {
		x: 600,
		y: 100,
		selectionBounds: { left: 500, top: 100, right: 700, bottom: 160 },
	});
	expect(card.style.left).toBe("588px");
	expect(card.style.top).toBe("328px");
});

it("opens at the width the user last dragged it to, still content-sized", async () => {
	const map = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
		removeItem: (key: string) => {
			map.delete(key);
		},
	});
	map.set("agentero-pdf-card-widths", JSON.stringify({ translate: 440 }));

	const card = await renderCard();
	expect(card.style.width).toBe("440px");
	// Height stays content-sized: a remembered height would leave blank space
	// under shorter translations.
	expect(card.style.height).toBe("");
});

it("shows a dictionary headword and accepts a plain MT gloss with existing actions", async () => {
	const onHide = vi.fn();
	const onPin = vi.fn();
	const card = await renderCard(
		onHide,
		onPin,
		{ x: 600, y: 200 },
		"分辨率",
		"resolution",
	);
	expect(card.getAttribute("aria-label")).toBe("selection.dictionaryTitle");
	expect(card.textContent).toContain("resolution");
	expect(card.textContent).toContain("分辨率");
	expect(card.querySelector('[aria-keyshortcuts="P"]')).not.toBeNull();
	const writeText = vi
		.spyOn(navigator.clipboard, "writeText")
		.mockResolvedValue();
	await act(() =>
		card.querySelector<HTMLButtonElement>('[aria-keyshortcuts="C"]')?.click(),
	);
	expect(writeText).toHaveBeenCalledWith("分辨率");
});
it("keeps a sentence in the translation card", async () => {
	const card = await renderCard(
		vi.fn(),
		vi.fn(),
		{ x: 600, y: 200 },
		"该图像具有高分辨率。",
		"The image has high resolution.",
	);
	expect(card.getAttribute("aria-label")).toBe("selection.translateTitle");
	expect(card.textContent).not.toContain("The image has high resolution.");
});
