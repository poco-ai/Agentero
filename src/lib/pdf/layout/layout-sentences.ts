/**
 * Sentence cuts for layout translation.
 *
 * The cut runs on the text-layer string before hyphen healing, so the quote
 * still matches `repre- sentation` in the PDF. Latin `.` `!` `?` end a sentence
 * only before whitespace; `。` `！` `？` end one on their own. Abbreviations and
 * decimals are not sentence ends. Normalization stays a separate step.
 */

import {
	normalizeLayoutSourceText,
	splitChainTranslation,
} from "@/lib/pdf/layout/layout-translate-source";
import type {
	LayoutTranslateSentence,
	PdfLayoutKind,
} from "@/lib/pdf/layout/types";
import {
	type Paragraph,
	reflowDisplayText,
	reflowStructureForText,
	validReflowTranslation,
} from "@/lib/pdf/reflow/types";

const LATIN_SENTENCE_PUNCT = new Set([".", "!", "?"]);
/** CJK stops are unambiguous, so they end a sentence without a following space. */
const CJK_SENTENCE_PUNCT = new Set(["。", "！", "？"]);

function isCloser(ch: string): boolean {
	return (
		ch === '"' ||
		ch === "'" ||
		ch === ")" ||
		ch === "]" ||
		ch === "”" ||
		ch === "’" ||
		ch === "）" ||
		ch === "」"
	);
}

