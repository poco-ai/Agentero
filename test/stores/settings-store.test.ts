import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type AppSettings,
	cloneSettings,
	DEFAULT_SETTINGS,
} from "@/lib/settings";
import {
	applyExternalSettings,
	loadSettings,
	saveSettings,
	settingsStore,
} from "@/stores/settings-store";

function reset() {
	settingsStore.store.setState({ settings: cloneSettings(DEFAULT_SETTINGS) });
}

beforeEach(reset);
afterEach(reset);

describe("settings-store", () => {
	it("loadSettings returns a defaults clone that callers cannot mutate", () => {
		const s = loadSettings();
		expect(s).toEqual(DEFAULT_SETTINGS);
		s.editorFontSize = 99;
		expect(loadSettings().editorFontSize).toBe(DEFAULT_SETTINGS.editorFontSize);
	});

	it("saveSettings commits a normalized snapshot", () => {
		saveSettings({
			...DEFAULT_SETTINGS,
			translatorBaseUrl: "https://example.test/",
			theme: "dark",
		});
		const s = loadSettings();
		expect(s.translatorBaseUrl).toBe("https://example.test");
		expect(s.theme).toBe("dark");
	});

	it("coerces invalid enum values back to defaults", () => {
		const raw = {
			...DEFAULT_SETTINGS,
			theme: "neon",
			locale: "fr",
		} as unknown as AppSettings;
		applyExternalSettings(raw);
		const s = loadSettings();
		expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
		expect(s.locale).toBe(DEFAULT_SETTINGS.locale);
	});

	it("applyExternalSettings updates the live snapshot", () => {
		applyExternalSettings({ ...DEFAULT_SETTINGS, editorFontSize: 20 });
		expect(loadSettings().editorFontSize).toBe(20);
	});

	it("applyExternalSettings skips no-op echoes without notifying", () => {
		const onChange = vi.fn();
		const unsub = settingsStore.store.subscribe((st) => st.settings, onChange);

		applyExternalSettings(cloneSettings(DEFAULT_SETTINGS)); // equals current
		expect(onChange).not.toHaveBeenCalled();

		applyExternalSettings({ ...DEFAULT_SETTINGS, editorFontSize: 20 });
		expect(onChange).toHaveBeenCalledTimes(1);

		unsub();
	});

	it("notifies selector subscribers only when the selected field changes", () => {
		const onFont = vi.fn();
		const unsub = settingsStore.store.subscribe(
			(st) => st.settings.editorFontSize,
			onFont,
		);

		saveSettings({ ...DEFAULT_SETTINGS, showEditorToolbar: false }); // font unchanged
		expect(onFont).not.toHaveBeenCalled();

		saveSettings({ ...DEFAULT_SETTINGS, editorFontSize: 18 });
		expect(onFont).toHaveBeenCalledWith(18, DEFAULT_SETTINGS.editorFontSize);

		unsub();
	});
});
