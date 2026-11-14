/**
 * Re-attach PDF link annotations to preserved tokens inside a translated block.
 *
 * English link rectangles stay under the translation glyphs so they do not
 * block selection. The tokens themselves (`[12]`, `Fig. 3`, a URL) are the
 * hit targets, matched in reading order to the links that overlap the block.
 */

import {
	findPreservedLinkSpans,
	type PreservedLinkSpan,
	trimPreservedUrl,
} from "@/lib/translate/preserved-links";

export type NormBox = {
	x: number;
	y: number;
	w: number;
	h: number;
};

export type TranslateLinkBox = {
	key: string;
	kind: "goto" | "url";
	box: NormBox;
	url?: string;
	/** Raw PDF fill `#rrggbb`. Omitted when the link has no chromatic ink. */
	color?: string;
};

/** One PDF text run, in normalized page fractions. */
export type GlyphRun = {
	text: string;
	box: NormBox;
};

/**
 * Source text and glyphs for the block being painted.
 * `source` keeps a reordered clause on the citation it came from.
 * Glyphs keep a multi-number citation from borrowing the next citation.
 */
export type LinkAssignContext = {
	/** English text this block was translated from. */
	source?: string;
	block?: NormBox;
	runs?: readonly GlyphRun[];
};

export type PreservedLinkAssignment = {
	start: number;
	end: number;
	text: string;
	/** PDF annotation id, when this span drives an in-document link. */
	key: string | null;
	url?: string;
	/** Raw PDF fill `#rrggbb`, before paper-tone adjustment. */
	color?: string;
};

type LinkHost = {
	id: string;
	bbox: NormBox;
	readingOrder: number;
};

function contains(box: NormBox, x: number, y: number): boolean {
	return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

function intersectionArea(a: NormBox, b: NormBox): number {
	const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
	if (w <= 0 || h <= 0) return 0;
	return w * h;
}

/**
 * Reading order. Rects on one line often differ by a fraction of a point, so
 * sorting on raw top edges puts a later citation first and a bracket group
 * collapses onto a single link.
 */
function sortByReading<T extends { box: NormBox }>(items: readonly T[]): T[] {
	const sorted = [...items].sort(
		(a, b) =>
			a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2) || a.box.x - b.box.x,
	);
	const lines: T[][] = [];
	for (const item of sorted) {
		const cy = item.box.y + item.box.h / 2;
		const line = lines[lines.length - 1];
		const head = line?.[0];
		const headCy = head ? head.box.y + head.box.h / 2 : 0;
		const height = Math.max(head?.box.h ?? 0, item.box.h, 0.004);
		if (!line || !head || Math.abs(cy - headCy) > height * 0.6) {
			lines.push([item]);
		} else {
			line.push(item);
		}
	}
	return lines.flatMap((line) => line.sort((a, b) => a.box.x - b.box.x));
}

/** Same hit rectangle. EmbedPDF can list one PDF link many times. */
function sameRect(a: NormBox, b: NormBox): boolean {
	const close = (left: number, right: number) =>
		Math.abs(left - right) < 0.0005;
	return (
		close(a.x, b.x) && close(a.y, b.y) && close(a.w, b.w) && close(a.h, b.h)
	);
}

/**
 * One entry per rectangle. Repeated copies of the same link sit on top of
 * each other and would break the gap test that separates `[17,38]`.
 */
function dedupeTranslateLinks(
	links: readonly TranslateLinkBox[],
): TranslateLinkBox[] {
	const kept: TranslateLinkBox[] = [];
	for (const link of links) {
		const duplicate = kept.some(
			(prev) =>
				prev.kind === link.kind &&
				(prev.url ?? "") === (link.url ?? "") &&
				sameRect(prev.box, link.box),
		);
		if (!duplicate) kept.push(link);
	}
	return kept;
}

/**
 * Give each link to the translated block that contains its center, else the
 * block with the largest overlap. Each link is claimed once.
 */
export function claimTranslateLinks<T extends LinkHost>(
	items: readonly T[],
	links: readonly TranslateLinkBox[],
): Map<string, TranslateLinkBox[]> {
	const ordered = [...items].sort(
		(a, b) => a.readingOrder - b.readingOrder || a.bbox.y - b.bbox.y,
	);
	const map = new Map<string, TranslateLinkBox[]>();
	for (const item of ordered) map.set(item.id, []);
	for (const link of dedupeTranslateLinks(links)) {
		const cx = link.box.x + link.box.w / 2;
		const cy = link.box.y + link.box.h / 2;
		let host = ordered.find((item) => contains(item.bbox, cx, cy));
		if (!host) {
			let best = 0;
			for (const item of ordered) {
				const area = intersectionArea(item.bbox, link.box);
				if (area > best) {
					best = area;
					host = item;
				}
			}
		}
		if (!host) continue;
		map.get(host.id)?.push(link);
	}
	for (const [id, list] of map) map.set(id, sortByReading(list));
	return map;
}

