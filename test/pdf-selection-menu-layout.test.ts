// @vitest-environment happy-dom

import { MotionConfig } from "motion/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SelectionActionMenu } from "@/components/selection/selection-action-menu";
import { SelectionMenu } from "@/components/viewer/pdf/cards/selection-menu";
import { TranslateCard } from "@/components/viewer/pdf/cards/translate-card";
import { HIGHLIGHT_COLORS } from "@/lib/pdf/highlight/palette";
import { settingsStore } from "@/lib/settings/react-store";
import { formatShortcut } from "@/lib/shell/shortcuts";
import { installResizeObserver } from "./helpers/observers";

const originalOverrides = settingsStore.getState().shortcutOverrides;

vi.mock("react-i18next", () => import("./helpers/i18n"));

vi.mock("@/lib/shell/commands/menu-contributions", () => ({
	visibleMenuContributions: () => [],
	activateMenuContribution: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

const props = {
	screen: { x: 500, y: 200 },
	onHighlight: vi.fn(),
	onAsk: vi.fn(),
	onAddToChat: vi.fn(),
	onTranslate: vi.fn(),
	onCopy: async () => true,
};

async function render(
	overrides: Partial<Parameters<typeof SelectionMenu>[0]> = {},
) {
	await act(() =>
		root.render(createElement(SelectionMenu, { ...props, ...overrides })),
	);
	const menu = container.querySelector<HTMLElement>('[role="toolbar"]');
	if (!menu) throw new Error("Selection menu did not render");
	return menu;
}

beforeEach(() => {
	settingsStore.setState({ shortcutOverrides: originalOverrides });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("innerWidth", 1200);
	vi.stubGlobal("innerHeight", 800);
	installResizeObserver();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(() => root.unmount());
	settingsStore.setState({ shortcutOverrides: originalOverrides });
	container.remove();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("uses the same action and shortcut for dictionary lookups", () => {
	const html = renderToStaticMarkup(
		createElement(SelectionMenu, {
			screen: { x: 100, y: 100 },
			onHighlight: vi.fn(),
			onAsk: vi.fn(),
			onAddToChat: vi.fn(),
			onTranslate: vi.fn(),
			showHighlight: true,
			showTranslate: true,
			selectionText: "KV cache",
		}),
	);
	// The dictionary action replaces translation on the same T shortcut.
	expect(html).toContain('aria-label="selection.dictionaryTitle T"');
	expect(html).not.toContain('aria-label="selection.translate T"');
});

it("keeps note clicks explicit and opens quick chat through the chat arrow", async () => {
	const onNote = vi.fn();
	const onAsk = vi.fn();
	const onAddToChat = vi.fn();
	const menu = await render({ onNote, onAsk, onAddToChat });
	const note = menu.querySelector<HTMLButtonElement>(
		'[aria-label="selection.note N"]',
	);
	const trigger = menu.querySelector<HTMLButtonElement>(
		'[aria-haspopup="menu"]',
	);
	if (!note || !trigger) throw new Error("Selection actions missing");
	await act(() =>
		note.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true })),
	);
	expect(onNote).not.toHaveBeenCalled();
	await act(() => note.click());
	expect(onNote).toHaveBeenCalledOnce();
	await act(() =>
		menu
			.querySelector<HTMLButtonElement>('[aria-label^="selection.addToChat"]')
			?.click(),
	);
	expect(onAddToChat).toHaveBeenCalledOnce();
	expect(document.querySelector('[role="menuitem"]')).toBeNull();
	await act(() =>
		trigger.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				pointerType: "mouse",
			}),
		),
	);
	const item = document.querySelector<HTMLElement>('[role="menuitem"]');
	expect(item?.textContent).toContain("selection.quickChat");
	expect(onAsk).not.toHaveBeenCalled();
	await act(() => item?.click());
	expect(onAsk).toHaveBeenCalledOnce();
});

it("moves bookmark into the more menu while keeping its B shortcut", async () => {
	const onBookmark = vi.fn();
	const menu = await render({ onBookmark });
	expect(menu.querySelector('[aria-label="selection.bookmark B"]')).toBeNull();
	expect(await pressKey("b")).toBe(true);
	expect(onBookmark).toHaveBeenCalledOnce();

	const trigger = menu.querySelector<HTMLButtonElement>(
		'[aria-haspopup="menu"]',
	);
	if (!trigger) throw new Error("More menu trigger missing");
	await act(() =>
		trigger.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				pointerType: "mouse",
			}),
		),
	);
	const items = Array.from(
		document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	);
	const bookmark = items.find((item) =>
		item.textContent?.includes("selection.bookmark"),
	);
	expect(bookmark?.textContent).toContain("B");
});

const customBindings = {
	quickChat: { key: "j", meta: true },
	addSelectionToChat: { key: "u", meta: true, shift: true },
};

it("updates PDF quick-chat and add-to-chat hints while its menu is mounted", async () => {
	const menu = await render();
	await act(() =>
		settingsStore.setState({ shortcutOverrides: customBindings }),
	);
	expect(menu.textContent).toContain(
		formatShortcut(customBindings.addSelectionToChat),
	);
	const trigger = menu.querySelector<HTMLButtonElement>(
		'[aria-haspopup="menu"]',
	);
	if (!trigger) throw new Error("Missing chat menu trigger");
	await act(() =>
		trigger.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				pointerType: "mouse",
			}),
		),
	);
	expect(document.querySelector('[role="menuitem"]')?.textContent).toContain(
		formatShortcut(customBindings.quickChat),
	);
	await act(() =>
		settingsStore.setState({
			shortcutOverrides: { quickChat: null, addSelectionToChat: null },
		}),
	);
	expect(menu.querySelector("kbd")?.textContent).toBe("");
	expect(document.querySelector('[role="menuitem"] kbd')?.textContent).toBe("");
});

