import { describe, expect, it } from "vitest";

import {
	indexTranslatePromptEchoAt,
	isIndexPromptEchoError,
	translationContainsIndexPromptEcho,
} from "@/lib/pdf/layout/index-translate-echo";
import { displayTranslateError } from "@/lib/translate/errors";

const TAIL =
	"噪声功率可估计为\n\n【约束要求】\n1. 【注意】数学公式、符号、变量名、单位、行内代码、URL 与引用标记（如 [12]）原样保留，包括 ⟦n⟧ 占位符\n\n只输出译文，不要有任何额外说明。";

describe("Index-Translate prompt echo", () => {
	it("finds the constraint heading, the source heading, and the output rule", () => {
		expect(indexTranslatePromptEchoAt(TAIL)).toBe(TAIL.indexOf("【约束要求】"));
		expect(
			indexTranslatePromptEchoAt(
				"我们可以如下估算噪声功率：\n\n【源文】\nWe can estimate",
			),
		).toBeGreaterThan(0);
		expect(translationContainsIndexPromptEcho("只输出译文")).toBe(true);
		expect(translationContainsIndexPromptEcho("噪声功率可估计为")).toBe(false);
	});

	it("finds the prompt header without a constraint heading", () => {
		const header =
			"请将以下英语文本翻译成中文，并且严格遵循所有约束要求。\n\n你好";
		expect(indexTranslatePromptEchoAt(header)).toBe(0);
	});

	it("localizes the stable failure code", () => {
		expect(
			isIndexPromptEchoError(new Error("translate.index_prompt_echo")),
		).toBe(true);
		expect(isIndexPromptEchoError("Empty translation result")).toBe(false);
		expect(displayTranslateError("translate.index_prompt_echo")).toBe(
			"The translation included the prompt. The original text was kept for that passage.",
		);
	});
});