function urlsMatch(a: string, b: string): boolean {
	return (
		trimPreservedUrl(a).toLowerCase() === trimPreservedUrl(b).toLowerCase()
	);
}

function withLinkColor(
	assignment: PreservedLinkAssignment,
	link: TranslateLinkBox | undefined,
): PreservedLinkAssignment {
	if (!link?.color) return assignment;
	return { ...assignment, color: link.color };
}

type TextPiece = { start: number; end: number; text: string };

/**
 * About 18 pt on an A4 page. A comma inside `[17, 38]` is inside this, and so
 * is a normal word space, so the gap alone cannot separate `[17,38]` from a
 * following `[46]`. The glyph test is what draws that line. This gap only
 * applies when the source glyphs are not loaded yet.
 */
const CLUSTER_GAP = 0.03;
/** How far a link center may sit outside a source glyph and still belong to it. */
const TOKEN_HIT_PAD = 0.003;

function numberPieces(span: PreservedLinkSpan): TextPiece[] {
	const pieces: TextPiece[] = [];
	for (const match of span.text.matchAll(/[0-9]+(?:\.[0-9]+)?[a-z]?/gi)) {
		const rel = match.index ?? 0;
		const text = match[0];
		pieces.push({
			start: span.start + rel,
			end: span.start + rel + text.length,
			text,
		});
	}
	return pieces;
}

function semicolonPieces(span: PreservedLinkSpan): TextPiece[] {
	const pieces: TextPiece[] = [];
	for (const match of span.text.matchAll(/[^;；]+/g)) {
		const raw = match[0];
		const rel = match.index ?? 0;
		let start = span.start + rel;
		let end = start + raw.length;
		let text = raw;
		const lead = text.match(/^[(（\s]+/);
		if (lead?.[0]) {
			start += lead[0].length;
			text = text.slice(lead[0].length);
		}
		const trail = text.match(/[\s)）]+$/);
		if (trail?.[0]) {
			end -= trail[0].length;
			text = text.slice(0, text.length - trail[0].length);
		}
		if (!text) continue;
		pieces.push({ start, end, text });
	}
	return pieces;
}

/**
 * A preserved token can hide several PDF links (`[17,38]`, `Fig. 1-2`,
 * two author-year cites). Each atom is a separate hit target.
 */
function splittablePieces(span: PreservedLinkSpan): TextPiece[] | null {
	if (span.kind === "citation" && /^[[［]/.test(span.text)) {
		const pieces = numberPieces(span);
		return pieces.length >= 2 ? pieces : null;
	}
	if (span.kind === "citation" && /[;；]/.test(span.text)) {
		const pieces = semicolonPieces(span);
		return pieces.length >= 2 ? pieces : null;
	}
	if (span.kind === "ref") {
		const pieces = numberPieces(span);
		return pieces.length >= 2 ? pieces : null;
	}
	return null;
}

function sameLinkCluster(a: TranslateLinkBox, b: TranslateLinkBox): boolean {
	const line = Math.max(a.box.h, b.box.h, 0.004);
	const dy = Math.abs(a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2));
	if (dy > Math.max(line * 0.9, 0.008)) return false;
	const gap = b.box.x - (a.box.x + a.box.w);
	return gap >= -0.008 && gap <= CLUSTER_GAP;
}

/**
 * A rect that already covers the whole group is wider than the next citation.
 * Do not treat that next citation as another number inside the group.
 */
function canExtendCluster(
	prev: TranslateLinkBox,
	next: TranslateLinkBox,
): boolean {
	if (!sameLinkCluster(prev, next)) return false;
	return prev.box.w < next.box.w * 1.75;
}

function adjacentGotos(
	gotos: readonly TranslateLinkBox[],
	start: number,
	limit: number,
	used: Set<string>,
): TranslateLinkBox[] {
	const first = gotos[start];
	if (!first || used.has(first.key) || limit < 2) return [];
	const group = [first];
	for (
		let index = start + 1;
		index < gotos.length && group.length < limit;
		index++
	) {
		const next = gotos[index];
		const prev = group[group.length - 1];
		if (!next || !prev || used.has(next.key) || !canExtendCluster(prev, next)) {
			break;
		}
		group.push(next);
	}
	return group;
}

