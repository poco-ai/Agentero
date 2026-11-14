// @vitest-environment happy-dom

import { MotionConfig } from "motion/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SelectionMenu } from "@/components/viewer/pdf/cards/selection-menu";
import { PdfVimKeyHandler } from "@/components/viewer/pdf/viewport/pdf-vim-key-handler";
import { HIGHLIGHT_COLORS } from "@/lib/pdf/highlight/palette";

const mocks = vi.hoisted(() => ({
	viewportRef: { current: null as HTMLDivElement | null },
	scroll: {
		scrollToPage: vi.fn(),
		scrollToNextPage: vi.fn(),
		scrollToPreviousPage: vi.fn(),
	},
}));

vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init: () => undefined },
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@embedpdf/plugin-scroll/react", () => ({
	useScrollCapability: () => ({
		provides: { forDocument: () => mocks.scroll },
	}),
}));
vi.mock("@embedpdf/plugin-viewport/react", () => ({
	useViewportElement: () => mocks.viewportRef,
}));
vi.mock("@/hooks/use-app-stores", () => ({ useSettings: () => "vertical" }));
vi.mock("@/lib/settings", () => ({
	loadSettings: () => ({ pdfVimKeys: true, vimMode: true }),
}));
vi.mock("@/lib/pdf/scroll-sync", () => ({ handleScrollSyncIntent: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let host: HTMLDivElement;
const hostRef = { current: null as HTMLDivElement | null };
const onHighlight = vi.fn();
const onNote = vi.fn();
const onFindNext = vi.fn();

async function render(showMenu: boolean, showHighlight = true) {
	await act(() =>
		root.render(
			createElement(
				MotionConfig,
				{ isStatic: true },
				createElement(PdfVimKeyHandler, {
					documentId: "pdf",
					active: true,
					hostRef,
					totalPages: 20,
					onFindNext,
				}),
				showMenu
					? createElement(SelectionMenu, {
							screen: { x: 500, y: 200 },
							onHighlight,
							onNote,
							onAsk: vi.fn(),
							onAddToChat: vi.fn(),
							onTranslate: vi.fn(),
							showHighlight,
						})
					: null,
			),
		),
	);
}

async function press(key: string, init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
		...init,
	});
	await act(() => host.dispatchEvent(event));
	return event.defaultPrevented;
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	localStorage.clear();
	container = document.createElement("div");
	host = document.createElement("div");
	host.setAttribute("data-pdf-viewport", "");
	document.body.append(container, host);
	mocks.viewportRef.current = host;
	hostRef.current = host;
	root = createRoot(container);
	// The reader's capture listener is already registered when a selection opens.
	await render(false);
});

afterEach(async () => {
	await act(() => root.unmount());
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

it("selects every color without hovering while Vim reading keys are enabled", async () => {
	await render(true);
	const palette = container.querySelector("fieldset");
	expect(palette?.style.width).toBe("56px");
	for (const key of ["1", "2", "3", "4", "5"])
		expect(await press(key)).toBe(true);
	expect(onHighlight.mock.calls.map(([color]) => color)).toEqual(
		HIGHLIGHT_COLORS,
	);
	expect(palette?.style.width).toBe("56px");
	expect(mocks.scroll.scrollToPage).not.toHaveBeenCalled();
	expect(await press("n")).toBe(true);
	expect(onNote).toHaveBeenCalledOnce();
	expect(onFindNext).not.toHaveBeenCalled();
});

async function rightClickSwatch(color: string) {
	const swatch =
		container.querySelectorAll<HTMLButtonElement>("fieldset button")[
			HIGHLIGHT_COLORS.indexOf(color as (typeof HIGHLIGHT_COLORS)[number])
		];
	if (!swatch) throw new Error(`Missing ${color} swatch`);
	await act(() =>
		swatch.dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
		),
	);
}

it("right-click flips only the swatch it targets", async () => {
	await render(true);
	await rightClickSwatch("blue");
	expect(await press("1")).toBe(true);
	expect(onHighlight).toHaveBeenLastCalledWith("yellow", "highlight");
	expect(await press("3")).toBe(true);
	expect(onHighlight).toHaveBeenLastCalledWith("blue", "underline");
});

it("remembers each swatch's shape across selection menus", async () => {
	await render(true);
	await rightClickSwatch("green");
	await render(false);
	await render(true);
	expect(await press("3")).toBe(true);
	expect(onHighlight).toHaveBeenLastCalledWith("blue", "highlight");
	expect(await press("2")).toBe(true);
	expect(onHighlight).toHaveBeenLastCalledWith("green", "underline");
});

it("forces underline with the Option+digit prefix without changing the swatch shape", async () => {
	await render(true);
	// macOS composes ⌥1 into "¡"; the physical code still identifies the key.
	expect(await press("¡", { code: "Digit1", altKey: true })).toBe(true);
	expect(onHighlight).toHaveBeenCalledExactlyOnceWith("yellow", "underline");
	// Notes follow the forced shape.
	expect(await press("n")).toBe(true);
	expect(onNote).toHaveBeenLastCalledWith("underline");
	// Bare digits keep the swatch's remembered shape.
	expect(await press("1")).toBe(true);
	expect(onHighlight).toHaveBeenLastCalledWith("yellow", "highlight");
	expect(mocks.scroll.scrollToPage).not.toHaveBeenCalled();
});

it("keeps the Option+digit underline independent of a right-clicked swatch", async () => {
	await render(true);
	await rightClickSwatch("green");
	// Windows/Linux keep the digit as event.key under Alt.
	expect(await press("2", { code: "Digit2", altKey: true })).toBe(true);
	expect(onHighlight).toHaveBeenLastCalledWith("green", "underline");
	expect(await press("2")).toBe(true);
	expect(onHighlight).toHaveBeenLastCalledWith("green", "underline");
});

it("clears the Vim page prefix when a selection action takes over and restores navigation on close", async () => {
	expect(await press("9")).toBe(true);
	await render(true);
	expect(await press("2")).toBe(true);
	expect(onHighlight).toHaveBeenCalledExactlyOnceWith("green", "highlight");
	await render(false);
	await press("G", { shiftKey: true });
	expect(mocks.scroll.scrollToPage).toHaveBeenLastCalledWith({
		pageNumber: 20,
		behavior: "instant",
	});
	await press("3");
	await press("G", { shiftKey: true });
	expect(mocks.scroll.scrollToPage).toHaveBeenLastCalledWith({
		pageNumber: 3,
		behavior: "instant",
	});
});

it("keeps Vim number navigation when the selection has no highlight buttons", async () => {
	await render(true, false);
	await press("4");
	await press("G", { shiftKey: true });
	expect(onHighlight).not.toHaveBeenCalled();
	expect(mocks.scroll.scrollToPage).toHaveBeenCalledExactlyOnceWith({
		pageNumber: 4,
		behavior: "instant",
	});
});

it("jumps to the numbered page after the complete physical Shift+G key sequence", async () => {
	await press("1", { code: "Digit1" });
	await press("2", { code: "Digit2" });
	expect(await press("Shift", { code: "ShiftLeft", shiftKey: true })).toBe(
		false,
	);
	expect(mocks.scroll.scrollToPage).not.toHaveBeenCalled();
	await press("G", { code: "KeyG", shiftKey: true });
	expect(mocks.scroll.scrollToPage).toHaveBeenCalledExactlyOnceWith({
		pageNumber: 12,
		behavior: "instant",
	});
});
