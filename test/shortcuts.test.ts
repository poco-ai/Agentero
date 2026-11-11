import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/core/tauri", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/core/tauri")>();
	return {
		...actual,
		getPlatformOS: vi.fn(() => "macos"),
	};
});

import { getPlatformOS } from "@/lib/core/tauri";
import { loadSettings, saveSettings } from "@/lib/settings";
import {
	findShortcutConflict,
	formatShortcut,
	getShortcut,
	isFindShortcut,
	resolveShortcutId,
	shortcutBelongsToTextField,
	shortcutFromEvent,
	validateShortcutBinding,
} from "@/lib/shell/shortcuts";

function keyEvent(init: {
	key: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
}): KeyboardEvent {
	return {
		key: init.key,
		metaKey: init.metaKey ?? false,
		ctrlKey: init.ctrlKey ?? false,
		altKey: init.altKey ?? false,
		shiftKey: init.shiftKey ?? false,
	} as KeyboardEvent;
}

describe("shell shortcuts", () => {
	afterEach(() => {
		saveSettings({ ...loadSettings(), shortcutOverrides: {} });
		vi.mocked(getPlatformOS).mockReturnValue("macos");
	});

	it("resolves Obsidian-style split pane shortcut", () => {
		expect(
			resolveShortcutId(keyEvent({ key: "\\", metaKey: true }), {
				settingsOpen: false,
			}),
		).toBe("splitPane");
		vi.mocked(getPlatformOS).mockReturnValue("windows");
		expect(
			resolveShortcutId(keyEvent({ key: "\\", ctrlKey: true }), {
				settingsOpen: false,
			}),
		).toBe("splitPane");
	});

	it("resolves in-group tab cycling and keeps whole-dock cycling separate", () => {
		expect(
			resolveShortcutId(keyEvent({ key: "Tab", ctrlKey: true }), {
				settingsOpen: false,
			}),
		).toBe("nextGroupTab");
		expect(
			resolveShortcutId(
				keyEvent({ key: "Tab", ctrlKey: true, shiftKey: true }),
				{ settingsOpen: false },
			),
		).toBe("prevGroupTab");
		expect(
			resolveShortcutId(
				keyEvent({ key: "ArrowRight", metaKey: true, altKey: true }),
				{ settingsOpen: false },
			),
		).toBe("nextTab");
		// ⌃Tab stays bindable in Settings.
		expect(validateShortcutBinding({ key: "Tab", ctrl: true })).toBe(true);
	});

	it("resolves the Markdown source chord, including an override and overlay scope", () => {
		const slash = keyEvent({ key: "/", metaKey: true });
		expect(resolveShortcutId(slash, { settingsOpen: false })).toBe(
			"toggleMarkdownSource",
		);
		expect(resolveShortcutId(slash, { settingsOpen: true })).toBeNull();
		vi.mocked(getPlatformOS).mockReturnValue("windows");
		expect(
			resolveShortcutId(keyEvent({ key: "/", ctrlKey: true }), {
				settingsOpen: false,
			}),
		).toBe("toggleMarkdownSource");
		saveSettings({
			...loadSettings(),
			shortcutOverrides: { toggleMarkdownSource: { key: "F8" } },
		});
		expect(
			resolveShortcutId(keyEvent({ key: "/", ctrlKey: true }), {
				settingsOpen: false,
			}),
		).toBeNull();
		expect(
			resolveShortcutId(keyEvent({ key: "F8" }), { settingsOpen: false }),
		).toBe("toggleMarkdownSource");
	});

	it("distinguishes Ctrl and Meta on macOS", () => {
		vi.mocked(getPlatformOS).mockReturnValue("macos");
		expect(
			resolveShortcutId(keyEvent({ key: "ArrowLeft", ctrlKey: true }), {
				settingsOpen: false,
			}),
		).toBeNull();
		expect(
			resolveShortcutId(keyEvent({ key: "\\", ctrlKey: true }), {
				settingsOpen: false,
			}),
		).toBeNull();
		expect(
			resolveShortcutId(keyEvent({ key: "ArrowLeft", metaKey: true }), {
				settingsOpen: false,
			}),
		).toBe("collapseTreeCurrent");
	});

	it("renders the split pane chord", () => {
		expect(formatShortcut({ key: "\\", meta: true })).toContain("\\");
	});

	it("separates reopen tab from the terminal chord", () => {
		expect(
			resolveShortcutId(keyEvent({ key: "t", metaKey: true, shiftKey: true }), {
				settingsOpen: false,
			}),
		).toBe("reopenTab");
		expect(
			resolveShortcutId(keyEvent({ key: "t", metaKey: true, altKey: true }), {
				settingsOpen: false,
			}),
		).toBe("openInTerminal");
	});

	it("binds ⌘K to quick chat and ⇧⌘L to add-to-chat", () => {
		expect(
			resolveShortcutId(keyEvent({ key: "k", metaKey: true }), {
				settingsOpen: false,
			}),
		).toBe("quickChat");
		expect(
			resolveShortcutId(keyEvent({ key: "l", metaKey: true, shiftKey: true }), {
				settingsOpen: false,
			}),
		).toBe("addSelectionToChat");
		expect(
			resolveShortcutId(keyEvent({ key: "a", metaKey: true }), {
				settingsOpen: false,
			}),
		).toBeNull();
	});

	it("leaves ⌘P as quick open", () => {
		expect(
			resolveShortcutId(keyEvent({ key: "p", metaKey: true }), {
				settingsOpen: false,
			}),
		).toBe("quickOpen");
	});

	it("binds ⌘L to toggleChat independently of selection", () => {
		expect(
			resolveShortcutId(keyEvent({ key: "l", metaKey: true }), {
				settingsOpen: false,
			}),
		).toBe("toggleChat");
	});

	it("leaves the ⌘B sidebar alias to focused text fields", () => {
		vi.mocked(getPlatformOS).mockReturnValue("windows");
		expect(
			resolveShortcutId(keyEvent({ key: "b", ctrlKey: true }), {
				settingsOpen: false,
			}),
		).toBe("toggleSidebar");
		const textarea = {
			closest: () => ({}),
		} as unknown as EventTarget;
		expect(
			shortcutBelongsToTextField("toggleSidebar", {
				key: "b",
				target: textarea,
			}),
		).toBe(true);
		expect(
			shortcutBelongsToTextField("toggleSidebar", {
				key: "s",
				target: textarea,
			}),
		).toBe(false);
		expect(
			shortcutBelongsToTextField("toggleSidebar", {
				key: "b",
				target: null,
			}),
		).toBe(false);
	});

	it("binds F11 to borderless fullscreen only on Windows", () => {
		vi.mocked(getPlatformOS).mockReturnValue("windows");
		expect(
			resolveShortcutId(keyEvent({ key: "F11" }), { settingsOpen: false }),
		).toBe("toggleFullscreen");

		vi.mocked(getPlatformOS).mockReturnValue("macos");
		expect(
			resolveShortcutId(keyEvent({ key: "F11" }), { settingsOpen: false }),
		).toBeNull();
	});

	it("keeps macOS native fullscreen out of local find and shell actions", () => {
		const fullscreen = keyEvent({ key: "f", metaKey: true, ctrlKey: true });
		expect(isFindShortcut(fullscreen)).toBe(false);
		expect(resolveShortcutId(fullscreen, { settingsOpen: false })).toBeNull();
		expect(resolveShortcutId(fullscreen, { settingsOpen: true })).toBeNull();
		expect(isFindShortcut(keyEvent({ key: "f", metaKey: true }))).toBe(true);
	});

	it.each([
		{ key: "f" },
		{ key: "f", ctrlKey: true },
		{ key: "f", metaKey: true, shiftKey: true },
		{ key: "f", metaKey: true, altKey: true },
		{ key: "g", metaKey: true },
	])("does not treat other macOS chords as find: %j", (init) => {
		expect(isFindShortcut(keyEvent(init))).toBe(false);
	});

	it.each([
		"windows",
		"linux",
	] as const)("preserves Ctrl+F on %s without Shift or Alt", (platform) => {
		vi.mocked(getPlatformOS).mockReturnValue(platform);
		expect(isFindShortcut(keyEvent({ key: "f", ctrlKey: true }))).toBe(true);
		expect(
			isFindShortcut(keyEvent({ key: "f", ctrlKey: true, shiftKey: true })),
		).toBe(false);
		expect(
			isFindShortcut(keyEvent({ key: "f", ctrlKey: true, altKey: true })),
		).toBe(false);
	});

	it("uses custom bindings immediately and removes primary and alias keys", () => {
		saveSettings({
			...loadSettings(),
			shortcutOverrides: {
				toggleSidebar: { key: "j", meta: true, shift: true },
				toggleChat: null,
			},
		});
		expect(
			resolveShortcutId(keyEvent({ key: "b", metaKey: true }), {
				settingsOpen: false,
			}),
		).toBeNull();
		expect(
			resolveShortcutId(keyEvent({ key: "s", metaKey: true, altKey: true }), {
				settingsOpen: false,
			}),
		).toBeNull();
		expect(
			resolveShortcutId(keyEvent({ key: "l", metaKey: true }), {
				settingsOpen: false,
			}),
		).toBeNull();
		expect(
			resolveShortcutId(keyEvent({ key: "j", metaKey: true, shiftKey: true }), {
				settingsOpen: false,
			}),
		).toBe("toggleSidebar");
		expect(getShortcut("toggleChat")).toBeNull();
	});

	it("finds collisions with defaults, aliases and platform primary modifiers", () => {
		expect(
			findShortcutConflict("toggleChat", { key: "b", meta: true }, {}),
		).toBe("toggleSidebar");
		expect(
			findShortcutConflict(
				"toggleChat",
				{ key: "l", meta: true, shift: true },
				{},
			),
		).toBe("addSelectionToChat");
		expect(
			findShortcutConflict(
				"toggleChat",
				{ key: "l", meta: true, shift: true },
				{ addSelectionToChat: null },
			),
		).toBeNull();
		vi.mocked(getPlatformOS).mockReturnValue("windows");
		expect(
			findShortcutConflict("toggleChat", { key: "p", ctrl: true }, {}),
		).toBe("quickOpen");
	});

	it("allows mutually exclusive dialog scopes and detects overlay-wide conflicts", () => {
		expect(
			findShortcutConflict("closeSheet", { key: "l", meta: true }, {}),
		).toBe("toggleChat");
		vi.mocked(getPlatformOS).mockReturnValue("windows");
		expect(
			findShortcutConflict("closeSheet", { key: "l", meta: true }, {}),
		).toBeNull();
		expect(
			findShortcutConflict("closeSheet", { key: "w", meta: true }, {}),
		).toBe("closeTab");
	});

	it("records platform-aware chords while ignoring composition and modifier keys", () => {
		expect(
			shortcutFromEvent({
				...keyEvent({ key: "Shift", shiftKey: true }),
				code: "ShiftLeft",
			}),
		).toBeNull();
		expect(
			shortcutFromEvent({
				...keyEvent({ key: "k", metaKey: true }),
				code: "KeyK",
				isComposing: true,
			}),
		).toBeNull();
		expect(
			shortcutFromEvent({
				...keyEvent({ key: "å", altKey: true }),
				code: "KeyA",
			}),
		).toMatchObject({ key: "a", alt: true });
		vi.mocked(getPlatformOS).mockReturnValue("windows");
		expect(
			shortcutFromEvent({
				...keyEvent({ key: "L", ctrlKey: true, shiftKey: true }),
				code: "KeyL",
			}),
		).toMatchObject({ key: "l", meta: true, ctrl: false, shift: true });
	});

	it("preserves native editing and rejects bare typing while allowing modified app keys", () => {
		expect(validateShortcutBinding({ key: "l" })).toBe(false);
		expect(validateShortcutBinding({ key: "l", shift: true })).toBe(false);
		expect(validateShortcutBinding({ key: "c", meta: true })).toBe(false);
		expect(validateShortcutBinding({ key: "f", meta: true, ctrl: true })).toBe(
			false,
		);
		expect(validateShortcutBinding({ key: "l", meta: true, shift: true })).toBe(
			true,
		);
		expect(validateShortcutBinding({ key: "F8" })).toBe(true);
		expect(validateShortcutBinding({ key: "Dead", meta: true })).toBe(false);
	});

	it("retains IME composition events", () => {
		expect(
			resolveShortcutId(
				{
					...keyEvent({ key: "l", metaKey: true }),
					isComposing: true,
				} as KeyboardEvent,
				{ settingsOpen: false },
			),
		).toBeNull();
	});

	it("matches composed Option+Command keys using the same normalization as recording", () => {
		const event = {
			...keyEvent({ key: "∆", altKey: true, metaKey: true }),
			code: "KeyJ",
		};
		const binding = shortcutFromEvent(event);
		if (!binding) throw new Error("Expected a recorded chord");
		saveSettings({
			...loadSettings(),
			shortcutOverrides: { toggleChat: binding },
		});
		expect(resolveShortcutId(event, { settingsOpen: false })).toBe(
			"toggleChat",
		);
	});
	it("rejects OS-owned chords and disables semantically invalid stored bindings", () => {
		for (const binding of [
			{ key: "Tab", meta: true },
			{ key: " ", meta: true },
			{ key: "Escape", meta: true, alt: true },
		]) {
			expect(validateShortcutBinding(binding)).toBe(false);
		}
		saveSettings({
			...loadSettings(),
			shortcutOverrides: { settings: { key: "q", meta: true } },
		});
		expect(getShortcut("settings")).toBeNull();
	});

	it("preserves Option typing for native menu actions", () => {
		expect(validateShortcutBinding({ key: "j", alt: true }, "newWindow")).toBe(
			false,
		);
		expect(validateShortcutBinding({ key: "j", alt: true }, "quickChat")).toBe(
			true,
		);
	});

	it("shows modifiers for customized Escape bindings", () => {
		expect(formatShortcut({ key: "Escape", meta: true })).toContain("Esc");
		expect(formatShortcut({ key: "Escape", meta: true })).not.toBe("Esc");
	});
});
