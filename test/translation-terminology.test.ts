import { describe, expect, it } from "vitest";
import { translateServiceKey } from "@/lib/pdf/layout/layout-translate";
import { DEFAULT_TRANSLATE_SETTINGS } from "@/lib/translate/defaults";
import {
	dictionarySurrounding,
	isDictionaryLookup,
} from "@/lib/translate/dictionary";
import { glossaryConstraint, parseGlossary } from "@/lib/translate/glossary";
import { buildTranslateMessages } from "@/lib/translate/prompt";
import cases from "./fixtures/dictionary-selection.json";

describe("terminology and selection contract", () => {
	it.each(cases)("classifies $text consistently with Host", ({
		text,
		dictionary,
	}) => expect(isDictionaryLookup(text)).toBe(dictionary));
	it("accepts all advertised pair formats and JSON without losing values", () => {
		const expected = [
			["KV cache", "KV 缓存"],
			["LLM", "大模型"],
		];
		for (const input of [
			'{"LLM":"大模型","KV cache":"KV 缓存"}',
			"LLM:大模型, KV cache->KV 缓存",
			"LLM：大模型，KV cache→KV 缓存",
			"LLM → 大模型\nKV cache → KV 缓存",
		])
			expect(parseGlossary(input)).toEqual(expected);
		expect(parseGlossary('{"term":"a,b:c"}')).toEqual([["term", "a,b:c"]]);
	});
	it.each([
		'{"LLM":1}',
		"{broken",
		"LLM",
		"LLM:",
		":model",
		"x".repeat(16001),
	])("rejects invalid glossary %s", (input) =>
		expect(() => parseGlossary(input)).toThrow());
	it("matches whole terms, not substrings, and escapes regex punctuation", () => {
		const input = '{"LLM":"大模型","KV cache":"KV 缓存","C++":"C++"}';
		expect(glossaryConstraint(input, "LLMs use a KV cache.")).not.toContain(
			'"LLM"',
		);
		expect(glossaryConstraint(input, "An llm uses C++.")).toContain(
			'"LLM":"大模型"',
		);
		expect(glossaryConstraint(input, "An llm uses C++.")).toContain(
			'"C++":"C++"',
		);
	});
	it("matches Chinese terms in continuous prose and mixed-script acronyms", () => {
		expect(
			glossaryConstraint("大模型→LLM", "我们使用大模型进行推理。"),
		).toContain("LLM");
		expect(glossaryConstraint("LLM→大模型", "LLM模型")).toContain("大模型");
	});

	it("isolates dictionary instructions from prose templates and uses captured context", () => {
		const surrounding = dictionarySurrounding("resolution", {
			status: "available",
			before: "The image has high",
			after: "on this display.",
		});
		const { system, user } = buildTranslateMessages({
			text: "resolution",
			targetLangName: "Chinese",
			dictionarySurrounding: surrounding,
			customSystem: "Write a paper.\nUse {{targetLang}}.",
			customUser: "Translate {{text}}",
		});
		expect(system).toContain("**In context**");
		expect(system).not.toContain("Write a paper");
		expect(system).not.toContain("OUTPUT ONLY THE TRANSLATION");
		expect(user).toContain("The image has high");
		expect(
			dictionarySurrounding("resolution", { status: "unavailable" }),
		).toBeUndefined();
	});
	it("keeps full-text short headings as prose and invalidates caches after terminology edits", () => {
		expect(
			buildTranslateMessages({
				text: "Introduction",
				targetLangName: "Chinese",
				dictionary: false,
			}).system,
		).not.toContain("research dictionary");
		expect(
			translateServiceKey({
				...DEFAULT_TRANSLATE_SETTINGS,
				glossaries: { "zh-CN": '{"LLM":"大模型"}' },
			}),
		).not.toBe(translateServiceKey(DEFAULT_TRANSLATE_SETTINGS));
	});
});
