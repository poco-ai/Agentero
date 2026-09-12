import { describe, expect, it, vi } from "vitest";

import { BUILTIN_PROVIDER_ID } from "@/lib/core/builtin";
import {
	isProviderCardConfigurable,
	PARSER_PROVIDERS,
} from "@/lib/pdf/layout/providers";
import {
	DEFAULT_LAYOUT_SETTINGS,
	LAYOUT_BACKENDS,
	LAYOUT_PROVIDER_IDS,
	PARSER_BACKENDS,
} from "@/lib/pdf/layout/settings";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";
import { applyExternalSettings, loadSettings } from "@/lib/settings/store";
import type { AppSettings, EmbeddingSettings } from "@/lib/settings/types";
import { DEFAULT_TRANSLATE_SETTINGS } from "@/lib/translate/defaults";
import { probeFreeMtProviders } from "@/lib/translate/probe";
import { FREE_MT_PROVIDER_IDS } from "@/lib/translate/types";

vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => false,
	isMacOS: () => false,
	isMobileApp: () => false,
	getPlatformOS: () => "other",
}));

/** Push a wire-shaped embedding through the real Host-load normalizer. */
function normalizeEmbedding(raw: Record<string, unknown>): EmbeddingSettings {
	applyExternalSettings({
		...DEFAULT_SETTINGS,
		embedding: raw,
	} as unknown as AppSettings);
	return loadSettings().embedding;
}

describe("built-in provider id", () => {
	it("matches the Host literal", () => {
		expect(BUILTIN_PROVIDER_ID).toBe("agentero");
	});

	it("is a free-MT translate provider and a parser backend", () => {
		expect(FREE_MT_PROVIDER_IDS).toContain("agentero");
		expect(PARSER_BACKENDS).toContain("agentero");
		expect(LAYOUT_PROVIDER_IDS).toContain("agentero");
	});

	it("is never a layout-analysis backend (stays on local ONNX)", () => {
		expect(LAYOUT_BACKENDS).not.toContain("agentero");
	});

	it("renders no credential card (all supports false)", () => {
		const card = PARSER_PROVIDERS.agentero;
		expect(card).not.toBeNull();
		expect(card?.requiresApiKey).toBe(false);
		expect(card?.supportsBaseUrl).toBe(false);
		expect(card?.supportsModel).toBe(false);
		expect(card?.supportsPrompt).toBe(false);
		expect(card?.supportsLanguage).toBe(false);
		expect(card?.supportsOcr).toBe(false);
		expect(card && isProviderCardConfigurable(card)).toBe(false);
		// A real provider card stays configurable.
		const paddle = PARSER_PROVIDERS.paddle;
		expect(paddle && isProviderCardConfigurable(paddle)).toBe(true);
	});

	it("is excluded from free-MT availability probes", async () => {
		const result = await probeFreeMtProviders();
		expect("agentero" in result).toBe(false);
		expect(result.google).toBe(false);
	});
});

describe("defaults (browser-dev, no Host key)", () => {
	it("keeps translate provider and parser backend off the built-in", () => {
		expect(DEFAULT_TRANSLATE_SETTINGS.provider).toBe("tencenttransmart");
		expect(DEFAULT_LAYOUT_SETTINGS.backend).toBe("local");
		expect(DEFAULT_LAYOUT_SETTINGS.parserBackend).toBe("local");
	});

	it("defaults the embedding source to builtin (Host falls through harmlessly)", () => {
		expect(DEFAULT_SETTINGS.embedding.source).toBe("builtin");
	});
});

describe("embedding source migration", () => {
	const cases: Array<[string, Record<string, unknown>, "builtin" | "custom"]> =
		[
			["empty object infers builtin", {}, "builtin"],
			[
				"baseUrl set infers custom",
				{ baseUrl: "https://api.openai.com/v1" },
				"custom",
			],
			["apiKey set infers custom", { apiKey: "sk-secret" }, "custom"],
			[
				"model set infers custom",
				{ model: "text-embedding-3-small" },
				"custom",
			],
			["all-* mask counts as configured", { apiKey: "***********" }, "custom"],
			[
				"explicit builtin wins over fields",
				{ source: "builtin", model: "m" },
				"builtin",
			],
			["explicit custom wins over empty", { source: "custom" }, "custom"],
			[
				"unknown value re-inferred from fields",
				{ source: "weird", baseUrl: "x" },
				"custom",
			],
			["unknown value re-inferred when empty", { source: "weird" }, "builtin"],
			["empty source string infers builtin", { source: "" }, "builtin"],
			[
				"empty source string infers custom",
				{ source: "", model: "m" },
				"custom",
			],
			["case-insensitive BUILTIN", { source: "BUILTIN" }, "builtin"],
			["case-insensitive padded Custom", { source: " Custom " }, "custom"],
		];

	for (const [name, raw, expected] of cases) {
		it(name, () => {
			expect(normalizeEmbedding(raw).source).toBe(expected);
		});
	}

	it("preserves the custom endpoint fields alongside the resolved source", () => {
		const next = normalizeEmbedding({
			source: "",
			baseUrl: "  https://api.openai.com/v1  ",
			model: " text-embedding-3-small ",
		});
		expect(next.source).toBe("custom");
		expect(next.baseUrl).toBe("https://api.openai.com/v1");
		expect(next.model).toBe("text-embedding-3-small");
	});
});

describe("embedding batch size", () => {
	it("keeps the default for fresh installs and legacy settings", () => {
		expect(DEFAULT_SETTINGS.embedding.batchSize).toBe(64);
		expect(normalizeEmbedding({ model: "bge-m3" }).batchSize).toBe(64);
	});

	it.each([
		"builtin",
		"custom",
	])("preserves a manual limit for %s", (source) => {
		const next = normalizeEmbedding({ source, batchSize: 8 });
		expect(next.batchSize).toBe(8);
		expect(next.source).toBe(source);
	});

	it.each([
		0,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		"8",
		null,
	])("falls back to 64 for invalid input %s", (batchSize) => {
		expect(normalizeEmbedding({ batchSize }).batchSize).toBe(64);
	});
});
