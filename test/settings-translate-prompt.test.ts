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
	it("falls back from removed providers without losing Agent settings", () => {
		const settings = normalize({
			provider: "web-ai",
			agentId: "saved-agent",
			modelId: "saved-model",
			customPrompt: "Keep formulas unchanged.",
		});
		expect(settings.provider).toBe(DEFAULT_SETTINGS.translate.provider);
		expect(settings.agentId).toBe("saved-agent");
		expect(settings.modelId).toBe("saved-model");
		expect(settings.customPrompt).toBe("Keep formulas unchanged.");
		expect(normalize({ provider: "agent" }).provider).toBe("agent");
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
