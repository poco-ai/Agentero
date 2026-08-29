/**
 * Pre-translation source cleanup and paragraph re-assembly for layout regions.
 *
 * The PDF text layer reaches us space-collapsed (see `title-text.ts`), so
 * line-break hyphenation, ligatures and header/footer runs are spliced into the
 * prose; and a paragraph continued in the next column or on the next page is a
 * separate layout region. Both wreck translation quality, so normalize the text
 * and chain continuation fragments into one translation unit (#340).
 */

import type {
	LayoutTranslateItem,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";

/** Members of one chain are translated together, then split back per bbox. */
export type LayoutTranslateChain = {
	/** Reading-order fragments; length 1 for a self-contained paragraph. */
	members: LayoutTranslateItem[];
	/** Joined source actually sent to the engine. */
	source: string;
};

/** Keep a chain under the Host `MAX_TEXT_CHARS` (5000) with headroom. */
export const LAYOUT_TRANSLATE_CHAIN_MAX_CHARS = 4000;
export const LAYOUT_TRANSLATE_CHAIN_MAX_MEMBERS = 4;

const LIGATURES: readonly [RegExp, string][] = [
	[/\uFB00/g, "ff"],
	[/\uFB01/g, "fi"],
	[/\uFB02/g, "fl"],
	[/\uFB03/g, "ffi"],
	[/\uFB04/g, "ffl"],
	[/[\uFB05\uFB06]/g, "st"],
];

/** Running header / footer boilerplate that sits inside a body bbox. */
const STAMP_PATTERNS: readonly RegExp[] = [
	/arXiv:\s*\d{4}\.\d{4,5}(?:v\d+)?(?:\s*\[[^\]]{1,24}\])?(?:\s*\d{1,2}\s+[A-Z][a-z]{2,8}\s+\d{4})?/gi,
	/\b(?:Under review|Published|Accepted|Presented)\s+as\s+a\s+(?:conference|workshop|journal)\s+paper\s+at\b[^.]{0,64}?\d{4}\.?/gi,
	/Preprint\.\s*(?:Under review\.\s*)?/g,
];

/** Line-break hyphenation: "repre- sentation" → "representation". */
const HYPHEN_BREAK = /(\p{Ll})[-\u2010\u2011\u2012\u2013]\s+(\p{Ll}+)/gu;

/** "pre- and post-training" is a real construction, not a broken word. */
const HYPHEN_KEEP_NEXT = /^(?:and|or|nor|but|to|vs|versus|per|than)$/i;

const REF_WORD_BEFORE_NUMBER =
	/(?:tables?|figures?|fig\.?|sections?|sec\.?|eqs?\.?|equations?|chapters?|appendix|algorithms?|theorems?|lemmas?|definitions?|pages?|no\.?|version|v\.?|steps?|stages?|phases?|tasks?|levels?|types?|classes?)$/i;

function isLayoutBodyLikeKind(kind: PdfLayoutRegion["kind"]): boolean {
	return kind === "text" || kind === "abstract";
}

/**
 * Drop a page/line number glued to a body paragraph's edge. Only fires on
 * unambiguous shapes: a bare number after a sentence end, or a leading number
 * followed by lowercase prose (a mid-sentence continuation fragment).
 */
function stripEdgeNumbers(text: string): string {
	const out = text.replace(/^(\d{1,4})\s+(?=\p{Ll})/u, "");
	return out.replace(
		/([.!?。！？])\s+\d{1,4}\s*$/u,
		(full, end: string, offset: number) => {
			const lastWord = out.slice(0, offset).trimEnd().split(/\s+/).pop() ?? "";
			return REF_WORD_BEFORE_NUMBER.test(lastWord) ? full : end;
		},
	);
}

/**
 * Clean one region's PDF text before it is sent to a translation engine.
 * Input is the space-collapsed text layer extract; output stays single-line.
 */
export function normalizeLayoutSourceText(
	raw: string,
	kind?: PdfLayoutRegion["kind"],
): string {
	let out = raw.normalize("NFC").replace(/\u00AD/g, "");
	for (const [pattern, replacement] of LIGATURES) {
		out = out.replace(pattern, replacement);
	}
	out = out.replace(/[\u00A0\u2007\u202F\u2028\u2029]/g, " ");
	for (const pattern of STAMP_PATTERNS) {
		out = out.replace(new RegExp(pattern.source, pattern.flags), " ");
	}
	out = out.replace(HYPHEN_BREAK, (full, head: string, tail: string) =>
		HYPHEN_KEEP_NEXT.test(tail) ? full : `${head}${tail}`,
	);
	out = out.replace(/\s+/g, " ").trim();
	if (!kind || isLayoutBodyLikeKind(kind)) out = stripEdgeNumbers(out).trim();
	return out.replace(/\s+/g, " ").trim();
}

/** Only body prose continues across columns and pages. */
export function isLayoutContinuationKind(
	kind: PdfLayoutRegion["kind"],
): boolean {
	return isLayoutBodyLikeKind(kind);
}

