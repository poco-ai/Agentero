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

function normalize(translate: Record<string, unknown>) {
	applyExternalSettings({
		...DEFAULT_SETTINGS,
		translate: {
			...DEFAULT_SETTINGS.translate,
			...translate,
		},
	} as AppSettings);
	return loadSettings().translate;
}

describe("translate prompt settings", () => {
	it("keeps user glossaries separated by target language and ignores malformed external entries", () => {
		const settings = normalize({
			glossaries: {
				"zh-CN": "LLM→大模型",
				en: '{"大模型":"LLM"}',
				de: "LLM→Modell",
			},
		});
		expect(settings.glossaries).toEqual({
			"zh-CN": "LLM→大模型",
			en: '{"大模型":"LLM"}',
		});
		expect(
			normalize({ glossaries: { "zh-CN": "{broken" } }).glossaries,
		).toEqual({});
		expect(normalize({}).glossaries).toEqual({});
	});

	it("preserves extra JSON through settings normalization and defaults legacy settings", () => {
		const extraRequestBody = '{"thinking":{"type":"disabled"}}';
		const cfg = normalize({
			providerConfigs: {
				openaiCompatible: {
					apiKey: "test",
					model: "custom",
					extraRequestBody,
				},
			},
		}).providerConfigs.openaiCompatible;
		expect(cfg?.extraRequestBody).toBe(extraRequestBody);
		const legacy = normalize({
			providerConfigs: {
				openaiCompatible: { apiKey: "test", model: "custom" },
			},
		}).providerConfigs.openaiCompatible;
		expect(legacy?.extraRequestBody).toBe("");
	});
	it("keeps a legacy custom prompt and empty system and user fields", () => {
		const settings = normalize({ customPrompt: "Be terse." });
		expect(settings.customPrompt).toBe("Be terse.");
		expect(settings.customSystem).toBe("");
		expect(settings.customUser).toBe("");
	});

	it("strips unknown placeholders and caps length", () => {
		const settings = normalize({
			customPrompt: "{{audience}} only",
			customSystem: `Style {{tone}} for {{targetLang}}.${"x".repeat(9000)}`,
			customUser: "<<<{{ text }}>>> {{mood}}",
		});
		expect(settings.customPrompt).toBe(" only");
		expect(settings.customSystem.startsWith("Style  for {{targetLang}}.")).toBe(
			true,
		);
		expect(settings.customSystem.length).toBe(8000);
		expect(settings.customSystem).not.toContain("{{tone}}");
		expect(settings.customUser).toBe("<<<{{ text }}>>> ");
	});
});
