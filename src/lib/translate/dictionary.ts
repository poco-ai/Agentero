import { hasNumberedMarkers } from "./prompt";

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * 判断选区是否应该使用词典模式。
 *
 * 规则（参考 zotero-pdf-translate）：
 * - 用 Intl.Segmenter 计数 isWordLike 的片段
 * - 1-3 个词 → 词典候选
 * - 4+ 个词 → 翻译
 * - 过滤批次标记、句读标点、过长文本
 */
export function shouldUseDictionary(text: string): boolean {
	const trimmed = text.trim();

	// 过滤批次标记
	if (hasNumberedMarkers(trimmed)) return false;

	// 过滤句读标点（完整句子）
	if (/[.!?。！？；;]/.test(trimmed)) return false;

	// 过滤明显过长的文本
	if (trimmed.length > 60) return false;

	// 用 Intl.Segmenter 计数词
	let wordCount = 0;
	for (const segment of segmenter.segment(trimmed)) {
		if (segment.isWordLike) {
			wordCount++;
			if (wordCount > 3) return false; // 4+ 词直接走翻译
		}
	}

	// 1-3 个词 → 词典候选
	return wordCount >= 1 && wordCount <= 3;
}

/**
 * 构建词典模式的提示词。
 *
 * 输出格式：
 * ```
 * 释义 — 词性 + 常用义（15字内）
 * 本文 — 该词在本句中的具体含义（25字内）
 * ```
 */
export function buildDictionaryPrompt(opts: {
	word: string;
	sentence: string;
	targetLang: string;
	paperDefinition?: string;
}): string {
	const { word, sentence, targetLang, paperDefinition } = opts;

	let prompt = `Word: "${word}"
Sentence: "${sentence}"
`;

	if (paperDefinition) {
		prompt += `Paper definition: ${paperDefinition}\n`;
	}

	prompt += `
Output 2 lines in ${targetLang}:
释义 — 词性 + 常用义（15字内）
本文 — 该词在本句中的具体含义（25字内）

Example:
释义 n. 注意；关注
本文 注意力机制：模型对输入加权关注`;

	return prompt;
}

/**
 * 提取论文内的定义和缩写（L1）。
 *
 * TODO: 实现论文全文扫描，提取：
 * 1. 缩写展开：`Full Name (ABC)` 或 `ABC (Full Name)`
 * 2. 首次定义：`is defined as`, `we call`, `we refer to`
 *
 * Phase 1 暂时返回空，Phase 2 再实现。
 */
export async function extractPaperDefinition(
	_selection: string,
	_paperFullText?: string,
): Promise<{ text: string; location: number } | undefined> {
	// Phase 1: 暂不实现，直接返回 undefined
	return undefined;
}
