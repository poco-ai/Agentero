// @vitest-environment happy-dom

import i18next from "i18next";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyboardPane } from "@/components/settings/panes/keyboard-pane";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
	type ShortcutHandlers,
	useAppShortcuts,
} from "@/hooks/use-app-shortcuts";
import enSettings from "@/i18n/locales/en/settings.json";
import enShortcuts from "@/i18n/locales/en/shortcuts.json";
import zhSettings from "@/i18n/locales/zh-CN/settings.json";
import zhShortcuts from "@/i18n/locales/zh-CN/shortcuts.json";
import type { AppSettings } from "@/lib/settings";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";
import type { ShortcutOverrides } from "@/lib/settings/shortcut-bindings";
import { SHORTCUTS } from "@/lib/shell/shortcuts";

const storage = vi.hoisted(() => ({ overrides: {} as ShortcutOverrides }));
const native = vi.hoisted(() => ({
	enabled: false,
	setRecording: vi.fn(),
	notifyError: vi.fn(),
}));
vi.mock("@/lib/core/tauri", () => ({
	getPlatformOS: () => "macos",
	isTauri: () => native.enabled,
}));
vi.mock("@/lib/core/bindings", () => ({
	commands: { setMenuShortcutRecording: native.setRecording },
}));
vi.mock("@/lib/core/notify", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/core/notify")>()),
	notifyError: native.notifyError,
}));
vi.mock("@/lib/settings/store", async () => {
	const { DEFAULT_SETTINGS } = await import("@/lib/settings/defaults");
	return {
		loadSettings: () => ({
			...DEFAULT_SETTINGS,
			shortcutOverrides: storage.overrides,
		}),
		saveSettings: (settings: { shortcutOverrides: ShortcutOverrides }) => {
			storage.overrides = settings.shortcutOverrides;
		},
		subscribeSettings: vi.fn(),
	};
});

const i18n = i18next.createInstance();
const appShortcut = vi.fn();
const handlers = Object.fromEntries(
	SHORTCUTS.map(({ id }) => [id, appShortcut]),
) as ShortcutHandlers;

const saveSettings = vi.fn((settings: AppSettings) => {
	storage.overrides = settings.shortcutOverrides;
});
let patchSettings: (patch: Partial<AppSettings>) => void;

function Fixture() {
	useAppShortcuts(true, handlers);
	const [settings, setSettings] = useState<AppSettings>({
		...DEFAULT_SETTINGS,
	});
	patchSettings = (patch) => {
		const next = { ...settings, ...patch };
		saveSettings(next);
		setSettings(next);
	};
	return createElement(KeyboardPane, {
		settings,
		shortcutOverrides: settings.shortcutOverrides,
		patch: patchSettings,
	});
}
let root: Root;
let container: HTMLDivElement;

function button(label: string) {
	const result = Array.from(container.querySelectorAll("button")).find(
		(element) =>
			element.getAttribute("aria-label") === label ||
			element.textContent === label,
	);
	if (!result) throw new Error(`Missing button: ${label}`);
	return result;
}

const editor = (command = "Settings…") =>
	button(`Change shortcut for ${command}`);

async function click(element: HTMLElement) {
	await act(async () => element.click());
}

async function press(key: string, init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
		...init,
	});
	await act(async () => document.activeElement?.dispatchEvent(event));
	return event;
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	storage.overrides = {};
	appShortcut.mockClear();
	native.enabled = false;
	native.setRecording.mockReset();
	native.setRecording.mockResolvedValue({ status: "ok", data: null });
	native.notifyError.mockClear();
	saveSettings.mockClear();
	await i18n.init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "settings",
		interpolation: { escapeValue: false },
		resources: {
			en: { settings: enSettings, shortcuts: enShortcuts },
			"zh-CN": { settings: zhSettings, shortcuts: zhShortcuts },
		},
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root.render(
			createElement(
				I18nextProvider,
				{ i18n },
				createElement(TooltipProvider, null, createElement(Fixture)),
			),
		),
	);
});

