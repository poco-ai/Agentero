import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "@/lib/core/bindings";
import {
	COMMERCIAL_MT_DEFAULT_BASE_URLS,
	COMMERCIAL_MT_DEFAULT_MODELS,
	COMMERCIAL_MT_DOCS_URLS,
	COMMERCIAL_MT_PROVIDER_IDS,
	isChatCompletionsProvider,
	isCommercialProviderConfigured,
	isCommercialTranslateProvider,
	listSelectableProviders,
} from "@/lib/translate";
import { makeCommercialMtService } from "@/lib/translate/services/commercial";

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/core/bindings", () => ({
	commands: {
		translateText: vi.fn(async () => ({
			ok: true,
			data: { text: "你好", provider: "aimlapi" },
		})),
	},
}));

const keyOnly = {
	apiKey: "test-key",
	baseUrl: "",
	region: "",
	model: "",
	extraRequestBody: "",
};

describe("AI/ML API translate provider", () => {
	beforeEach(() => vi.clearAllMocks());

	it("is a commercial provider offered in settings", () => {
		expect(COMMERCIAL_MT_PROVIDER_IDS).toContain("aimlapi");
		expect(isCommercialTranslateProvider("aimlapi")).toBe(true);
		expect(listSelectableProviders().map((s) => s.id)).toContain("aimlapi");
		expect(COMMERCIAL_MT_DEFAULT_BASE_URLS.aimlapi).toBe(
			"https://api.aimlapi.com/v1",
		);
		expect(COMMERCIAL_MT_DOCS_URLS.aimlapi).toBe(
			"https://aimlapi.com/app/keys",
		);
	});

	it("needs only a key, unlike the generic OpenAI-compatible card", () => {
		expect(isCommercialProviderConfigured("aimlapi", keyOnly)).toBe(true);
		expect(isCommercialProviderConfigured("openaiCompatible", keyOnly)).toBe(
			false,
		);
		expect(
			isCommercialProviderConfigured("aimlapi", { ...keyOnly, apiKey: "" }),
		).toBe(false);
	});

	it("shows the model and extra JSON fields of a chat provider", () => {
		expect(isChatCompletionsProvider("aimlapi")).toBe(true);
		expect(isChatCompletionsProvider("openaiCompatible")).toBe(true);
		expect(isChatCompletionsProvider("deepl")).toBe(false);
	});

	it("uses the same default model as the Host", () => {
		const rust = readFileSync(
			fileURLToPath(
				new URL(
					"../crates/agentero-core/src/features/translate/sources/openai_compatible.rs",
					import.meta.url,
				),
			),
			"utf8",
		);
		const host = rust.match(/AIMLAPI_DEFAULT_MODEL: &str = "([^"]+)"/)?.[1];
		expect(host).toBeDefined();
		expect(COMMERCIAL_MT_DEFAULT_MODELS.aimlapi).toBe(host);
	});

	it("sends provider aimlapi to the Host and lets it fill the model", async () => {
		const task = { text: "Hello", sourceLang: "auto", targetLang: "zh-CN" };
		await makeCommercialMtService("aimlapi").translate(task, {
			providerConfig: keyOnly,
		});
		expect(commands.translateText).toHaveBeenCalledTimes(1);
		const [args] = vi.mocked(commands.translateText).mock.calls[0];
		expect(args.provider).toBe("aimlapi");
		expect(args.apiKey).toBe("test-key");
		// Empty model is sent as null; the Host substitutes its default.
		expect(args.model).toBeNull();
	});
});
