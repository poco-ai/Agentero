import { describe, expect, it } from "vitest";

import { isSecretMask, maskSecret } from "@/lib/core/secret-mask";
import {
	buildTranslateMessages,
	buildTranslatePrompt,
	COMMERCIAL_MT_PROVIDER_IDS,
	classifyTranslateQuery,
	FREE_MT_PROVIDER_IDS,
	getTranslateService,
	isCommercialProviderConfigured,
	isCommercialTranslateProvider,
	isFreeMtProvider,
	isShortColloquialPrompt,
	isTranslateProviderId,
	isTranslateTransportError,
	langsFromSettings,
	listSelectableProviders,
	resolveTargetLangCode,
	resolveTargetLangName,
	resolveTranslateAgent,
	targetLangDisplayName,
	translateSystemTemplateIssue,
	translateUserTemplateIssue,
	unknownTranslatePlaceholders,
} from "@/lib/translate";
import { DEFAULT_TRANSLATE_SETTINGS } from "@/lib/translate/defaults";

describe("translate lang", () => {
	it("resolves ui target from interface language", () => {
		expect(resolveTargetLangCode("ui", "zh-CN")).toBe("zh-CN");
		expect(resolveTargetLangCode("ui", "en")).toBe("en");
		expect(resolveTargetLangCode("en", "zh-CN")).toBe("en");
		expect(resolveTargetLangName("ui", "zh-CN")).toBe("Chinese");
		expect(resolveTargetLangName("en", "zh-CN")).toBe("English");
	});

	it("maps codes and names via targetLangDisplayName", () => {
		expect(targetLangDisplayName("zh-CN")).toBe("Chinese");
		expect(targetLangDisplayName("zh")).toBe("Chinese");
		expect(targetLangDisplayName("en")).toBe("English");
		expect(targetLangDisplayName("Chinese")).toBe("Chinese");
		expect(targetLangDisplayName("English")).toBe("English");
	});

	it("builds langs from settings", () => {
		const l = langsFromSettings(
			{ ...DEFAULT_TRANSLATE_SETTINGS, targetLang: "ui" },
			"zh-CN",
		);
		expect(l.sourceLang).toBe("auto");
		expect(l.targetLang).toBe("zh-CN");
		expect(l.targetLangName).toBe("Chinese");
	});
});

describe("isTranslateTransportError", () => {
	it("flags endpoint-level failures that retrying cannot fix", () => {
		expect(
			isTranslateTransportError(
				"Tencent Transmart request failed: error sending request for url (https://transmart.qq.com/api/imt)",
			),
		).toBe(true);
		expect(
			isTranslateTransportError("translate read body: operation timed out"),
		).toBe(true);
		expect(isTranslateTransportError("error: dns error")).toBe(true);
	});

	it("leaves provider answers and payload problems retryable", () => {
		expect(
			isTranslateTransportError("Tencent Transmart failed (HTTP 500): oops"),
		).toBe(false);
		expect(isTranslateTransportError("Empty translation result")).toBe(false);
		expect(isTranslateTransportError(undefined)).toBe(false);
	});
});