function padBox(box: NormBox, pad: number): NormBox {
	return {
		x: box.x - pad,
		y: box.y - pad,
		w: box.w + pad * 2,
		h: box.h + pad * 2,
	};
}

type GlyphChar = { box: NormBox };

/**
 * Glyphs of the `occurrence`th copy of `token` inside `block`. Whitespace in
 * the PDF run is ignored so `[17, 38]` still matches `[17,38]`.
 */
function tokenChars(
	token: string,
	runs: readonly GlyphRun[],
	block: NormBox,
	occurrence: number,
): GlyphChar[] | null {
	const needle = token.replace(/\s+/g, "");
	if (!needle) return null;
	const ordered = sortByReading(
		runs.filter((run) => {
			if (!run.text) return false;
			const cx = run.box.x + run.box.w / 2;
			const cy = run.box.y + run.box.h / 2;
			return contains(block, cx, cy);
		}),
	);
	const compact: GlyphChar[] = [];
	let hay = "";
	for (const run of ordered) {
		const glyphs = [...run.text];
		if (glyphs.length === 0) continue;
		const step = run.box.w / glyphs.length;
		for (let index = 0; index < glyphs.length; index++) {
			const ch = glyphs[index];
			if (!ch || /\s/.test(ch)) continue;
			hay += ch;
			compact.push({
				box: {
					x: run.box.x + index * step,
					y: run.box.y,
					w: step,
					h: run.box.h,
				},
			});
		}
	}
	let from = 0;
	let at = -1;
	for (let index = 0; index <= occurrence; index++) {
		at = hay.indexOf(needle, from);
		if (at < 0) return null;
		from = at + needle.length;
	}
	const slice = compact.slice(at, at + needle.length);
	return slice.length === needle.length ? slice : null;
}

function centerInChars(
	link: TranslateLinkBox,
	chars: readonly GlyphChar[],
): boolean {
	const cx = link.box.x + link.box.w / 2;
	const cy = link.box.y + link.box.h / 2;
	return chars.some((char) =>
		contains(padBox(char.box, TOKEN_HIT_PAD), cx, cy),
	);
}

/**
 * Unread GoTo links whose centers sit on `chars`, capped at `limit`.
 * Links that are still queued from an earlier unmatched span are skipped
 * until the first center that actually lands on this token. A link past the
 * token ends the group, so a later citation is not pulled in.
 */
function linksInsideChars(
	gotos: readonly TranslateLinkBox[],
	start: number,
	chars: readonly GlyphChar[],
	limit: number,
	used: Set<string>,
): TranslateLinkBox[] {
	if (limit < 2 || chars.length === 0) return [];
	let tokenLeft = chars[0]?.box.x ?? 0;
	let tokenRight = tokenLeft;
	let tokenTop = chars[0]?.box.y ?? 0;
	let tokenBottom = tokenTop;
	for (const char of chars) {
		tokenLeft = Math.min(tokenLeft, char.box.x);
		tokenRight = Math.max(tokenRight, char.box.x + char.box.w);
		tokenTop = Math.min(tokenTop, char.box.y);
		tokenBottom = Math.max(tokenBottom, char.box.y + char.box.h);
	}
	const beforeToken = (link: TranslateLinkBox) => {
		const cx = link.box.x + link.box.w / 2;
		const cy = link.box.y + link.box.h / 2;
		if (cy < tokenTop - 0.004) return true;
		if (cy > tokenBottom + 0.004) return false;
		return cx < tokenLeft - 0.01;
	};
	const group: TranslateLinkBox[] = [];
	let started = false;
	for (
		let index = start;
		index < gotos.length && group.length < limit;
		index++
	) {
		const link = gotos[index];
		if (!link || used.has(link.key)) {
			if (started) break;
			continue;
		}
		if (!centerInChars(link, chars)) {
			if (started || !beforeToken(link)) break;
			continue;
		}
		started = true;
		group.push(link);
	}
	return group;
}

type BoundPart = {
	relStart: number;
	relEnd: number;
	text: string;
	key: string | null;
	url?: string;
	color?: string;
};

type SpanBinding = {
	text: string;
	start: number;
	parts: BoundPart[];
};

function compactToken(text: string): string {
	return text.replace(/\s+/g, "");
}

function partFromAssignment(
	spanStart: number,
	assignment: PreservedLinkAssignment,
): BoundPart {
	const part: BoundPart = {
		relStart: assignment.start - spanStart,
		relEnd: assignment.end - spanStart,
		text: assignment.text,
		key: assignment.key,
	};
	if (assignment.url) part.url = assignment.url;
	if (assignment.color) part.color = assignment.color;
	return part;
}

