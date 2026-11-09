import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "@/lib/core/bindings";
import { probeCommercialMtProvider } from "@/lib/translate/probe";
import { extraRequestBodyIssue } from "@/lib/translate/request-options";
import { makeCommercialMtService } from "@/lib/translate/services/commercial";

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/core/bindings", () => ({
	commands: {
		translateText: vi.fn(async () => ({
			ok: true,
			data: { text: "你好", provider: "openaicompatible" },
		})),
	},
}));

describe("translation request options", () => {
	beforeEach(() => vi.clearAllMocks());
	it("rejects non-objects and protected fields before saving", () => {
		for (const raw of ["{", "[]", "null", "42", '"text"'])
			expect(extraRequestBodyIssue(raw)).toBe("invalid");
		for (const key of ["model", "messages", "stream"])
			expect(extraRequestBodyIssue(JSON.stringify({ [key]: null }))).toBe(
				"reserved",
			);
		expect(
			extraRequestBodyIssue(
				'{"thinking":{"type":"disabled"},"stop":["END"],"vendor":null}',
			),
		).toBeNull();
		expect(extraRequestBodyIssue(" ")).toBeNull();
	});
	it("uses identical extra options for probes and actual translation", async () => {
		const config = {
			apiKey: "test-key",
			baseUrl: "http://localhost:9999/v1",
			region: "",
			model: "qwen3",
			extraRequestBody: '{"chat_template_kwargs":{"enable_thinking":false}}',
		};
		expect(
			await probeCommercialMtProvider("openaiCompatible", { config }),
		).toBe(true);
		await makeCommercialMtService("openaiCompatible").translate(
			{ text: "Hello", sourceLang: "auto", targetLang: "zh-CN" },
			{ providerConfig: config },
		);
		expect(commands.translateText).toHaveBeenCalledTimes(2);
		for (const [args] of vi.mocked(commands.translateText).mock.calls) {
			expect(args.extraRequestBody).toBe(config.extraRequestBody);
		}
	});
});
