/**
 * Citation, cross-reference, and link tokens that machine translation drops
 * or rewrites. Callers mask them before the request and, after restore, use
 * the same spans to put click targets back on the translated text.
 */

export type PreservedLinkKind = "markdown" | "url" | "citation" | "ref";

export type PreservedLinkSpan = {
	kind: PreservedLinkKind;
	start: number;
	end: number;
	text: string;
	/** Markdown or bare URL target. Citation and ref spans leave this empty. */
	url?: string;
};

const MARKDOWN_LINK = /\[([^\]\n]{1,240})\]\((https?:\/\/[^\s<>\]]+)\)/gi;
const URL_LINK = /https?:\/\/[^\s、，。<>\]]+/gi;

/**
 * Drop sentence punctuation glued to a URL. A `)` stays when it closes a
 * parenthesis that belongs to the URL (`Function_(mathematics)`); it is
 * removed only when the slice has more closing parens than opening ones.
 */
export function trimPreservedUrl(raw: string): string {
	let end = raw.length;
	while (end > 0) {
		const ch = raw[end - 1];
		if (ch && /[.,;:!?]/.test(ch)) {
			end--;
			continue;
		}
		if (ch === ")" && parenBalance(raw.slice(0, end)) < 0) {
			end--;
			continue;
		}
		break;
	}
	return raw.slice(0, end);
}

/** Opening parens minus closing parens. Negative means a prose `)` is left over. */
function parenBalance(text: string): number {
	let balance = 0;
	for (const ch of text) {
		if (ch === "(") balance++;
		else if (ch === ")") balance--;
	}
	return balance;
}
const CITATION_LINK =
	/[[［]\s*[0-9]+[a-z]?(?:\s*[-–—−~,，]\s*[0-9]+[a-z]?)*\s*[\]］]/gi;
const REF_NUMBER = String.raw`(?:\d+(?:\.\d+)?[a-z]?|[ivxlcdm]+\b)(?:\([a-z]\d*\))?`;
const REF_LINK = new RegExp(
	String.raw`(?:\b(?:Figures?|Figs?\.|Tables?|Tabs?\.|Sections?|Secs?\.|Equations?|Eqs?\.|Eqn?\.|Algorithms?|Algs?\.|Theorems?|Lemmas?|Appendices|Appendix)|[图圖表式])\s*\(?${REF_NUMBER}(?:\s*[-–—−]\s*\(?${REF_NUMBER})?\)?(?:\s*(?:,\s*(?:and\s+)?|and\s+)\d+\([a-z]\))*`,
	"gi",
);
const AUTHOR_NAME = "(?:[A-Z][A-Za-z'’-]{1,40}|[\\u4e00-\\u9fff]{1,12})";
// PDF text often pads the parenthesis and the comma. Machine translation
// then rewrites them to fullwidth brackets, a Chinese comma, and 等人.
const AUTHOR_TAIL =
	"(?:\\s*et\\s+al\\.?|\\s*(?:and|&)\\s+[A-Z][A-Za-z'’-]{1,40}|等人|等)?";
const AUTHOR_CITE = `${AUTHOR_NAME}${AUTHOR_TAIL}\\s*[,，]\\s*\\d{4}[a-z]?(?:\\s*年)?`;
const AUTHOR_YEAR = new RegExp(
	`[(（]\\s*${AUTHOR_CITE}(?:\\s*[;；]\\s*${AUTHOR_CITE})*\\s*[)）]`,
	"g",
);

function isBatchMarker(text: string, start: number, end: number): boolean {
	return text[start - 1] === "[" && text[end] === "]";
}

function pushMatches(
	text: string,
	pattern: RegExp,
	kind: PreservedLinkKind,
	spans: PreservedLinkSpan[],
	accept?: (match: RegExpMatchArray) => PreservedLinkSpan | null,
): void {
	const flags = pattern.flags.includes("g")
		? pattern.flags
		: `${pattern.flags}g`;
	const re = new RegExp(pattern.source, flags);
	for (const match of text.matchAll(re)) {
		const start = match.index ?? 0;
		const span = accept
			? accept(match)
			: { kind, start, end: start + match[0].length, text: match[0] };
		if (!span || span.end <= span.start) continue;
		if (kind === "citation" && isBatchMarker(text, span.start, span.end)) {
			continue;
		}
		spans.push(span);
	}
}

/**
 * Non-overlapping link-like spans in reading order. Longer matches win when
 * two patterns cover the same characters, so a Markdown link is not also
 * reported as a bare URL.
 */
export function findPreservedLinkSpans(text: string): PreservedLinkSpan[] {
	if (!text) return [];
	const found: PreservedLinkSpan[] = [];
	pushMatches(text, MARKDOWN_LINK, "markdown", found, (match) => {
		const start = match.index ?? 0;
		let url = match[2] ?? "";
		let end = start + match[0].length;
		// The markdown closer can be a `)` that belongs to the URL. Pull those
		// back in until the URL's parentheses balance.
		while (parenBalance(url) > 0 && text[end] === ")") {
			url += ")";
			end += 1;
		}
		url = trimPreservedUrl(url);
		if (!url) return null;
		return {
			kind: "markdown",
			start,
			end,
			text: text.slice(start, end),
			url,
		};
	});
	pushMatches(text, URL_LINK, "url", found, (match) => {
		const start = match.index ?? 0;
		const trimmed = trimPreservedUrl(match[0]);
		if (!trimmed) return null;
		return {
			kind: "url",
			start,
			end: start + trimmed.length,
			text: trimmed,
			url: trimmed,
		};
	});
	pushMatches(text, CITATION_LINK, "citation", found);
	pushMatches(text, REF_LINK, "ref", found);
	pushMatches(text, AUTHOR_YEAR, "citation", found);
	found.sort((a, b) => a.start - b.start || b.end - a.end);
	const kept: PreservedLinkSpan[] = [];
	let cursor = 0;
	for (const span of found) {
		if (span.start < cursor) continue;
		kept.push(span);
		cursor = span.end;
	}
	return kept;
}