function assignmentFromPart(
	origin: number,
	part: BoundPart,
): PreservedLinkAssignment {
	const assignment: PreservedLinkAssignment = {
		start: origin + part.relStart,
		end: origin + part.relEnd,
		text: part.text,
		key: part.key,
	};
	if (part.url) assignment.url = part.url;
	if (part.color) assignment.color = part.color;
	return assignment;
}

/**
 * Bind `spans` to `links` in the order those spans appear. Glyph clustering
 * uses the PDF text layer, so this order has to be the English source order.
 */
function collectBindings(
	links: readonly TranslateLinkBox[],
	spans: readonly PreservedLinkSpan[],
	context?: LinkAssignContext,
): SpanBinding[] {
	const used = new Set<string>();
	const gotos = links.filter((link) => link.kind === "goto");
	let gotoIndex = 0;
	const seenTokens = new Map<string, number>();
	const bindings: SpanBinding[] = [];
	for (const span of spans) {
		const parts: BoundPart[] = [];
		const occurrence = seenTokens.get(span.text) ?? 0;
		seenTokens.set(span.text, occurrence + 1);
		const chars =
			context?.block && context.runs && context.runs.length > 0
				? tokenChars(span.text, context.runs, context.block, occurrence)
				: null;
		const pieces = splittablePieces(span);
		if (pieces) {
			const group = chars
				? linksInsideChars(gotos, gotoIndex, chars, pieces.length, used)
				: adjacentGotos(gotos, gotoIndex, pieces.length, used);
			if (group.length === pieces.length) {
				for (let index = 0; index < pieces.length; index++) {
					const piece = pieces[index];
					const goto = group[index];
					if (!piece || !goto) continue;
					used.add(goto.key);
					parts.push(
						partFromAssignment(
							span.start,
							withLinkColor(
								{
									start: piece.start,
									end: piece.end,
									text: piece.text,
									key: goto.key,
								},
								goto,
							),
						),
					);
				}
				const last = group[group.length - 1];
				const lastAt = last
					? gotos.findIndex((link) => link.key === last.key)
					: -1;
				gotoIndex = lastAt >= 0 ? lastAt + 1 : gotoIndex + pieces.length;
				bindings.push({ text: span.text, start: span.start, parts });
				continue;
			}
		}
		// Glyphs located this span and no link center sits on it. An unlinked
		// interval such as `[0,1]` must not consume the next real citation.
		if (
			!span.url &&
			chars &&
			!gotos.some((link) => !used.has(link.key) && centerInChars(link, chars))
		) {
			bindings.push({ text: span.text, start: span.start, parts: [] });
			continue;
		}
		const hit = matchSpan(span, links, gotos, used, gotoIndex);
		if (hit.gotoIndex !== gotoIndex) gotoIndex = hit.gotoIndex;
		if (hit.assignment)
			parts.push(partFromAssignment(span.start, hit.assignment));
		bindings.push({ text: span.text, start: span.start, parts });
	}
	return bindings;
}

function bindingsInOrder(
	text: string,
	links: readonly TranslateLinkBox[],
	context?: LinkAssignContext,
): PreservedLinkAssignment[] {
	return collectBindings(links, findPreservedLinkSpans(text), context).flatMap(
		(binding) =>
			binding.parts.map((part) => assignmentFromPart(binding.start, part)),
	);
}

/**
 * Translated spans keep the link of the source span with the same label.
 * A label the source does not have falls back to the remaining GoTo order.
 */