/** Sentence-final punctuation, optionally closed by a quote or bracket. */
const SENTENCE_END = /[.!?。！？；;:：][”’"')\]]?$/u;

type ContinuationSide = {
	kind: PdfLayoutRegion["kind"];
	pageIndex: number;
	source: string;
};

/** True when `next` continues the paragraph started by `prev`. */
export function isLayoutParagraphContinuation(
	prev: ContinuationSide,
	next: ContinuationSide,
): boolean {
	if (!isLayoutContinuationKind(prev.kind)) return false;
	if (!isLayoutContinuationKind(next.kind)) return false;
	const pageGap = next.pageIndex - prev.pageIndex;
	if (pageGap < 0 || pageGap > 1) return false;
	const head = prev.source.trim();
	const tail = next.source.trim();
	if (!head || !tail) return false;
	// Source truncated at LAYOUT_TRANSLATE_MAX_CHARS: the join would be wrong.
	if (head.endsWith("…")) return false;
	if (/[-\u2010\u2011]$/.test(head)) return true;
	if (SENTENCE_END.test(head)) return false;
	return /^[\p{Ll}(,]/u.test(tail);
}

/** Join two fragments, healing a hyphen left at the column/page break. */
export function joinContinuationSources(head: string, tail: string): string {
	const left = head.trimEnd();
	const right = tail.trimStart();
	if (/[-\u2010\u2011]$/.test(left) && /^\p{Ll}/u.test(right)) {
		return `${left.slice(0, -1)}${right}`;
	}
	return `${left} ${right}`;
}

/**
 * Group reading-order items into translation units. Captions between two body
 * fragments are their own unit and do not break the chain (a figure often
 * interrupts a paragraph); a header does break it.
 */
export function buildLayoutTranslateChains(
	items: readonly LayoutTranslateItem[],
): LayoutTranslateChain[] {
	const chains: LayoutTranslateChain[] = [];
	let open: LayoutTranslateChain | null = null;
	for (const item of items) {
		if (!isLayoutContinuationKind(item.kind)) {
			chains.push({ members: [item], source: item.source });
			// figure/table captions interrupt the layout, not the paragraph.
			if (item.kind !== "figure_title") open = null;
			continue;
		}
		const last = open?.members.at(-1);
		if (open && last && isLayoutParagraphContinuation(last, item)) {
			const joined = joinContinuationSources(open.source, item.source);
			if (
				open.members.length < LAYOUT_TRANSLATE_CHAIN_MAX_MEMBERS &&
				joined.length <= LAYOUT_TRANSLATE_CHAIN_MAX_CHARS
			) {
				open.members.push(item);
				open.source = joined;
				continue;
			}
		}
		open = { members: [item], source: item.source };
		chains.push(open);
	}
	return chains;
}

const STRONG_BOUNDARY = /[.!?。！？]/;
const WEAK_BOUNDARY = /[,，、;；:：)）]/;

function isBoundaryAt(text: string, pos: number, matcher: RegExp): boolean {
	const ch = text[pos - 1];
	if (!ch || !matcher.test(ch)) return false;
	// Latin punctuation must be followed by a space, so "0.5" is not a boundary.
	if (/[\u3000-\u303f\uff00-\uffef]/.test(ch)) return true;
	const next = text[pos];
	return next === undefined || /\s/.test(next);
}

function findCut(text: string, target: number, min: number): number {
	const window = Math.max(12, Math.round(text.length * 0.15));
	const lo = Math.max(min + 1, 1);
	const hi = text.length - 1;
	if (lo > hi) return hi;
	const start = Math.min(Math.max(target, lo), hi);
	for (const matcher of [STRONG_BOUNDARY, WEAK_BOUNDARY]) {
		for (let d = 0; d <= window; d++) {
			for (const pos of d === 0 ? [start] : [start - d, start + d]) {
				if (pos < lo || pos > hi) continue;
				if (!isBoundaryAt(text, pos, matcher)) continue;
				let cut = pos;
				while (cut < hi && /\s/.test(text[cut] ?? "")) cut += 1;
				if (cut > min && cut < text.length) return cut;
			}
		}
	}
	for (let d = 0; d <= window; d++) {
		for (const pos of d === 0 ? [start] : [start - d, start + d]) {
			if (pos < lo || pos > hi) continue;
			if (/\s/.test(text[pos] ?? "")) return pos + 1;
		}
	}
	return start;
}

/**
 * Split one chain's translation back across its members, weighted by each
 * member's source length (a proxy for the box's capacity). Cuts land on
 * sentence, then clause, then word boundaries near the proportional target.
 */
export function splitChainTranslation(
	translated: string,
	weights: readonly number[],
): string[] {
	const text = translated.trim();
	if (weights.length <= 1) return [text];
	const safeWeights = weights.map((w) => Math.max(1, w));
	const total = safeWeights.reduce((sum, w) => sum + w, 0);
	const cuts: number[] = [];
	let acc = 0;
	let prev = 0;
	for (let i = 0; i < safeWeights.length - 1; i++) {
		acc += safeWeights[i] ?? 1;
		const target = Math.round((acc / total) * text.length);
		const cut = findCut(text, target, prev);
		cuts.push(cut);
		prev = cut;
	}
	const slice = (positions: readonly number[]): string[] => {
		const out: string[] = [];
		let start = 0;
		for (const cut of positions) {
			out.push(text.slice(start, cut).trim());
			start = cut;
		}
		out.push(text.slice(start).trim());
		return out;
	};
	const segments = slice(cuts);
	if (segments.every((seg) => seg.length > 0)) return segments;
	// Boundary search collapsed a segment — fall back to proportional cuts.
	const evenCuts: number[] = [];
	let evenAcc = 0;
	for (let i = 0; i < safeWeights.length - 1; i++) {
		evenAcc += safeWeights[i] ?? 1;
		evenCuts.push(
			Math.min(
				text.length,
				Math.max(i + 1, Math.round((evenAcc / total) * text.length)),
			),
		);
	}
	return slice(evenCuts);
}
