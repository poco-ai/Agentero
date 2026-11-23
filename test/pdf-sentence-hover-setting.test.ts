import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";
import { applyExternalSettings, loadSettings } from "@/lib/settings/store";
import type { AppSettings } from "@/lib/settings/types";

vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => false,
	isMacOS: () => false,
	isMobileApp: () => false,
	getPlatformOS: () => "other",
}));

describe("pdf sentence hover setting", () => {
	it("defaults on when a saved snapshot omits the switch or stores a non-boolean", () => {
		const { pdfSentenceHover: _omitted, ...without } = DEFAULT_SETTINGS;
		applyExternalSettings(without as AppSettings);
		expect(loadSettings().pdfSentenceHover).toBe(true);

		applyExternalSettings({
			...DEFAULT_SETTINGS,
			pdfSentenceHover: "yes" as unknown as boolean,
		});
		expect(loadSettings().pdfSentenceHover).toBe(true);
	});

	it("keeps an explicit off choice", () => {
		applyExternalSettings({ ...DEFAULT_SETTINGS, pdfSentenceHover: false });
		expect(loadSettings().pdfSentenceHover).toBe(false);
	});
});

describe("pdf comment display setting", () => {
	it("defaults to the rail when a saved snapshot omits it or stores an unknown mode", () => {
		const { pdfCommentDisplay: _omitted, ...without } = DEFAULT_SETTINGS;
		applyExternalSettings(without as AppSettings);
		expect(loadSettings().pdfCommentDisplay).toBe("rail");

		applyExternalSettings({
			...DEFAULT_SETTINGS,
			pdfCommentDisplay:
				"margin" as unknown as AppSettings["pdfCommentDisplay"],
		});
		expect(loadSettings().pdfCommentDisplay).toBe("rail");
	});

	it("keeps the gutter choice", () => {
		applyExternalSettings({ ...DEFAULT_SETTINGS, pdfCommentDisplay: "gutter" });
		expect(loadSettings().pdfCommentDisplay).toBe("gutter");
	});
});