afterEach(async () => {
	await act(async () => root.unmount());
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe("editable keyboard settings", () => {
	it("hides restore until the shortcut has a user override", async () => {
		expect(
			container.querySelector('[aria-label="Restore default for Settings…"]'),
		).toBeNull();
		await click(button("Unbind Settings…"));
		expect(button("Restore default for Settings…")).toBeTruthy();
	});

	it("toggles element hints without touching shortcut overrides", async () => {
		const hint = container.querySelector(
			'[role="switch"]',
		) as HTMLButtonElement | null;
		if (!hint) throw new Error("Missing element hint switch");
		expect(hint.getAttribute("aria-checked")).toBe("true");
		await click(hint);
		expect(saveSettings).toHaveBeenLastCalledWith(
			expect.objectContaining({ hintModeEnabled: false }),
		);
		expect(storage.overrides).toEqual({});
		expect(hint.getAttribute("aria-checked")).toBe("false");
	});

	it("filters rows by command text or a typed or pressed chord", async () => {
		const input = container.querySelector(
			"[data-shortcut-search]",
		) as HTMLInputElement;
		const setValue = async (value: string) => {
			await act(async () => {
				const prototype = Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				);
				prototype?.set?.call(input, value);
				input.dispatchEvent(new Event("input", { bubbles: true }));
			});
		};
		await setValue("Zoom in");
		expect(container.textContent).toContain("Zoom in");
		expect(container.textContent).not.toContain("Settings…");
		await setValue("cmd+l");
		expect(container.textContent).toContain("Show / hide chat sidebar");
		expect(container.textContent).not.toContain("Zoom in");
		await setValue("");
		input.focus();
		await act(async () =>
			input.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "l",
					code: "KeyL",
					metaKey: true,
					bubbles: true,
					cancelable: true,
				}),
			),
		);
		expect(container.textContent).toContain("Show / hide chat sidebar");
		expect(container.textContent).not.toContain("Quick open");
		expect(input.value.toLowerCase()).toContain("l");
	});

	it("retains shortcut changes when another settings pane saves the shared snapshot", async () => {
		await click(editor());
		await press("F6");
		await act(async () => patchSettings({ editorFontSize: 18 }));
		expect(saveSettings).toHaveBeenLastCalledWith(
			expect.objectContaining({
				editorFontSize: 18,
				shortcutOverrides: expect.objectContaining({
					settings: {
						key: "F6",
						meta: false,
						ctrl: false,
						alt: false,
						shift: false,
					},
				}),
			}),
		);
		expect(editor().textContent).toBe("F6");
		expect(native.setRecording).not.toHaveBeenCalled();
	});
	it("records and persists a chord without dispatching it to bubbling app handlers", async () => {
		const appHandler = vi.fn();
		window.addEventListener("keydown", appHandler);
		try {
			await click(editor());
			expect(editor().dataset.shortcutRecording).toBe("true");
			const event = await press("j", { code: "KeyJ", metaKey: true });
			expect(event.defaultPrevented).toBe(true);
			expect(appHandler).not.toHaveBeenCalled();
			expect(appShortcut).not.toHaveBeenCalled();
			expect(storage.overrides.settings).toMatchObject({
				key: "j",
				meta: true,
			});
			expect(editor().getAttribute("aria-pressed")).toBe("false");
			expect(editor().textContent).toContain("J");
		} finally {
			window.removeEventListener("keydown", appHandler);
		}
	});

	it("does not record modifier-only, unsafe typing, dead, or IME keys", async () => {
		await click(editor());
		await press("Meta", { metaKey: true });
		expect(container.querySelector('[role="alert"]')).toBeNull();
		for (const [key, init] of [
			["j", {}],
			["J", { shiftKey: true }],
			["c", { metaKey: true }],
			["Dead", { altKey: true }],
			["j", { metaKey: true, isComposing: true }],
		] as const) {
			await press(key, init);
			expect(storage.overrides).toEqual({});
			expect(container.querySelector('[role="alert"]')?.textContent).toBe(
				enShortcuts.invalid,
			);
			expect(editor().getAttribute("aria-pressed")).toBe("true");
		}
		await press("F6");
		expect(storage.overrides.settings).toMatchObject({ key: "F6" });
	});

	it("shows the translated owner of conflicting chords without saving", async () => {
		await click(editor());
		await press("p", { metaKey: true });
		expect(appShortcut).not.toHaveBeenCalled();
		expect(storage.overrides).toEqual({});
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			enShortcuts.labels.quickOpen,
		);
		await act(async () => i18n.changeLanguage("zh-CN"));
		await press("p", { metaKey: true });
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			zhShortcuts.labels.quickOpen,
		);
	});

	it.each([
		"Escape",
		"Tab",
	])("cancels on %s without assigning or trapping Tab", async (key) => {
		await click(editor());
		const event = await press(key);
		expect(event.defaultPrevented).toBe(key === "Escape");
		expect(appShortcut).not.toHaveBeenCalled();
		expect(storage.overrides).toEqual({});
		expect(editor().getAttribute("aria-pressed")).toBe("false");
	});

	it("cancels on control blur and window blur", async () => {
		await click(editor());
		await act(async () => editor().blur());
		expect(editor().getAttribute("aria-pressed")).toBe("false");
		await click(editor());
		await act(async () => window.dispatchEvent(new Event("blur")));
		expect(editor().getAttribute("aria-pressed")).toBe("false");
		expect(storage.overrides).toEqual({});
	});

	it("keeps unbound commands listed and supports rebinding and restoring them", async () => {
		await click(button("Unbind Settings…"));
		expect(storage.overrides.settings).toBeNull();
		expect(editor().textContent).toBe(enShortcuts.unbound);
		expect(button("Unbind Settings…").disabled).toBe(true);
		await click(editor());
		await press("F6");
		expect(storage.overrides.settings).toMatchObject({ key: "F6" });
		await click(button("Restore default for Settings…"));
		expect(storage.overrides).toEqual({});
		expect(
			container.querySelector('[aria-label="Restore default for Settings…"]'),
		).toBeNull();
	});

	it("checks restored aliases as well as the default primary chord", async () => {
		await act(async () =>
			patchSettings({
				shortcutOverrides: {
					zoomIn: { key: "F6" },
					quickOpen: { key: "=", meta: true },
				},
			}),
		);
		await click(button("Restore default for Zoom in"));
		expect(storage.overrides.zoomIn).toEqual({ key: "F6" });
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			enShortcuts.labels.quickOpen,
		);
	});

	it("checks collisions before restoring a row, and resets all overrides atomically", async () => {
		await act(async () =>
			patchSettings({
				shortcutOverrides: {
					settings: { key: "F6" },
					quickOpen: { key: ",", meta: true },
				},
			}),
		);
		await click(button("Restore default for Settings…"));
		expect(storage.overrides.settings).toEqual({ key: "F6" });
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			enShortcuts.labels.quickOpen,
		);
		await click(button("Restore all defaults"));
		expect(storage.overrides).toEqual({});
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(button("Restore all defaults").disabled).toBe(true);
	});
});