describe("translate services registry", () => {
	it("registers free web engines, commercial BYOK engines, and agent", () => {
		for (const id of FREE_MT_PROVIDER_IDS) {
			expect(getTranslateService(id)?.kind).toBe("free-mt");
			expect(getTranslateService(id)?.requireSecret).toBe(false);
		}
		for (const id of COMMERCIAL_MT_PROVIDER_IDS) {
			expect(getTranslateService(id)?.kind).toBe("commercial-mt");
			expect(getTranslateService(id)?.requireSecret).toBe(true);
		}
		expect(getTranslateService("agent")?.kind).toBe("agent");
		expect(getTranslateService("agent")?.requireExternalConfig).toBe(true);
		expect(isTranslateProviderId("deepl")).toBe(true);
		expect(isCommercialTranslateProvider("deepl")).toBe(true);
		expect(isFreeMtProvider("deeplx")).toBe(true);
		expect(isFreeMtProvider("cnki")).toBe(true);
		expect(isFreeMtProvider("agent")).toBe(false);
		expect(isFreeMtProvider("deepl")).toBe(false);
	});

	it("settings list includes free engines, commercial BYOK engines, and agent", () => {
		const ids = listSelectableProviders().map((s) => s.id);
		expect(ids).toContain("googleapi");
		expect(ids).toContain("tencenttransmart");
		expect(ids).toContain("huoshanweb");
		expect(ids).toContain("deeplx");
		expect(ids).toContain("cnki");
		expect(ids).toContain("deepl");
		expect(ids).toContain("azure");
		expect(ids).toContain("googleCloud");
		expect(ids).toContain("openaiCompatible");
		expect(ids).toContain("agent");
	});

	it("defaults to tencent transmart", () => {
		expect(DEFAULT_TRANSLATE_SETTINGS.provider).toBe("tencenttransmart");
		expect(DEFAULT_TRANSLATE_SETTINGS.agentId).toBe("");
		expect(DEFAULT_TRANSLATE_SETTINGS.modelId).toBe("");
	});

	it("keeps commercial engines out of free-MT probes", () => {
		for (const id of FREE_MT_PROVIDER_IDS) {
			expect(isFreeMtProvider(id)).toBe(true);
		}
		for (const id of COMMERCIAL_MT_PROVIDER_IDS) {
			expect(isFreeMtProvider(id)).toBe(false);
		}
	});

	it("treats same-length host API key mask as configured", () => {
		const masked = maskSecret("sk-secret-key");
		expect(masked).toBe("*************");
		expect(isSecretMask(masked)).toBe(true);
		expect(isSecretMask("sk-secret")).toBe(false);
		expect(
			isCommercialProviderConfigured("deepl", {
				apiKey: masked,
				baseUrl: "",
				region: "",
				model: "",
			}),
		).toBe(true);
		expect(
			isCommercialProviderConfigured("deepl", {
				apiKey: "",
				baseUrl: "",
				region: "",
				model: "",
			}),
		).toBe(false);
		expect(
			isCommercialProviderConfigured("azure", {
				apiKey: masked,
				baseUrl: "",
				region: "",
				model: "",
			}),
		).toBe(false);
		expect(
			isCommercialProviderConfigured("azure", {
				apiKey: masked,
				baseUrl: "",
				region: "eastasia",
				model: "",
			}),
		).toBe(true);
	});
});

describe("resolveTranslateAgent", () => {
	it("follows default agent when agentId empty", () => {
		const r = resolveTranslateAgent(
			{ agentId: "", modelId: "" },
			{
				defaultId: "codex-1",
				agents: [
					{
						id: "codex-1",
						name: "Codex",
						template: "codex-acp",
						command: "codex",
						args: [],
						env: {},
						available: true,
					},
				],
			},
		);
		expect(r.agentId).toBe("codex-1");
	});

	it("uses pinned agentId when available", () => {
		const r = resolveTranslateAgent(
			{ agentId: "claude-1", modelId: "m1" },
			{
				defaultId: "codex-1",
				agents: [
					{
						id: "codex-1",
						name: "Codex",
						template: "codex-acp",
						command: "codex",
						args: [],
						env: {},
						available: true,
					},
					{
						id: "claude-1",
						name: "Claude",
						template: "claude-acp",
						command: "claude",
						args: [],
						env: {},
						available: true,
					},
				],
			},
		);
		expect(r.agentId).toBe("claude-1");
		expect(r.modelId).toBe("m1");
	});
});

