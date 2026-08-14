import type { DefenseQuestion } from "@/lib/voice-defense/preparation/schema";
import type { VoiceCaption } from "@/lib/voice-defense/protocol";

/**
 * Post-session debrief: match the committee's actual questions against the
 * prepared question outline, deterministically and offline. The goal is not
 * grading (that needs a model) but an honest coverage map — which prepared
 * challenges came up, what the user answered, and what is left to revisit.
 */

export type DebriefQuestionReview = {
	question: DefenseQuestion;
	asked: boolean;
	/** Highest bigram similarity against any committee caption. */
	similarity: number;
	/** The committee caption that matched, when asked. */
	askedText?: string;
	/** The user's spoken answer immediately following the matched question. */
	userAnswer?: string;
};

export type DefenseDebrief = {
	questions: DebriefQuestionReview[];
	askedCount: number;
	totalCount: number;
};

/** A committee caption must overlap this much to count as "asked". */
export const DEBRIEF_ASKED_THRESHOLD = 0.28;

const CJK_RUN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+/g;

/**
 * Mixed tokenizer: whole words for alphabetic scripts, character bigrams for
 * CJK (which has no useful word boundaries in captions). Character bigrams on
 * English prose over-match — every sentence shares "th"/"he" — so Latin text
 * gets word tokens instead.
 */
function matchTokens(text: string): Set<string> {
	const tokens = new Set<string>();
	const lower = text.toLocaleLowerCase();
	for (const match of lower.matchAll(/[a-z0-9]+/g)) {
		if (match[0].length > 1) tokens.add(`w:${match[0]}`);
	}
	for (const run of lower.match(CJK_RUN) ?? []) {
		if (run.length === 1) tokens.add(`c:${run}`);
		for (let index = 0; index < run.length - 1; index += 1) {
			tokens.add(`c:${run.slice(index, index + 2)}`);
		}
	}
	return tokens;
}

/** Dice coefficient over mixed tokens — language-aware and cheap. */
export function captionSimilarity(a: string, b: string): number {
	const left = matchTokens(a);
	const right = matchTokens(b);
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const token of left) {
		if (right.has(token)) shared += 1;
	}
	return (2 * shared) / (left.size + right.size);
}

function collectUserAnswer(
	captions: readonly VoiceCaption[],
	fromIndex: number,
): string | undefined {
	const parts: string[] = [];
	for (let index = fromIndex + 1; index < captions.length; index += 1) {
		const caption = captions[index];
		if (caption.role === "assistant") break;
		const text = caption.text.trim();
		if (text) parts.push(text);
	}
	if (parts.length === 0) return undefined;
	const joined = parts.join(" ");
	return joined.length > 600 ? `${joined.slice(0, 600)}…` : joined;
}

/**
 * Compare the prepared outline against the transcript. Committee rephrasings
 * are expected — the threshold is calibrated for "same challenge, different
 * words", not verbatim repetition.
 */
export function buildDefenseDebrief(
	captions: readonly VoiceCaption[],
	prepared: readonly DefenseQuestion[],
): DefenseDebrief {
	const committee = captions
		.map((caption, index) => ({ caption, index }))
		.filter((entry) => entry.caption.role === "assistant");
	const questions = prepared.map((question): DebriefQuestionReview => {
		let best: { similarity: number; index: number } | null = null;
		for (const entry of committee) {
			const similarity = captionSimilarity(
				question.question,
				entry.caption.text,
			);
			if (!best || similarity > best.similarity) {
				best = { similarity, index: entry.index };
			}
		}
		if (!best || best.similarity < DEBRIEF_ASKED_THRESHOLD) {
			return { question, asked: false, similarity: best?.similarity ?? 0 };
		}
		return {
			question,
			asked: true,
			similarity: best.similarity,
			askedText: captions[best.index]?.text,
			userAnswer: collectUserAnswer(captions, best.index),
		};
	});
	return {
		questions,
		askedCount: questions.filter((entry) => entry.asked).length,
		totalCount: questions.length,
	};
}
