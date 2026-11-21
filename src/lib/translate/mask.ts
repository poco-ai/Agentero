/**
 * Protect tokens that MT engines mangle (inline math, LaTeX commands, URLs,
 * DOIs, citation markers, cross-references, and Markdown links) by swapping
 * them for opaque placeholders before the request and restoring them afterwards.
 */

import { findPreservedLinkSpans } from "@/lib/translate/preserved-links";

export type MaskedToken = {
	placeholder: string;
	original: string;
};

export type MaskedText = {
	text: string;
	tokens: MaskedToken[];
};

export type RestoredText = {
	text: string;
	/** Placeholders the engine dropped or rewrote; caller decides retry policy. */
	missing: number;
	/** Duplicated or invented placeholders invalidate structural restoration. */
	invalid?: boolean;
};

/**
 * Mathematical white square brackets: absent from paper prose, and left alone
 * by MT engines far more reliably than ASCII brackets, which collide with
 * citation markers and with the `[[n]]` batch numbering.
 */
function placeholderFor(index: number): string {
	return `⟦${index}⟧`;
}

const MASK_PATTERNS: RegExp[] = [
	/⟪(?:F|\/?S)\d+⟫/gu,
	// Consume display and inline forms together so a closing $$ cannot start
	// an inline match across the prose before the next formula.
	/\$\$[^$]{1,400}\$\$|\$[^$\n]{1,200}\$|\\\((?:[^\\]|\\[^)]){1,200}?\\\)/g,
	// LaTeX commands with or without a braced argument.
	/\\[A-Za-z]+(?:\{[^{}]{0,120}\})?/g,
	// Links and identifiers.
	/\bdoi:\s*10\.\d{4,9}\/\S+/gi,
	/\b10\.\d{4,9}\/[^\s、，。]+/g,
];

export function maskInlineTokens(text: string): MaskedText {
	// Match against the original source only. An enclosing TeX expression or
	// Markdown link owns its inner formula/citation markers as one atomic span.
	const spans: { start: number; end: number }[] = findPreservedLinkSpans(text);
	for (const pattern of MASK_PATTERNS) {
		for (const match of text.matchAll(
			new RegExp(pattern.source, pattern.flags),
		)) {
			spans.push({ start: match.index, end: match.index + match[0].length });
		}
	}
	spans.sort((a, b) => a.start - b.start || b.end - a.end);
	const tokens: MaskedToken[] = [];
	let masked = "";
	let cursor = 0;
	for (const span of spans) {
		if (span.start < cursor) continue;
		const placeholder = placeholderFor(tokens.length);
		tokens.push({ placeholder, original: text.slice(span.start, span.end) });
		masked += text.slice(cursor, span.start) + placeholder;
		cursor = span.end;
	}
	masked += text.slice(cursor);
	return { text: masked, tokens };
}

export function restoreInlineTokens(
	text: string,
	tokens: readonly MaskedToken[],
): RestoredText {
	let out = text;
	let missing = 0;
	let invalid = false;
	const known = new Set(tokens.map((token) => token.placeholder.slice(1, -1)));
	for (const match of text.matchAll(/⟦\s*(\d+)\s*⟧/g)) {
		if (!known.has(match[1] ?? "")) invalid = true;
	}
	for (const token of tokens) {
		// Engines sometimes pad the brackets ("⟦ 0 ⟧") or drop the token entirely.
		const body = token.placeholder.slice(1, -1);
		if ([...text.matchAll(new RegExp(`⟦\\s*${body}\\s*⟧`, "g"))].length > 1)
			invalid = true;
		if (!new RegExp(`⟦\\s*${body}\\s*⟧`).test(out)) {
			missing += 1;
			continue;
		}
		out = out.replace(
			new RegExp(`⟦\\s*${body}\\s*⟧`, "g"),
			() => token.original,
		);
	}
	return invalid
		? { text: out, missing, invalid: true }
		: { text: out, missing };
}