describe("translate prompts", () => {
	it("splits a generic prompt into engine rules and quoted source", () => {
		const text =
			"The ablation study confirms the gain comes from the attention module.";
		const { system, user } = buildTranslateMessages({
			text,
			targetLangName: "Chinese",
		});
		expect(system).toContain("focusing solely on translating");
		expect(system).toContain("Only return the translated text");
		expect(system).toContain("Chinese");
		expect(system).toContain("the source language");
		expect(system).toContain("OUTPUT ONLY THE TRANSLATION.");
		expect(system).toContain("Transformer 架构");
		expect(system).not.toContain("compact dictionary gloss");
		expect(system).not.toContain(text);
		expect(system).not.toContain("{{targetLang}}");
		expect(user).toBe(`"""${text}"""`);
		expect(classifyTranslateQuery(text)).toBe("prose");
	});

	it("forbids a clarifying question on a word or short phrase", () => {
		expect(classifyTranslateQuery("attention")).toBe("word");
		expect(classifyTranslateQuery("multi-head attention")).toBe("word");
		expect(classifyTranslateQuery("注意力")).toBe("word");
		expect(
			classifyTranslateQuery(
				"We propose a transformer architecture for sequence transduction.",
			),
		).toBe("prose");

		for (const text of ["attention", "multi-head attention", "注意力"]) {
			const { system, user } = buildTranslateMessages({
				text,
				targetLangName: "Chinese",
			});
			expect(system).toContain("compact dictionary gloss");
			expect(system).toContain(
				"Do not ask whether the user wants a translation",
			);
			expect(system).not.toMatch(/你想翻译还是解释/);
			expect(user).toBe(`"""${text}"""`);
		}

		const sentence = buildTranslateMessages({
			text: "We propose a transformer architecture for sequence transduction.",
			targetLangName: "Chinese",
		});
		expect(sentence.system).not.toContain("compact dictionary gloss");
	});

	it("puts system rules first in the agent string", () => {
		const prompt = buildTranslatePrompt({
			text: "attention",
			targetLangName: "Chinese",
			page: 3,
			surface: "pdf-selection",
		});
		expect(prompt.startsWith("OUTPUT ONLY THE TRANSLATION.")).toBe(true);
		expect(prompt.indexOf("SYSTEM:")).toBeLessThan(
			prompt.indexOf("USER TEXT:"),
		);
		expect(prompt).toContain("page 3");
		expect(prompt.endsWith('"""attention"""')).toBe(true);
		expect(prompt).not.toContain("User request:");
	});

	it("keeps a one-line custom prompt as a preference", () => {
		expect(isShortColloquialPrompt("Be terse.")).toBe(true);
		expect(isShortColloquialPrompt("翻译得自然一点")).toBe(true);
		const { system, user } = buildTranslateMessages({
			text: "Hello world",
			targetLangName: "Chinese",
			customPrompt: "Be terse.",
		});
		expect(system).toContain("OUTPUT ONLY THE TRANSLATION.");
		expect(system).toContain("Transformer 架构");
		expect(system).toContain("Additional preference");
		expect(system).toContain("Be terse.");
		expect(system.indexOf("Be terse.")).toBeLessThan(
			system.indexOf("Final rule:"),
		);
		expect(user).toBe('"""Hello world"""');
	});

	it("lets a substantial custom system replace style only", () => {
		const { system, user } = buildTranslateMessages({
			text: "[[1]] alpha\n\n[[2]] beta",
			targetLangName: "Chinese",
			page: 7,
			surface: "pdf-selection",
			customPrompt:
				"Terse literary translator. {{targetLang}} from {{sourceLang}}.\nKeep formulas.",
		});
		expect(system).toContain(
			"Terse literary translator. Chinese from the source language.",
		);
		expect(system).toContain("not a chat assistant");
		expect(system).toContain("OUTPUT ONLY THE TRANSLATION.");
		expect(system).not.toContain("Transformer 架构");
		expect(system).toContain("page 7");
		expect(system).toContain("[[n]] marker");
		expect(system).toContain("do not merge markers");
		expect(system).not.toContain("compact dictionary gloss");
		expect(user).toBe('"""[[1]] alpha\n\n[[2]] beta"""');
	});

	it("empty custom prompt matches the built-in prompt", () => {
		const base = {
			text: "Hello world",
			targetLangName: "Chinese",
			page: 2,
			surface: "pdf-selection" as const,
		};
		expect(buildTranslatePrompt({ ...base, customPrompt: "" })).toBe(
			buildTranslatePrompt(base),
		);
		const rendered = buildTranslatePrompt(base);
		expect(rendered).toContain("into Chinese");
		expect(rendered).not.toContain("{{targetLang}}");
		expect(rendered).not.toContain("{{sourceLang}}");
	});

	it("rejects unknown placeholders and keeps the three known ones", () => {
		expect(unknownTranslatePlaceholders("{{targetLang}} {{text}}")).toEqual([]);
		expect(
			unknownTranslatePlaceholders("See {{tone}} and {{ targetLang }}."),
		).toEqual(["tone"]);
		expect(translateSystemTemplateIssue("{{tone}}")).toEqual({
			kind: "unknown",
			names: ["tone"],
		});
		expect(translateSystemTemplateIssue("")).toBeNull();
		expect(translateUserTemplateIssue("")).toBeNull();
		expect(translateUserTemplateIssue("just say it")).toEqual({
			kind: "missingText",
		});
		expect(translateUserTemplateIssue("{{text}} {{mood}}")).toEqual({
			kind: "unknown",
			names: ["mood"],
		});
		expect(translateUserTemplateIssue("<<{{ text }}>>")).toBeNull();
	});

	it("prefers customSystem and inserts the source through customUser", () => {
		const { system, user } = buildTranslateMessages({
			text: "attention",
			targetLangName: "Chinese",
			customPrompt: "legacy preference",
			customSystem: "Be terse.",
			customUser: "SRC:\n{{ text }}",
		});
		expect(system).toContain("Be terse.");
		expect(system).not.toContain("legacy preference");
		expect(system).toContain("OUTPUT ONLY THE TRANSLATION.");
		expect(user).toBe("SRC:\nattention");
		expect(user).not.toContain('"""');
	});

	it("default translate settings ship empty custom prompts", () => {
		expect(DEFAULT_TRANSLATE_SETTINGS.customPrompt).toBe("");
		expect(DEFAULT_TRANSLATE_SETTINGS.customSystem).toBe("");
		expect(DEFAULT_TRANSLATE_SETTINGS.customUser).toBe("");
	});
});
