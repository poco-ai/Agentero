// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlazaSelectionMenu } from "@/components/plaza/plaza-selection-menu";
import {
	HIGHLIGHT_COLOR_STACK_COLLAPSED_W,
	HIGHLIGHT_COLOR_STACK_EXPANDED_W,
} from "@/components/viewer/pdf/cards/highlight-color-stack";
import { SelectionMenu } from "@/components/viewer/pdf/cards/selection-menu";
import { settingsStore } from "@/lib/settings/react-store";
import type { MenuContribution } from "@/lib/shell/commands/menu-contributions";
import { formatShortcut } from "@/lib/shell/shortcuts";

const originalOverrides = settingsStore.getState().shortcutOverrides;
let english = false;
let contributions: MenuContribution[] = [];

vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init: () => undefined },
	useTranslation: () => ({
		t: (key: string) => {
			if (key === "selection.quickChat")
				return english ? "Quick chat" : "快速对话";
			if (key === "selection.addToChat")
				return english ? "Add to chat" : "加入对话";
			return key;
		},
	}),
}));

vi.mock("@/lib/shell/commands/menu-contributions", () => ({
	visibleMenuContributions: () => contributions,
	activateMenuContribution: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;
let colorWidth: number;
let notifyResize: () => void;

// happy-dom has no layout engine. Supply measured flex boxes with variable
// label widths; the actual component, refs, observer, and positioning all run.
function measuredBox(element: HTMLElement): DOMRect {
	const menu = element.closest<HTMLElement>('[role="toolbar"]');
	if (!menu) return new DOMRect();
	const children = Array.from(menu.children) as HTMLElement[];
	const widths = children.map((child) => {
		if (child.tagName === "FIELDSET") return colorWidth;
		if (child.querySelector("[aria-haspopup]")) return 120;
		if (child.tagName === "BUTTON") {
			return child.querySelector("span")
				? (child.textContent?.length ?? 0) * 7 + 12
				: 28;
		}
		return 5; // separator, including margins
	});
	const width =
		10 +
		widths.reduce((sum, next) => sum + next, 0) +
		(children.length - 1) * 2;
	const right = window.innerWidth - Number.parseFloat(menu.style.right || "0");
	const left = right - width;
	const top = Number.parseFloat(menu.style.top || "0");
	if (element === menu) return new DOMRect(left, top, width, 32);
	const index = children.indexOf(element);
	if (index < 0) return new DOMRect();
	const x =
		left +
		5 +
		widths.slice(0, index).reduce((sum, next) => sum + next, 0) +
		index * 2;
	return element.tagName === "DIV"
		? new DOMRect(x + 2, top + 8, 1, 16)
		: new DOMRect(x, top + 2, widths[index], 28);
}

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

function dividerCenter(menu: HTMLElement): number {
	const divider = menu.querySelector("[data-selection-anchor]");
	if (!divider) throw new Error("Highlight divider did not render");
	const rect = divider.getBoundingClientRect();
	return rect.left + rect.width / 2;
}

beforeEach(() => {
	settingsStore.setState({ shortcutOverrides: originalOverrides });
	english = false;
	contributions = [];
	colorWidth = HIGHLIGHT_COLOR_STACK_COLLAPSED_W;
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("innerWidth", 1200);
	vi.stubGlobal("innerHeight", 800);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				notifyResize = callback;
			}
			observe() {}
			disconnect() {}
		},
	);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		function () {
			return measuredBox(this);
		},
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(() => root.unmount());
	settingsStore.setState({ shortcutOverrides: originalOverrides });
	container.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("anchors the divider after optional actions, locale, and plugin widths change", async () => {
	const menu = await render({
		showTranslate: false,
		onCopy: undefined,
		onNote: vi.fn(),
	});
	expect(dividerCenter(menu)).toBe(500);
	english = true;
	contributions = [
		{
			id: "test",
			menu: "pdf.selection",
			commandId: "test",
			title: "A long plugin action",
		},
	];
	await render({ contributionContext: { vaultPath: null } });
	await act(() => notifyResize());
	expect(dividerCenter(menu)).toBe(500);
	expect(menu.textContent).toContain("A long plugin action");
	expect(
		menu.querySelector('[aria-label="selection.translate"]'),
	).not.toBeNull();
});

it("keeps actions and the divider still throughout color expansion and collapse", async () => {
	const menu = await render();
	const right = menu.style.right;
	const action = menu.querySelector<HTMLElement>(
		'button[aria-label="selection.translate"]',
	);
	if (!action) throw new Error("Translate action did not render");
	const actionLeft = action.getBoundingClientRect().left;
	for (const width of [
		80.25,
		HIGHLIGHT_COLOR_STACK_EXPANDED_W,
		73.5,
		HIGHLIGHT_COLOR_STACK_COLLAPSED_W,
	]) {
		colorWidth = width;
		await act(() => notifyResize());
		expect(menu.style.right).toBe(right);
		expect(dividerCenter(menu)).toBe(500);
		expect(action.getBoundingClientRect().left).toBe(actionLeft);
	}
});

it("reserves the expanded palette at the left edge and clamps to the right edge", async () => {
	const menu = await render({ screen: { x: 0, y: 200 } });
	colorWidth = HIGHLIGHT_COLOR_STACK_EXPANDED_W;
	await act(() => notifyResize());
	expect(menu.getBoundingClientRect().left).toBe(12);
	await render({ screen: { x: 1200, y: 200 } });
	expect(menu.getBoundingClientRect().right).toBe(1188);
	vi.stubGlobal("innerWidth", 700);
	await act(() => window.dispatchEvent(new Event("resize")));
	expect(menu.getBoundingClientRect().right).toBe(688);
});

it("centers surfaces without highlights and retains vertical flipping and clamping", async () => {
	const menu = await render({
		showHighlight: false,
		showTranslate: false,
		screen: { x: 500, y: 0 },
	});
	const rect = menu.getBoundingClientRect();
	expect(rect.left + rect.width / 2).toBe(500);
	expect(menu.style.top).toBe("18px");
	expect(menu.className).toContain("opacity-70");
	await render({ showHighlight: false, screen: { x: 500, y: 1000 } });
	expect(menu.style.top).toBe("756px");
	expect(menu.className).toContain("opacity-70");
});

it("keeps note clicks explicit and opens quick chat through the chat arrow", async () => {
	const onNote = vi.fn();
	const onAsk = vi.fn();
	const onAddToChat = vi.fn();
	const menu = await render({ onNote, onAsk, onAddToChat });
	const note = menu.querySelector<HTMLButtonElement>(
		'[aria-label="selection.note"]',
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
		menu.querySelector<HTMLButtonElement>('[aria-label^="加入对话"]')?.click(),
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
	expect(item?.textContent).toContain("快速对话");
	expect(onAsk).not.toHaveBeenCalled();
	await act(() => item?.click());
	expect(onAsk).toHaveBeenCalledOnce();
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

it("updates Plaza hints and removes disabled bindings without remounting", async () => {
	await act(() =>
		root.render(
			createElement(PlazaSelectionMenu, {
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
	expect(labels()).toEqual([
		formatShortcut(customBindings.quickChat),
		formatShortcut(customBindings.addSelectionToChat),
	]);
	await act(() =>
		settingsStore.setState({
			shortcutOverrides: { quickChat: null, addSelectionToChat: null },
		}),
	);
	expect(labels()).toEqual(["", ""]);
});
