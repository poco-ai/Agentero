import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "@/lib/core/bindings";
import { isDictionaryLookup } from "@/lib/translate/dictionary";
import { glossaryConstraint } from "@/lib/translate/glossary";
import {
	dictionaryEntriesForContext,
	lookupDictionary,
	renderDictionaryEntries,
} from "@/lib/translate/lexicon";
import { buildTranslateMessages } from "@/lib/translate/prompt";
import { defaultGlossaryConstraint } from "@/lib/translate/terminology";
import compoundFixture from "./fixtures/translate-compounds.json";

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/core/bindings", () => ({
	commands: { dictionaryLookup: vi.fn() },
}));

describe("bundled dictionary", () => {
	it("matches complete compounds consistently with the Host and keeps standalone acronyms", () => {
		for (const test of compoundFixture.cases) {
			const constraint = glossaryConstraint(
				JSON.stringify(compoundFixture.glossary),
				test.text,
			);
			expect(constraint ? JSON.parse(constraint.split("\n")[1]) : {}).toEqual(
				test.expected,
			);
		}
		for (const term of [
			"LLM-as-a-Judge",
			"llm-as-a-judge",
			"LLM as a Judge",
			"LLM‑as‑a‑Judge",
		]) {
			expect(isDictionaryLookup(term)).toBe(true);
			const constraint = defaultGlossaryConstraint(
				"",
				`We use ${term} to evaluate answers.`,
				"zh-CN",
			);
			const terms = JSON.parse(constraint.split("\n")[1]);
			expect(Object.values(terms)).toEqual(["大模型评审"]);
		}
	});
	beforeEach(() => vi.mocked(commands.dictionaryLookup).mockReset());
	it("looks up locally and reuses normalized queries without a second Host call", async () => {
		vi.mocked(commands.dictionaryLookup).mockResolvedValue({
			ok: true,
			data: [
				{
					word: "example",
					phonetic: "",
					translation: "示例",
					definition: "an illustration",
					source: "ecdict",
					sourceUrl: "",
				},
			],
		});
		const first = await lookupDictionary("example", "zh-CN");
		expect(await lookupDictionary(" EXAMPLE ", "zh-CN")).toEqual(first);
		expect(commands.dictionaryLookup).toHaveBeenCalledTimes(1);
		expect(renderDictionaryEntries(first, "zh-CN")).toContain("示例");
		expect(renderDictionaryEntries(first, "en")).toContain("an illustration");
		expect(renderDictionaryEntries(first, "zh-CN")).toContain(
			"https://github.com/skywind3000/ECDICT",
		);
	});
	it("falls back after a failed local lookup and does not cache transient errors", async () => {
		vi.mocked(commands.dictionaryLookup).mockRejectedValueOnce(
			new Error("missing resource"),
		);
		vi.mocked(commands.dictionaryLookup).mockResolvedValueOnce({
			ok: true,
			data: [],
		});
		expect(await lookupDictionary("unknown-dictionary-entry", "zh-CN")).toEqual(
			[],
		);
		expect(await lookupDictionary("unknown-dictionary-entry", "zh-CN")).toEqual(
			[],
		);
		expect(commands.dictionaryLookup).toHaveBeenCalledTimes(2);
	});
	it("adds third-party terminology without personal configuration and respects explicit non-AI context", () => {
		const constraint = defaultGlossaryConstraint(
			"",
			"The LLM uses a KV cache and Transformer model.",
			"zh-CN",
		);
		expect(constraint).toContain('"LLM":"大模型"');
		expect(constraint).toContain('"KV Cache":"键值缓存"');
		expect(
			defaultGlossaryConstraint(
				"",
				"A power transformer changes voltage.",
				"zh-CN",
			),
		).toBe("");
		expect(
			defaultGlossaryConstraint(
				"",
				"She earned an LLM at law school.",
				"zh-CN",
			),
		).toBe("");
	});
	it("asks only for contextual interpretation when verified dictionary candidates exist", () => {
		const result = buildTranslateMessages({
			text: "resolution",
			targetLangName: "Chinese",
			dictionaryReference: "n. 分辨率；决心",
			dictionarySurrounding: "The image resolution is measured in pixels.",
			customSystem: "Write a paper.\nBe academic.",
		});
		expect(result.system).toContain("Do not repeat definitions");
		expect(result.system).not.toContain("Write a paper");
		expect(result.user).toContain("分辨率；决心");
		expect(result.user).toContain("measured in pixels");
	});
	it("selects AI and general senses without presenting a law degree as the model definition", () => {
		const ai = {
			word: "LLM",
			phonetic: "",
			translation: "大模型",
			definition: "",
			source: "ai-glossary",
			sourceUrl: "https://github.com/JingHao-Leon/ai-llm-glossary",
		};
		const general = { ...ai, translation: "法学硕士", source: "ecdict" };
		expect(dictionaryEntriesForContext([ai, general], "LLM")).toEqual([ai]);
		expect(
			dictionaryEntriesForContext(
				[ai, general],
				"LLM",
				"The LLM processes tokens.",
			),
		).toEqual([ai]);
		expect(
			dictionaryEntriesForContext(
				[ai, general],
				"LLM",
				"She earned an LLM at law school.",
			),
		).toEqual([general]);
	});
});