it("updates shared menu hints and removes disabled bindings without remounting", async () => {
	await act(() =>
		root.render(
			createElement(SelectionActionMenu, {
				screen: props.screen,
				onAsk: vi.fn(),
				onAddToChat: vi.fn(),
			}),
		),
	);
	await act(() =>
		settingsStore.setState({ shortcutOverrides: customBindings }),
	);
	const labels = () =>
		Array.from(container.querySelectorAll("kbd"), (kbd) => kbd.textContent);
	expect(labels()).toEqual([formatShortcut(customBindings.addSelectionToChat)]);
	await act(() =>
		settingsStore.setState({
			shortcutOverrides: { quickChat: null, addSelectionToChat: null },
		}),
	);
	expect(labels()).toEqual([""]);
});

async function pressKey(
	key: string,
	init: KeyboardEventInit = {},
	target = document.body,
) {
	const event = new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
		...init,
	});
	await act(async () => {
		target.dispatchEvent(event);
	});
	return event.defaultPrevented;
}

it("runs the displayed selection actions with single keys and keeps copy feedback", async () => {
	const onTranslate = vi.fn();
	const onCopy = vi.fn(async () => true);
	const onNote = vi.fn();
	const onBookmark = vi.fn();
	const onHighlight = vi.fn();
	const menu = await render({
		onTranslate,
		onCopy,
		onNote,
		onBookmark,
		onHighlight,
	});
	for (const key of ["t", "c", "n", "b", "1", "2", "3", "4", "5"])
		expect(await pressKey(key)).toBe(true);
	expect(onTranslate).toHaveBeenCalledOnce();
	expect(onCopy).toHaveBeenCalledOnce();
	expect(
		menu.querySelector('[aria-keyshortcuts="C"]')?.getAttribute("aria-label"),
	).toBe("selection.copied C");
	expect(onNote).toHaveBeenCalledOnce();
	expect(onBookmark).toHaveBeenCalledOnce();
	expect(onHighlight.mock.calls.map(([color]) => color)).toEqual(
		HIGHLIGHT_COLORS,
	);
});

it("ignores typing, IME, modified keys, repeats and other dialogs", async () => {
	const onTranslate = vi.fn();
	await render({ onTranslate });
	const input = document.createElement("input");
	const editor = document.createElement("div");
	editor.setAttribute("contenteditable", "true");
	const dialog = document.createElement("div");
	dialog.setAttribute("role", "dialog");
	document.body.append(input, editor, dialog);
	for (const target of [input, editor, dialog])
		expect(await pressKey("t", {}, target)).toBe(false);
	for (const init of [
		{ isComposing: true },
		{ repeat: true },
		{ metaKey: true },
		{ ctrlKey: true },
		{ altKey: true },
		{ shiftKey: true },
	])
		expect(await pressKey("t", init)).toBe(false);
	expect(onTranslate).not.toHaveBeenCalled();
	expect(await pressKey("t")).toBe(true);
	expect(onTranslate).toHaveBeenCalledOnce();
});

it("only handles visible actions and stops handling keys after dismissal", async () => {
	await render({
		showHighlight: false,
		showTranslate: false,
		onCopy: undefined,
		onNote: vi.fn(),
	});
	for (const key of ["t", "c", "n", "b", "1"])
		expect(await pressKey(key)).toBe(false);
	await act(() => root.render(null));
	expect(await pressKey("t")).toBe(false);
});

it.each([
	true,
	false,
])("copies the new selection while a translation stays open (menu first: %s)", async (menuFirst) => {
	const writeText = vi
		.spyOn(navigator.clipboard, "writeText")
		.mockResolvedValue();
	const onCopy = vi.fn(async () => true);
	const menu = createElement(SelectionMenu, { ...props, key: "menu", onCopy });
	const card = createElement(TranslateCard, {
		key: "translation",
		screen: props.screen,
		result: "previous translation",
		streaming: false,
		error: null,
		onHide: vi.fn(),
		onOpenSettings: vi.fn(),
	});
	const scene = (children: ReturnType<typeof createElement>[]) =>
		createElement(MotionConfig, { isStatic: true }, children);
	await act(() => root.render(scene(menuFirst ? [menu, card] : [card, menu])));
	expect(await pressKey("c")).toBe(true);
	expect(onCopy).toHaveBeenCalledOnce();
	expect(writeText).not.toHaveBeenCalled();
	await act(() => root.render(scene([card])));
	expect(await pressKey("c")).toBe(true);
	expect(writeText).toHaveBeenCalledExactlyOnceWith("previous translation");
});

it("updates the word action to translation immediately when dictionary mode is off", async () => {
	const original = settingsStore.getState().translate;
	try {
		await act(() =>
			settingsStore.setState({
				translate: { ...original, dictionary: { mode: "auto" } },
			}),
		);
		await render({ selectionText: "attention" });
		const action = () =>
			container.querySelector<HTMLButtonElement>('[aria-keyshortcuts="T"]');
		expect(action()?.getAttribute("aria-label")).toContain(
			"selection.dictionaryTitle",
		);
		await act(() =>
			settingsStore.setState({
				translate: { ...original, dictionary: { mode: "off" } },
			}),
		);
		expect(action()?.getAttribute("aria-label")).toContain(
			"selection.translate",
		);
		await act(() =>
			settingsStore.setState({
				translate: { ...original, dictionary: { mode: "offline-first" } },
			}),
		);
		expect(action()?.getAttribute("aria-label")).toContain(
			"selection.dictionaryTitle",
		);
	} finally {
		await act(() => settingsStore.setState({ translate: original }));
	}
});