describe("native shortcut recording", () => {
	beforeEach(() => {
		native.enabled = true;
	});

	it("waits for native suspension before accepting keys and restores on success", async () => {
		let activate!: (result: { status: "ok"; data: null }) => void;
		native.setRecording.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					activate = resolve;
				}),
		);
		await click(editor());
		expect(native.setRecording).toHaveBeenCalledWith(true);
		expect(editor().getAttribute("aria-busy")).toBe("true");
		expect(editor().textContent).toBe(enShortcuts.preparing);
		const event = await press("F6");
		expect(event.defaultPrevented).toBe(true);
		expect(storage.overrides).toEqual({});
		await act(async () => activate({ status: "ok", data: null }));
		expect(editor().getAttribute("aria-busy")).toBe("false");
		await press("F6");
		expect(storage.overrides.settings).toMatchObject({ key: "F6" });
		expect(native.setRecording.mock.calls).toEqual([[true], [false]]);
	});

	it.each([
		"Escape",
		"Tab",
		"blur",
		"window blur",
		"unmount",
	])("restores native shortcuts on %s", async (reason) => {
		await click(editor());
		if (reason === "blur") await act(async () => editor().blur());
		else if (reason === "window blur") {
			await act(async () => window.dispatchEvent(new Event("blur")));
		} else if (reason === "unmount") {
			await act(async () => root.render(null));
		} else await press(reason);
		expect(native.setRecording.mock.calls).toEqual([[true], [false]]);
		expect(storage.overrides).toEqual({});
	});

	it("finishes cancellation before activating another row", async () => {
		let activate!: (result: { status: "ok"; data: null }) => void;
		native.setRecording.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					activate = resolve;
				}),
		);
		await click(editor());
		await press("Escape");
		await click(editor("Zoom in"));
		expect(native.setRecording.mock.calls).toEqual([[true]]);
		await act(async () => activate({ status: "ok", data: null }));
		expect(native.setRecording.mock.calls).toEqual([[true], [false], [true]]);
		expect(editor().getAttribute("aria-pressed")).toBe("false");
		expect(editor("Zoom in").getAttribute("aria-busy")).toBe("false");
	});

	it("restores the menu if unmounted while native activation is pending", async () => {
		let activate!: (result: { status: "ok"; data: null }) => void;
		native.setRecording.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					activate = resolve;
				}),
		);
		await click(editor());
		await act(async () => root.render(null));
		await act(async () => activate({ status: "ok", data: null }));
		expect(native.setRecording.mock.calls).toEqual([[true], [false]]);
		expect(storage.overrides).toEqual({});
	});

	it.each([
		"typed error",
		"rejection",
	])("reports native activation %s and leaves keyboard navigation usable", async (kind) => {
		if (kind === "typed error") {
			native.setRecording.mockResolvedValueOnce({
				status: "error",
				error: "Cannot suspend menu",
			});
		} else
			native.setRecording.mockRejectedValueOnce(
				new Error("Cannot suspend menu"),
			);
		await click(editor());
		expect(native.notifyError).toHaveBeenCalledWith("Cannot suspend menu");
		expect(native.setRecording.mock.calls).toEqual([[true], [false]]);
		expect(editor().getAttribute("aria-pressed")).toBe("false");
		expect(editor().disabled).toBe(false);
		const event = await press("Tab");
		expect(event.defaultPrevented).toBe(false);
		await click(editor());
		await press("F6");
		expect(storage.overrides.settings).toMatchObject({ key: "F6" });
	});

	it("reports restoration failures without leaving the recorder active", async () => {
		await click(editor());
		native.setRecording.mockRejectedValueOnce(new Error("Cannot restore menu"));
		await press("Escape");
		expect(native.notifyError).toHaveBeenCalledWith("Cannot restore menu");
		expect(editor().getAttribute("aria-pressed")).toBe("false");
		expect((await press("Tab")).defaultPrevented).toBe(false);
		await click(editor());
		await press("F6");
		expect(storage.overrides.settings).toMatchObject({ key: "F6" });
	});
});