function assignBySourceIdentity(
	spans: readonly PreservedLinkSpan[],
	source: string,
	links: readonly TranslateLinkBox[],
	context?: LinkAssignContext,
): PreservedLinkAssignment[] {
	const queues = new Map<string, SpanBinding[]>();
	for (const binding of collectBindings(
		links,
		findPreservedLinkSpans(source),
		context,
	)) {
		const key = compactToken(binding.text);
		const queue = queues.get(key);
		if (queue) queue.push(binding);
		else queues.set(key, [binding]);
	}
	const used = new Set<string>();
	const assigned: PreservedLinkAssignment[] = [];
	const unmatched: PreservedLinkSpan[] = [];
	for (const span of spans) {
		const binding = queues.get(compactToken(span.text))?.shift();
		if (!binding) {
			unmatched.push(span);
			continue;
		}
		if (span.text === binding.text) {
			for (const part of binding.parts) {
				if (part.key) used.add(part.key);
				assigned.push(assignmentFromPart(span.start, part));
			}
			continue;
		}
		const pieces = splittablePieces(span);
		const pieceTexts = pieces?.map((piece) => piece.text).join("\0");
		const boundTexts = binding.parts.map((part) => part.text).join("\0");
		if (pieces && pieceTexts === boundTexts) {
			for (let index = 0; index < pieces.length; index++) {
				const piece = pieces[index];
				const part = binding.parts[index];
				if (!piece || !part) continue;
				if (part.key) used.add(part.key);
				const assignment: PreservedLinkAssignment = {
					start: piece.start,
					end: piece.end,
					text: piece.text,
					key: part.key,
				};
				if (part.url) assignment.url = part.url;
				if (part.color) assignment.color = part.color;
				assigned.push(assignment);
			}
			continue;
		}
		const first = binding.parts[0];
		if (!first) continue;
		if (first.key) used.add(first.key);
		const whole: PreservedLinkAssignment = {
			start: span.start,
			end: span.end,
			text: span.text,
			key: first.key,
		};
		if (first.url) whole.url = first.url;
		if (first.color) whole.color = first.color;
		assigned.push(whole);
	}
	if (unmatched.length > 0) {
		const remaining = links.filter((link) => !used.has(link.key));
		assigned.push(
			...collectBindings(remaining, unmatched).flatMap((binding) =>
				binding.parts.map((part) => assignmentFromPart(binding.start, part)),
			),
		);
	}
	assigned.sort((a, b) => a.start - b.start || a.end - b.end);
	return assigned;
}

/**
 * Pair preserved tokens in `text` with `links` already claimed by this block.
 * URL tokens match by URL. Citation and ref tokens take GoTo links in source
 * order. When `context.source` is set, a translated token keeps the link of
 * the source token with the same label, so a reordered clause still opens
 * the citation it was translated from. A bracket group with several numbers
 * takes one link per number when each of those links sits on that token's
 * glyphs. A following citation on the same line stays with its own token.
 * When the glyph count and the number count disagree, the whole token keeps
 * the first link. A span whose glyphs contain no link center stays plain, so
 * an unlinked interval does not take the next citation.
 */
export function assignPreservedLinks(
	text: string,
	links: readonly TranslateLinkBox[],
	context?: LinkAssignContext,
): PreservedLinkAssignment[] {
	const unique = dedupeTranslateLinks(links);
	const spans = findPreservedLinkSpans(text);
	if (!spans.length || !unique.length) {
		return spans
			.filter((span) => span.url)
			.map((span) => ({
				start: span.start,
				end: span.end,
				text: span.text,
				key: null,
				url: span.url,
			}));
	}
	const source = context?.source;
	if (source && source !== text && findPreservedLinkSpans(source).length > 0) {
		return assignBySourceIdentity(spans, source, unique, context);
	}
	return bindingsInOrder(text, unique, context);
}

function matchSpan(
	span: PreservedLinkSpan,
	links: readonly TranslateLinkBox[],
	gotos: readonly TranslateLinkBox[],
	used: Set<string>,
	gotoIndex: number,
): { assignment: PreservedLinkAssignment | null; gotoIndex: number } {
	if (span.url) {
		const byUrl = links.find(
			(link) =>
				link.kind === "url" &&
				link.url &&
				!used.has(link.key) &&
				urlsMatch(link.url, span.url ?? ""),
		);
		if (byUrl) {
			used.add(byUrl.key);
			return {
				gotoIndex,
				assignment: withLinkColor(
					{
						start: span.start,
						end: span.end,
						text: span.text,
						key: byUrl.key,
						url: byUrl.url,
					},
					byUrl,
				),
			};
		}
		return {
			gotoIndex,
			assignment: {
				start: span.start,
				end: span.end,
				text: span.text,
				key: null,
				url: span.url,
			},
		};
	}
	const goto = gotos[gotoIndex];
	if (!goto || used.has(goto.key)) {
		return { assignment: null, gotoIndex };
	}
	used.add(goto.key);
	return {
		gotoIndex: gotoIndex + 1,
		assignment: withLinkColor(
			{
				start: span.start,
				end: span.end,
				text: span.text,
				key: goto.key,
			},
			goto,
		),
	};
}

/** Assignments that sit entirely inside `[start, end)`, shifted to that slice. */
export function assignmentsWithin(
	assignments: readonly PreservedLinkAssignment[],
	start: number,
	end: number,
): PreservedLinkAssignment[] {
	const sliced: PreservedLinkAssignment[] = [];
	for (const assignment of assignments) {
		if (assignment.start < start || assignment.end > end) continue;
		sliced.push({
			...assignment,
			start: assignment.start - start,
			end: assignment.end - start,
		});
	}
	return sliced;
}
