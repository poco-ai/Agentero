/**
 * Draw-time translation for an annotation embed.
 *
 * Reads whatever `layout-translate.json` is on disk (schema 1 or 2) plus
 * selection-translate marks. It does not check the current provider, and it
 * does not write the annotation.
 */

import { translationContainsIndexPromptEcho } from "@/lib/pdf/layout/index-translate-echo";
import {
	joinTranslatedDisplays,
	matchingSentenceIndexes,
	normalizeSentenceKey,
} from "@/lib/pdf/layout/layout-sentences";
import { listPdfTranslates } from "@/lib/pdf/translate/io";
import { readVaultFile } from "@/lib/vault/fs";
import { joinVaultPath } from "@/lib/vault/path";

export type AnnotationTranslateSentence = {
	quote: string;
	translated: string;
};

export type AnnotationTranslateDisplayItem = {
	source: string;
	translated: string;
	sentences?: AnnotationTranslateSentence[];
};

export type AnnotationTranslateDisplay = {
	targetLang: string;
	items: AnnotationTranslateDisplayItem[];
};

export type AnnotationTranslateMark = {
	quote?: string;
	result?: string;
	createdAt?: string;
	updatedAt?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDisplaySentences(
	value: unknown,
): AnnotationTranslateSentence[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const sentences: AnnotationTranslateSentence[] = [];
	for (const entry of value) {
		if (!isObject(entry)) continue;
		if (typeof entry.quote !== "string" || !entry.quote.trim()) continue;
		if (typeof entry.translated !== "string" || !entry.translated.trim()) {
			continue;
		}
		sentences.push({
			quote: entry.quote,
			translated: entry.translated.trim(),
		});
	}
	return sentences.length > 0 ? sentences : undefined;
}

/**
 * Schema 1 and 2 are both readable. A bad item or sentence is dropped; a
 * version other than 1 or 2 rejects the file.
 */
export function parseAnnotationTranslateSidecar(
	raw: unknown,
): AnnotationTranslateDisplay | null {
	if (!isObject(raw)) return null;
	if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) return null;
	if (!Array.isArray(raw.items)) return null;
	const targetLang =
		isObject(raw.source) && typeof raw.source.targetLang === "string"
			? raw.source.targetLang
			: "";
	const items: AnnotationTranslateDisplayItem[] = [];
	for (const value of raw.items) {
		if (!isObject(value)) continue;
		if (typeof value.source !== "string" || !value.source.trim()) continue;
		if (typeof value.translated !== "string" || !value.translated.trim()) {
			continue;
		}
		const item: AnnotationTranslateDisplayItem = {
			source: value.source,
			translated: value.translated.trim(),
		};
		const sentences = parseDisplaySentences(value.sentences);
		if (sentences) item.sentences = sentences;
		// An echoed block is untranslated. Leave it out so embeds show the quote
		// until that block is translated again.
		if (translationContainsIndexPromptEcho(item.translated)) continue;
		if (
			item.sentences?.some((sentence) =>
				translationContainsIndexPromptEcho(sentence.translated),
			)
		)
			continue;
		items.push(item);
	}
	return { targetLang, items };
}

export function annotationTranslateSidecarPath(paperAbsPath: string): string {
	return joinVaultPath(
		joinVaultPath(paperAbsPath, "source"),
		"layout-translate.json",
	);
}

function translationFromSentences(
	sentences: readonly AnnotationTranslateSentence[] | undefined,
	quote: string,
	targetLang: string,
): string | null {
	if (!sentences?.length) return null;
	const indexes = matchingSentenceIndexes(sentences, quote);
	if (!indexes.length) return null;
	const text = joinTranslatedDisplays(
		indexes.map((index) => sentences[index]?.translated ?? ""),
		targetLang,
	);
	return text || null;
}

function dedupedSentences(
	items: readonly AnnotationTranslateDisplayItem[],
): AnnotationTranslateSentence[] {
	const sentences: AnnotationTranslateSentence[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		for (const sentence of item.sentences ?? []) {
			const key = normalizeSentenceKey(sentence.quote);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			sentences.push(sentence);
		}
	}
	return sentences;
}

/**
 * Sentence pairs win. A block translation is used only when that block has no
 * pairs and its source is the quote. Otherwise a selection-translate mark with
 * the same quote is the fallback. Most recent mark first.
 */
export function annotationTranslationForQuote(input: {
	sidecar: AnnotationTranslateDisplay | null;
	quote: string;
	markResults?: readonly AnnotationTranslateMark[];
}): string | null {
	const quoteKey = normalizeSentenceKey(input.quote);
	if (!quoteKey) return null;
	const items = input.sidecar?.items ?? [];
	const targetLang = input.sidecar?.targetLang ?? "";
	for (const item of items) {
		const hit = translationFromSentences(item.sentences, quoteKey, targetLang);
		if (hit) return hit;
	}
	const across = translationFromSentences(
		dedupedSentences(items),
		quoteKey,
		targetLang,
	);
	if (across) return across;
	for (const item of items) {
		if (item.sentences?.length) continue;
		if (normalizeSentenceKey(item.source) !== quoteKey) continue;
		const text = item.translated.trim();
		if (text) return text;
	}
	const marks = [...(input.markResults ?? [])].sort((a, b) =>
		(b.updatedAt ?? b.createdAt ?? "").localeCompare(
			a.updatedAt ?? a.createdAt ?? "",
		),
	);
	for (const mark of marks) {
		if (normalizeSentenceKey(mark.quote ?? "") !== quoteKey) continue;
		const result = mark.result?.trim();
		if (result) return result;
	}
	return null;
}

/** Sidecar on disk plus selection-translate marks. Missing files yield null. */
export async function readAnnotationTranslation(
	paperAbsPath: string,
	quote: string,
): Promise<string | null> {
	const [sidecar, marks] = await Promise.all([
		readVaultFile(annotationTranslateSidecarPath(paperAbsPath))
			.then((text) => {
				try {
					return parseAnnotationTranslateSidecar(JSON.parse(text));
				} catch {
					return null;
				}
			})
			.catch(() => null),
		listPdfTranslates(paperAbsPath).catch(() => []),
	]);
	return annotationTranslationForQuote({
		sidecar,
		quote,
		markResults: marks,
	});
}