/** `et al.` / `Fig.` / `e.g.` / `i.e.` / `0.5` — the period is not a sentence end. */
function isProtectedPeriod(text: string, index: number): boolean {
	if (text[index] !== ".") return false;
	const before = text.slice(0, index);
	if (/(?:^|[\s([(])fig$/i.test(before)) return true;
	if (/(?:^|[\s([(])et\s+al$/i.test(before)) return true;
	if (/(?:^|[\s([(])e\.g$/i.test(before)) return true;
	if (/(?:^|[\s([(])i\.e$/i.test(before)) return true;
	const prev = before.at(-1);
	const next = text[index + 1];
	return Boolean(prev && next && /\d/.test(prev) && /\d/.test(next));
}

/**
 * Split prose into sentence quotes. Whitespace is collapsed; hyphens stay.
 * A string with no sentence end is returned as one quote.
 */
export function splitLayoutSentences(raw: string): string[] {
	const text = raw.replace(/\s+/g, " ").trim();
	if (!text) return [];
	const cuts: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (!ch) continue;
		const cjk = CJK_SENTENCE_PUNCT.has(ch);
		if (!cjk && !LATIN_SENTENCE_PUNCT.has(ch)) continue;
		if (!cjk && isProtectedPeriod(text, i)) continue;
		let end = i + 1;
		while (end < text.length && isCloser(text[end] ?? "")) end += 1;
		if (!cjk) {
			const next = text[end];
			if (next !== undefined && !/\s/.test(next)) continue;
		}
		cuts.push(end);
	}
	if (cuts.length === 0) return [text];
	const out: string[] = [];
	let start = 0;
	for (const cut of cuts) {
		const slice = text.slice(start, cut).trim();
		if (slice) out.push(slice);
		start = cut;
		while (start < text.length && /\s/.test(text[start] ?? "")) start += 1;
	}
	const tail = text.slice(start).trim();
	if (tail) out.push(tail);
	return out.length > 0 ? out : [text];
}

export type QuoteMemberRange = {
	memberIndex: number;
	start: number;
	end: number;
};

/**
 * Join chain members for sentence cutting. Unlike the engine join, a trailing
 * hyphen is kept so the quote still matches the text layer.
 */
export function joinMemberQuotes(pieces: readonly string[]): {
	text: string;
	ranges: QuoteMemberRange[];
} {
	let text = "";
	const ranges: QuoteMemberRange[] = [];
	pieces.forEach((piece, memberIndex) => {
		const cleaned = piece.replace(/\s+/g, " ").trim();
		if (!cleaned) {
			ranges.push({ memberIndex, start: text.length, end: text.length });
			return;
		}
		if (text) text += " ";
		const start = text.length;
		text += cleaned;
		ranges.push({ memberIndex, start, end: text.length });
	});
	return { text, ranges };
}

/** Collapse whitespace so quote comparisons ignore line-break spacing. */
export function normalizeSentenceKey(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Chinese sentence joins have no space. Every other target language inserts one.
 */
export function translationJoinsWithSpace(targetLang: string): boolean {
	const code = targetLang.trim().toLowerCase();
	if (code === "zh" || code === "chinese" || code.startsWith("zh-")) {
		return false;
	}
	return true;
}

export function joinTranslatedDisplays(
	parts: readonly string[],
	targetLang: string,
): string {
	const gap = translationJoinsWithSpace(targetLang) ? " " : "";
	return parts
		.map((part) => part.trim())
		.filter(Boolean)
		.join(gap);
}

export type LayoutTranslateSentenceNode = {
	index: number;
	text: string;
};

/**
 * Span texts for one overlay paragraph. The gap is whatever makes the spans
 * concatenate back to `text`, so the fit pass still sees the same string.
 * Returns null when the pairs do not rebuild that string.
 */
export function layoutTranslateSentenceNodes(
	text: string,
	sentences: readonly { translated: string; display?: string }[] | undefined,
): { nodes: LayoutTranslateSentenceNode[]; gap: string } | null {
	if (!sentences?.length) return null;
	const nodes: LayoutTranslateSentenceNode[] = [];
	sentences.forEach((sentence, index) => {
		const piece = (sentence.display ?? sentence.translated).trim();
		if (piece) nodes.push({ index, text: piece });
	});
	if (nodes.length === 0) return null;
	const pieces = nodes.map((node) => node.text);
	const trimmed = text.trim();
	if (pieces.join("") === trimmed) return { nodes, gap: "" };
	if (pieces.join(" ") === trimmed) return { nodes, gap: " " };
	return null;
}

/**
 * Indexes of sentences covered by an annotation quote: one sentence, or a run
 * of consecutive sentences joined in order. A quote that only partly overlaps
 * a sentence does not match.
 */
export function matchingSentenceIndexes(
	sentences: readonly { quote: string }[],
	quote: string,
): number[] {
	const target = normalizeSentenceKey(quote);
	if (!target || sentences.length === 0) return [];
	for (let start = 0; start < sentences.length; start++) {
		let joined = "";
		for (let end = start; end < sentences.length; end++) {
			const piece = normalizeSentenceKey(sentences[end]?.quote ?? "");
			if (!piece) break;
			joined = joined ? `${joined} ${piece}` : piece;
			if (joined === target) {
				const indexes: number[] = [];
				for (let i = start; i <= end; i++) indexes.push(i);
				return indexes;
			}
			if (joined.length > target.length) break;
		}
	}
	return [];
}

/**
 * Sentences whose quotes the annotation text covers exactly.
 *
 * Used only while sentence glyph boxes are not available yet. A highlight may
 * quote sentences that continue in another box, so a sentence matches when the
 * quote is that sentence, contains it as a whole sentence, or is the same
 * letters with punctuation dropped. A fragment inside a sentence does not
 * match: the same word can sit in several sentences, and position decides
 * which one once glyph boxes are known.
 */
export function sentenceIndexesCoveredByQuote(
	sentences: readonly { quote: string }[],
	quote: string,
): number[] {
	const exact = matchingSentenceIndexes(sentences, quote);
	if (exact.length > 0) return exact;
	const target = normalizeSentenceKey(quote);
	if (!target) return [];
	const hit: number[] = [];
	sentences.forEach((sentence, index) => {
		const piece = normalizeSentenceKey(sentence.quote);
		if (!piece) return;
		if (
			target === piece ||
			target.startsWith(`${piece} `) ||
			target.endsWith(` ${piece}`) ||
			target.includes(` ${piece} `)
		) {
			hit.push(index);
		}
	});
	if (hit.length > 0) return hit;
	const foldedTarget = foldQuoteKey(target);
	if (!foldedTarget) return [];
	const partial: number[] = [];
	sentences.forEach((sentence, index) => {
		const piece = foldQuoteKey(sentence.quote);
		if (piece === foldedTarget) partial.push(index);
	});
	return partial;
}

/** Letters and digits only, so spacing and punctuation do not block a match. */
function foldQuoteKey(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Union of sentences a page's highlight quotes should tint. */
export function tintedSentenceIndexes(
	sentences: readonly { quote: string }[] | undefined,
	quotes: readonly string[] | undefined,
): number[] {
	if (!sentences?.length || !quotes?.length) return [];
	const indexes = new Set<number>();
	for (const quote of quotes) {
		for (const index of sentenceIndexesCoveredByQuote(sentences, quote)) {
			indexes.add(index);
		}
	}
	return [...indexes];
}

export type LayoutSentenceSpan = {
	memberIndex: number;
	/** Characters of the quote that sit in this member, excluding the join space. */
	rawLength: number;
};

/** One sentence cut from a chain, before it is translated. */
export type LayoutSentenceDraft = {
	quote: string;
	source: string;
	spans: LayoutSentenceSpan[];
	/** Style tags immediately outside this sentence in the same paragraph. */
	openStyleBefore?: string;
	closeStyleAfter?: string;
};

export function reflowSentenceValidator(
	p: Paragraph,
	draft: LayoutSentenceDraft,
) {
	const prefix =
		draft.openStyleBefore === undefined ? "" : `⟪S${draft.openStyleBefore}⟫`;
	const suffix =
		draft.closeStyleAfter === undefined ? "" : `⟪/S${draft.closeStyleAfter}⟫`;
	const structure =
		draft.source === p.protectedText
			? p
			: reflowStructureForText(p, prefix + draft.source + suffix);
	// Supply missing neighbors for validation only. The assembled paragraph
	// still has exactly one open/close pair for each original style.
	return (text: string) =>
		validReflowTranslation(structure, prefix + text + suffix);
}

/** Cut the original reflow paragraph while keeping formula and style tokens
 * attached to the matching sentence. An indivisible structure stays a block. */
export function draftReflowSentences(p: Paragraph): LayoutSentenceDraft[] {
	const draft = (quote: string, source: string): LayoutSentenceDraft => ({
		quote,
		source,
		spans: [{ memberIndex: 0, rawLength: quote.length }],
	});
	const whole = [draft(p.source, p.protectedText)];
	const quotes = splitLayoutSentences(p.source);
	if (quotes.filter((quote) => /[\p{L}\p{N}]/u.test(quote)).length < 2)
		return whole;

	// Map visible characters to protected offsets. Every character of an
	// atomic formula shares the same end, so a cut cannot bisect the token.
	const compact = (text: string) => text.replace(/\s/g, "");
	let visible = "";
	const ends: number[] = [];
	for (const match of p.protectedText.matchAll(/⟪(?:F|\/?S)\d+⟫|./gsu)) {
		const value = compact(reflowDisplayText(p, match[0]));
		visible += value;
		for (let i = 0; i < value.length; i++)
			ends.push(match.index + match[0].length);
	}
	if (visible !== compact(p.source)) return whole;

	let count = 0;
	let start = 0;
	let activeStyle: string | undefined;
	const drafts: LayoutSentenceDraft[] = [];
	for (const [index, quote] of quotes.entries()) {
		count += compact(quote).length;
		let end = ends[count - 1];
		if (end === undefined || end === ends[count]) return whole;
		const close = p.protectedText.slice(end).match(/^(?:\s*⟪\/S\d+⟫)*/u)?.[0];
		end =
			index === quotes.length - 1
				? p.protectedText.length
				: end + (close?.length ?? 0);
		const source = p.protectedText.slice(start, end).trim();
		const openStyleBefore = activeStyle;
		for (const tag of source.matchAll(/⟪(\/?)S(\d+)⟫/gu))
			activeStyle = tag[1] ? undefined : tag[2];
		const sentence = {
			...draft(quote, source),
			openStyleBefore,
			closeStyleAfter: activeStyle,
		};
		if (!reflowSentenceValidator(p, sentence)(source)) return whole;
		drafts.push(sentence);
		start = end;
	}
	return drafts;
}

function memberQuoteText(member: { raw?: string; source: string }): string {
	return member.raw?.trim() ? member.raw : member.source;
}

/**
 * Cut a chain into sentences on the text-layer strings. `source` is normalized
 * per sentence; `quote` keeps hyphens so a later locate still hits the PDF.
 */
export function draftChainSentences(
	members: readonly {
		raw?: string;
		source: string;
		kind: PdfLayoutKind;
	}[],
): LayoutSentenceDraft[] {
	if (members.length === 0) return [];
	const { text, ranges } = joinMemberQuotes(members.map(memberQuoteText));
	if (!text) return [];
	const quotes = splitLayoutSentences(text);
	const drafts: LayoutSentenceDraft[] = [];
	let cursor = 0;
	for (const quote of quotes) {
		const at = text.indexOf(quote, cursor);
		const start = at >= 0 ? at : cursor;
		const end = Math.min(text.length, start + quote.length);
		const spans: LayoutSentenceSpan[] = [];
		for (const range of ranges) {
			const lo = Math.max(range.start, start);
			const hi = Math.min(range.end, end);
			if (hi > lo) {
				spans.push({ memberIndex: range.memberIndex, rawLength: hi - lo });
			}
		}
		const kind = members[spans[0]?.memberIndex ?? 0]?.kind;
		const source = normalizeLayoutSourceText(quote, kind).trim() || quote;
		drafts.push({ quote, source, spans });
		cursor = Math.max(cursor, end);
	}
	return drafts;
}

/**
 * Paint each sentence's translation into the chain members that contain it.
 * A sentence that spans boxes is split only within itself. `display` is omitted
 * when the member shows the whole sentence.
 */
export function paintSentenceTranslations(
	drafts: readonly LayoutSentenceDraft[],
	translations: readonly string[],
	memberCount: number,
	targetLang: string,
): { translated: string; sentences: LayoutTranslateSentence[] }[] {
	const slices: string[][] = Array.from({ length: memberCount }, () => []);
	const sentences: LayoutTranslateSentence[][] = Array.from(
		{ length: memberCount },
		() => [],
	);
	drafts.forEach((draft, index) => {
		const translated = (translations[index] ?? "").trim();
		if (!translated) return;
		const spans = draft.spans.filter(
			(span) =>
				span.rawLength > 0 &&
				span.memberIndex >= 0 &&
				span.memberIndex < memberCount,
		);
		if (spans.length === 0) return;
		const parts =
			spans.length === 1
				? [translated]
				: splitChainTranslation(
						translated,
						spans.map((span) => span.rawLength),
					);
		spans.forEach((span, spanIndex) => {
			const display = (parts[spanIndex] ?? "").trim();
			if (!display) return;
			slices[span.memberIndex]?.push(display);
			const sentence: LayoutTranslateSentence = {
				quote: draft.quote,
				source: draft.source,
				translated,
			};
			if (display !== translated) sentence.display = display;
			sentences[span.memberIndex]?.push(sentence);
		});
	});
	return slices.map((parts, index) => ({
		translated: joinTranslatedDisplays(parts, targetLang),
		sentences: sentences[index] ?? [],
	}));
}
