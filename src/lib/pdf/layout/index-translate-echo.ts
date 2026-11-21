/**
 * Prompt fragments that Index-Translate's `build_prompt` inserts and that a
 * translation must not contain. The Host cutter in
 * `crates/agentero-core/src/features/translate/sources/index_translate.rs`
 * uses the same strings. A stored block that still contains one is not a
 * finished translation.
 */

import { ERR_TRANSLATE_INDEX_PROMPT_ECHO } from "@/lib/translate/api";

export { ERR_TRANSLATE_INDEX_PROMPT_ECHO };

const PROMPT_ECHO_MARKERS = [
	"【源文】",
	"【约束要求】",
	"只输出译文",
	"不要有任何额外说明",
	"【注意】数学公式、符号、变量名、单位、行内代码、URL 与引用标记",
	"【硬性要求】保留每个 [[n]] 标记",
	"专名/术语对照",
];

/** Byte-agnostic index of the first prompt fragment, or null when absent. */
export function indexTranslatePromptEchoAt(text: string): number | null {
	let best: number | null = headerEchoStart(text);
	for (const marker of PROMPT_ECHO_MARKERS) {
		const index = text.indexOf(marker);
		if (index < 0) continue;
		best = best == null ? index : Math.min(best, index);
	}
	return best;
}

export function translationContainsIndexPromptEcho(text: string): boolean {
	return indexTranslatePromptEchoAt(text) != null;
}

export function isIndexPromptEchoError(error: unknown): boolean {
	const message =
		typeof error === "string"
			? error
			: error instanceof Error
				? error.message
				: "";
	return message.includes(ERR_TRANSLATE_INDEX_PROMPT_ECHO);
}

/** Header language names vary. Match the fixed ends inside a short window. */
function headerEchoStart(text: string): number | null {
	let from = 0;
	while (from < text.length) {
		const start = text.indexOf("请将以下", from);
		if (start < 0) return null;
		const end = text.indexOf("严格遵循所有约束要求", start);
		if (
			end >= 0 &&
			end - start <= 120 &&
			text.slice(start, end).includes("翻译成")
		) {
			return start;
		}
		from = start + "请将以下".length;
	}
	return null;
}
