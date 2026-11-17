/**
 * Sentence under the layout-element pointer.
 * Subscribers paint DOM. Pointer moves do not render the page tree.
 * Source and `::translation` panes share one catalog keyed by paper scope.
 * An empty publish from either pane does not erase the other's sentence pairs.
 */

import type { PdfEngine, Rect } from "@embedpdf/models";
import {
	type ElementSentenceHit,
	type ElementSentenceMember,
	elementSentenceAtPoint,
	mergeSentenceItems,
	type SentenceFractionRect,
	type SentenceItem,
	sourceSentenceHoverBands,
} from "@/lib/pdf/layout/element-sentence";
import {
	reflowSentenceGlyphRects,
	sentenceGlyphRects,
} from "@/lib/pdf/layout/layout-sentence-selection";
import { splitLayoutSentences } from "@/lib/pdf/layout/layout-sentences";
import { orderByReadingLine } from "@/lib/pdf/layout/reading-order";
import { layoutSentenceScope } from "@/lib/pdf/layout/store";
import {
	getTranslatedLinkSource,
	subscribeTranslatedLinkSource,
} from "@/lib/pdf/layout/translated-link-source";
import type { Paragraph } from "@/lib/pdf/reflow/types";
import {
	pageSelectionInkRects,
	selectionGlyphInkRect,
} from "@/lib/pdf/selection-appearance";

export type LayoutSentenceMember = ElementSentenceMember & {
	rects: SentenceFractionRect[];
};

export type LayoutSentenceHover = Omit<ElementSentenceHit, "members"> & {
	docId: string;
	regionId: string;
	pageIndex: number;
	members: LayoutSentenceMember[];
};

type CatalogItem = SentenceItem & {
	reflow?: Paragraph;
	bbox: { x: number; y: number; w: number; h: number };
	source: string;
	raw?: string;
};

type GlyphDocument = {
	pages: { size: { width: number; height: number } }[];
};

type GlyphSource = {
	docId: string;
	engine: PdfEngine;
	getDocument: () => GlyphDocument | null;
};

type PointerQuery = {
	docId: string;
	regionId: string;
	pageIndex: number;
	x: number;
	y: number;
	span?: { itemId: string; sentenceIndex: number } | null;
};

type CatalogSlot = { scope: string; items: CatalogItem[] };

let hover: LayoutSentenceHover | null = null;
let held: LayoutSentenceHover | null = null;
let lastQuery: PointerQuery | null = null;
let suppressed = false;
const sources = new Map<string, GlyphSource>();

const slots = new Map<string, CatalogSlot>();
const sourcePages = new Map<string, Map<number, CatalogItem>>();
const sourceInk = new Map<string, Map<number, SentenceFractionRect[]>>();
const sourceGlyphs = new Map<
	string,
	Map<number, { text: string; rect: Rect }[]>
>();
const generationByScope = new Map<string, number>();
const glyphs = new Map<string, readonly (readonly SentenceFractionRect[])[]>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();

const catalogCache = new Map<string, CatalogItem[]>();
const lineRectCache = new Map<string, Map<number, SentenceFractionRect[]>>();
const sentenceBandCache = new WeakMap<
	readonly (readonly SentenceFractionRect[])[],
	{ lines: readonly SentenceFractionRect[]; bands: SentenceFractionRect[][] }
>();
const EMPTY_LINE_RECTS: readonly SentenceFractionRect[] = [];

function invalidateCatalog(scope: string): void {
	catalogCache.delete(scope);
	lineRectCache.delete(scope);
}

function glyphKey(scope: string, item: CatalogItem): string {
	const quotes =
		item.sentences?.map((sentence) => sentence.quote).join("\u0001") ?? "";
	return `${scope}:${item.id}:${quotes}`;
}

function scopeGeneration(scope: string): number {
	return generationByScope.get(scope) ?? 0;
}

function bumpScope(scope: string): void {
	invalidateCatalog(scope);
	generationByScope.set(scope, scopeGeneration(scope) + 1);
	for (const key of inflight) {
		if (key.startsWith(`${scope}:`)) inflight.delete(key);
	}
	for (const key of glyphs.keys()) {
		if (key.startsWith(`${scope}:`)) glyphs.delete(key);
	}
}

function scopeStillPublished(scope: string): boolean {
	for (const slot of slots.values()) {
		if (slot.scope === scope) return true;
	}
	return false;
}

function itemsForScope(scope: string): CatalogItem[] {
	const cached = catalogCache.get(scope);
	if (cached) return cached;
	const groups: CatalogItem[][] = [];
	for (const slot of slots.values()) {
		if (slot.scope === scope) groups.push(slot.items);
	}
	const paired = groups
		.flat()
		.filter((item) =>
			item.sentences?.some((sentence) => sentence.translated.trim()),
		);
	const items = mergeSentenceItems(groups).filter(
		(item) =>
			item.sentences?.some((sentence) => sentence.translated.trim()) ||
			!paired.some(
				(partner) =>
					partner.pageIndex === item.pageIndex &&
					partner.sentences?.some((sentence) =>
						item.source
							.replace(/\s+/g, " ")
							.includes(sentence.quote.replace(/\s+/g, " ")),
					),
			),
	);
	for (const item of sourcePages.get(scope)?.values() ?? []) {
		if (!items.some((existing) => existing.pageIndex === item.pageIndex))
			items.push(item);
	}
	catalogCache.set(scope, items);
	return items;
}

function notify(): void {
	for (const listener of listeners) listener();
}

function sameHover(
	a: LayoutSentenceHover | null,
	b: LayoutSentenceHover | null,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (
		a.docId !== b.docId ||
		a.regionId !== b.regionId ||
		a.pageIndex !== b.pageIndex ||
		a.key !== b.key
	) {
		return false;
	}
	if (
		!rectListSame(a.rects, b.rects) ||
		a.members.length !== b.members.length
	) {
		return false;
	}
	for (let index = 0; index < a.members.length; index++) {
		const left = a.members[index];
		const right = b.members[index];
		if (
			!left ||
			!right ||
			left.itemId !== right.itemId ||
			left.sentenceIndex !== right.sentenceIndex
		) {
			return false;
		}
		if (!rectListSame(left.rects, right.rects)) return false;
	}
	return true;
}

function rectListSame(
	left: readonly SentenceFractionRect[],
	right: readonly SentenceFractionRect[],
): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		const a = left[index];
		const b = right[index];
		if (!a || !b) return false;
		if (a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h) return false;
	}
	return true;
}

function publish(next: LayoutSentenceHover | null): void {
	if (held) return;
	if (sameHover(hover, next)) return;
	hover = next;
	notify();
}

export function layoutSentenceHover(): LayoutSentenceHover | null {
	return held ?? hover;
}

export function subscribeLayoutSentenceHover(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function bindLayoutSentenceGlyphs(next: GlyphSource): () => void {
	const scope = layoutSentenceScope(next.docId);
	sources.set(scope, next);
	if (
		lastQuery &&
		!suppressed &&
		layoutSentenceScope(lastQuery.docId) === scope
	)
		applyPointer(lastQuery);
	return () => {
		if (sources.get(scope) !== next) return;
		sources.delete(scope);
		sourcePages.delete(scope);
		sourceInk.delete(scope);
		sourceGlyphs.delete(scope);
		invalidateCatalog(scope);
		if (!scopeStillPublished(scope)) bumpScope(scope);
	};
}

/** Full paragraph ink establishes stable vertical bounds for every sentence slice. */
export function layoutSentenceLineRects(
	docId: string,
	pageIndex: number,
): SentenceFractionRect[] {
	const scope = layoutSentenceScope(docId);
	const cachedInk = sourceInk.get(scope)?.get(pageIndex);
	if (cachedInk?.length) return cachedInk;
	const cachedLines = lineRectCache.get(scope)?.get(pageIndex);
	if (cachedLines) return cachedLines;
	const rects = itemsForScope(scope)
		.filter((item) => item.pageIndex === pageIndex)
		.flatMap((item) => {
			if (!item.reflow || !item.bbox.w || !item.bbox.h) return [];
			const width = item.reflow.box.w / item.bbox.w;
			const height = item.reflow.box.h / item.bbox.h;
			return item.reflow.characters
				.filter((char) => char.text.trim())
				.map((char) => ({
					x: char.visualBox.x / width,
					y: char.visualBox.y / height,
					w: char.visualBox.w / width,
					h: char.visualBox.h / height,
				}));
		});
	const pages =
		lineRectCache.get(scope) ?? new Map<number, SentenceFractionRect[]>();
	pages.set(pageIndex, rects);
	lineRectCache.set(scope, pages);
	return rects;
}

export function publishLayoutSentenceCatalog(
	docId: string,
	items: readonly CatalogItem[],
): void {
	const scope = layoutSentenceScope(docId);
	const previous = slots.get(docId);
	invalidateCatalog(scope);
	if (previous && previous.scope !== scope) invalidateCatalog(previous.scope);
	const nextItems = items.filter((item) => (item.sentences?.length ?? 0) > 0);
	if (nextItems.length === 0) slots.delete(docId);
	else slots.set(docId, { scope, items: nextItems });
	if (
		previous &&
		previous.scope !== scope &&
		!scopeStillPublished(previous.scope)
	) {
		bumpScope(previous.scope);
	}
	if (!scopeStillPublished(scope) && !sources.has(scope)) bumpScope(scope);
	const merged = itemsForScope(scope);
	if (
		hover &&
		layoutSentenceScope(hover.docId) === scope &&
		!merged.some((item) =>
			hover?.members.some((member) => member.itemId === item.id),
		)
	) {
		publish(null);
	}
	notify();
	if (
		lastQuery &&
		!suppressed &&
		layoutSentenceScope(lastQuery.docId) === scope
	) {
		applyPointer(lastQuery);
	}
}

function glyphsFor(
	scope: string,
	pageIndex: number,
): Map<string, readonly (readonly SentenceFractionRect[])[]> {
	const map = new Map<string, readonly (readonly SentenceFractionRect[])[]>();
	const pageLines = layoutSentenceLineRects(scope, pageIndex);
	const lines = pageLines.length ? pageLines : EMPTY_LINE_RECTS;
	for (const item of itemsForScope(scope)) {
		if (item.pageIndex !== pageIndex) continue;
		const cached = glyphs.get(glyphKey(scope, item));
		if (!cached) continue;
		let entry = sentenceBandCache.get(cached);
		if (!entry || entry.lines !== lines) {
			entry = {
				lines,
				bands: cached.map((rects) =>
					sourceSentenceHoverBands(
						rects,
						1000,
						1000,
						lines.length ? lines : undefined,
						0,
					),
				),
			};
			sentenceBandCache.set(cached, entry);
		}
		map.set(item.id, entry.bands);
	}
	return map;
}

function rectsHaveBoxes(
	rects: readonly (readonly SentenceFractionRect[])[],
): boolean {
	return rects.some((list) => list.length > 0);
}

/**
 * The source viewer already reads page text for link ink. Those runs are page
 * fractions of the English glyphs, which is the same space as a layout bbox.
 * Adopting them lets either pane resolve a sentence without a second PDFium
 * read. A later non-empty read replaces an empty cache.
 */
function adoptPublishedRuns(scope: string, pageIndex: number): boolean {
	const published =
		getTranslatedLinkSource(scope).glyphRunsByPage.get(pageIndex);
	if (!published?.length) return false;
	const items = itemsForScope(scope).filter(
		(item) =>
			item.pageIndex === pageIndex &&
			!rectsHaveBoxes(glyphs.get(glyphKey(scope, item)) ?? []),
	);
	if (!items.length) return false;
	const runs = published.map((glyph) => ({
		text: glyph.text,
		rect: {
			origin: { x: glyph.box.x * 1000, y: glyph.box.y * 1000 },
			size: { width: glyph.box.w * 1000, height: glyph.box.h * 1000 },
		},
	}));
	let changed = false;
	for (const item of items) {
		if (!(item.sentences?.length ?? 0)) continue;
		const key = glyphKey(scope, item);
		const existing = glyphs.get(key);
		if (existing && rectsHaveBoxes(existing)) continue;
		const rects = item.sentences?.length
			? sentenceGlyphRects({
					sentences: item.sentences,
					raw: item.raw,
					source: item.source,
					runs,
					pageWidth: 1000,
					pageHeight: 1000,
					bbox: item.bbox,
				})
			: [];
		if (!rectsHaveBoxes(rects)) {
			if (!existing) glyphs.set(key, rects);
			continue;
		}
		glyphs.set(key, rects);
		changed = true;
	}
	return changed;
}

function adoptReflowGlyphs(scope: string, pageIndex: number): void {
	for (const item of itemsForScope(scope)) {
		if (
			item.pageIndex !== pageIndex ||
			!item.reflow ||
			item.bbox.w <= 0 ||
			item.bbox.h <= 0
		)
			continue;
		const key = glyphKey(scope, item);
		if (rectsHaveBoxes(glyphs.get(key) ?? [])) continue;
		const width = item.reflow.box.w / item.bbox.w;
		const height = item.reflow.box.h / item.bbox.h;
		if (!(width > 0) || !(height > 0)) continue;
		const rects = reflowSentenceGlyphRects(item).map((sentence) =>
			sentence.map((rect) => ({
				x: rect.origin.x / width,
				y: rect.origin.y / height,
				w: rect.size.width / width,
				h: rect.size.height / height,
			})),
		);
		if (rectsHaveBoxes(rects)) glyphs.set(key, rects);
	}
}

export function primeLayoutSentenceGlyphs(
	pageIndex: number,
	documentId: string,
): void {
	const scope = layoutSentenceScope(documentId);
	const source = sources.get(scope);
	if (!source) return;
	let items = itemsForScope(scope).filter(
		(item) =>
			item.pageIndex === pageIndex &&
			(item.sentences?.length ?? 0) > 0 &&
			!glyphs.has(glyphKey(scope, item)),
	);
	if (
		items.length === 0 &&
		itemsForScope(scope).some((item) => item.pageIndex === pageIndex) &&
		(layoutSentenceLineRects(scope, pageIndex).length > 0 ||
			sourceInk.get(scope)?.has(pageIndex)) &&
		sourceGlyphs.get(scope)?.has(pageIndex)
	)
		return;
	const captured = scopeGeneration(scope);
	const flight = `${scope}:${pageIndex}:${captured}`;
	if (inflight.has(flight)) return;
	const engine = source.engine;
	const document = source.getDocument();
	const page = document?.pages[pageIndex];
	if (!document || !page || page.size.width <= 0 || page.size.height <= 0)
		return;
	inflight.add(flight);
	void (async () => {
		let runs: { text: string; rect: Rect }[] = [];
		try {
			const pageRuns = await engine
				.getPageTextRuns(
					document as Parameters<PdfEngine["getPageTextRuns"]>[0],
					page as Parameters<PdfEngine["getPageTextRuns"]>[1],
				)
				.toPromise();
			runs = (pageRuns?.runs ?? []).map((run) => ({
				text: run.text ?? "",
				rect: run.rect,
			}));
		} catch {
			runs = [];
		}
		if (captured !== scopeGeneration(scope) || sources.get(scope) !== source) {
			return;
		}

		if (!items.length && runs.length) {
			const ordered = orderByReadingLine(runs, (run) => ({
				x: run.rect.origin.x,
				y: run.rect.origin.y,
				width: run.rect.size.width,
				height: run.rect.size.height,
			}));
			const text = ordered
				.map((run) => run.text.trim())
				.filter(Boolean)
				.join(" ");
			const item: CatalogItem = {
				id: `source-page-${pageIndex}`,
				pageIndex,
				bbox: { x: 0, y: 0, w: 1, h: 1 },
				source: text,
				sentences: splitLayoutSentences(text).map((quote) => ({
					quote,
					translated: "",
				})),
			};
			const pages = sourcePages.get(scope) ?? new Map<number, CatalogItem>();
			pages.set(pageIndex, item);
			sourcePages.set(scope, pages);
			invalidateCatalog(scope);
			items = [item];
		}
		for (const item of items) {
			const key = glyphKey(scope, item);
			if (rectsHaveBoxes(glyphs.get(key) ?? [])) continue;
			const rects = item.sentences?.length
				? sentenceGlyphRects({
						sentences: item.sentences,
						raw: item.raw,
						source: item.source,
						runs,
						pageWidth: page.size.width,
						pageHeight: page.size.height,
						bbox: item.bbox,
					})
				: [];
			glyphs.set(key, rects);
		}
		if (
			lastQuery &&
			!suppressed &&
			layoutSentenceScope(lastQuery.docId) === scope
		) {
			applyPointer(lastQuery);
		} else notify();
		// Text-run bounds include font leading. Only glyph ink defines the line tint.
		if (!sourceGlyphs.get(scope)?.has(pageIndex)) {
			try {
				const geometry = await engine
					.getPageGeometry(
						document as Parameters<PdfEngine["getPageGeometry"]>[0],
						page as Parameters<PdfEngine["getPageGeometry"]>[1],
					)
					.toPromise();
				if (
					captured !== scopeGeneration(scope) ||
					sources.get(scope) !== source
				)
					return;
				const inkPages =
					sourceInk.get(scope) ?? new Map<number, SentenceFractionRect[]>();
				inkPages.set(
					pageIndex,
					pageSelectionInkRects(geometry).map((rect) => ({
						x: rect.origin.x / page.size.width,
						y: rect.origin.y / page.size.height,
						w: rect.size.width / page.size.width,
						h: rect.size.height / page.size.height,
					})),
				);
				sourceInk.set(scope, inkPages);
				const indexed = geometry.runs.flatMap((run) =>
					run.glyphs.map((glyph, offset) => ({
						glyph,
						index: run.charStart + offset,
					})),
				);
				const characters = await engine
					.getTextSlices(
						document as Parameters<PdfEngine["getTextSlices"]>[0],
						indexed.map(({ index }) => ({
							pageIndex,
							charIndex: index,
							charCount: 1,
							rawCharacters: true,
						})),
					)
					.toPromise();
				if (
					captured !== scopeGeneration(scope) ||
					sources.get(scope) !== source
				)
					return;
				const exact = indexed.flatMap(({ glyph }, index) => {
					const rect = selectionGlyphInkRect(glyph);
					const text = characters[index] ?? "";
					return rect && text ? [{ text, rect }] : [];
				});
				const pages =
					sourceGlyphs.get(scope) ??
					new Map<number, { text: string; rect: Rect }[]>();
				pages.set(pageIndex, exact);
				sourceGlyphs.set(scope, pages);
				for (const item of itemsForScope(scope).filter(
					(item) => item.pageIndex === pageIndex && !item.reflow,
				)) {
					glyphs.set(
						glyphKey(scope, item),
						sentenceGlyphRects({
							sentences: item.sentences ?? [],
							raw: item.raw,
							source: item.source,
							runs,
							glyphs: exact,
							pageWidth: page.size.width,
							pageHeight: page.size.height,
							bbox: item.bbox,
						}),
					);
				}
			} catch {
				if (
					captured !== scopeGeneration(scope) ||
					sources.get(scope) !== source
				)
					return;
				const inkPages =
					sourceInk.get(scope) ?? new Map<number, SentenceFractionRect[]>();
				inkPages.set(pageIndex, []);
				sourceInk.set(scope, inkPages);
				const pages =
					sourceGlyphs.get(scope) ??
					new Map<number, { text: string; rect: Rect }[]>();
				pages.set(pageIndex, []);
				sourceGlyphs.set(scope, pages);
			}
		}
		if (
			lastQuery &&
			!suppressed &&
			layoutSentenceScope(lastQuery.docId) === scope
		) {
			applyPointer(lastQuery);
		} else notify();
	})().finally(() => {
		inflight.delete(flight);
	});
}

function hoveredMembers(query: PointerQuery, hit: ElementSentenceHit) {
	const scope = layoutSentenceScope(query.docId);
	for (const member of hit.members) {
		adoptReflowGlyphs(scope, member.pageIndex);
		adoptPublishedRuns(scope, member.pageIndex);
	}
	const pageMaps = new Map<number, ReturnType<typeof glyphsFor>>();
	return hit.members.map((member) => {
		let map = pageMaps.get(member.pageIndex);
		if (!map) {
			map = glyphsFor(scope, member.pageIndex);
			pageMaps.set(member.pageIndex, map);
		}
		return {
			...member,
			rects: [...(map.get(member.itemId)?.[member.sentenceIndex] ?? [])],
		};
	});
}

function applyPointer(query: PointerQuery): void {
	if (held) return;
	if (suppressed) {
		publish(null);
		return;
	}
	const scope = layoutSentenceScope(query.docId);
	adoptReflowGlyphs(scope, query.pageIndex);
	adoptPublishedRuns(scope, query.pageIndex);
	if (
		!sourceGlyphs.get(scope)?.has(query.pageIndex) &&
		!itemsForScope(scope).some(
			(item) => item.pageIndex === query.pageIndex && item.reflow,
		)
	) {
		primeLayoutSentenceGlyphs(query.pageIndex, query.docId);
	}
	const locate = elementSentenceAtPoint({
		items: itemsForScope(scope),
		glyphs: glyphsFor(scope, query.pageIndex),
		regionId: query.regionId,
		pageIndex: query.pageIndex,
		x: query.x,
		y: query.y,
		span: query.span,
	});
	if (locate.status === "pending") {
		primeLayoutSentenceGlyphs(query.pageIndex, query.docId);
		if (
			hover &&
			layoutSentenceScope(hover.docId) === scope &&
			hover.regionId === query.regionId
		) {
			return;
		}
		publish(null);
		return;
	}
	if (locate.status === "element") {
		if (
			!itemsForScope(scope).some((item) => item.pageIndex === query.pageIndex)
		)
			primeLayoutSentenceGlyphs(query.pageIndex, query.docId);
		publish(null);
		return;
	}
	const members = hoveredMembers(query, locate.hit);
	publish({
		...locate.hit,
		docId: query.docId,
		regionId: query.regionId,
		pageIndex: query.pageIndex,
		members,
	});
	const primed = new Set<number>();
	for (const member of members) {
		if (member.rects.length > 0 || primed.has(member.pageIndex)) continue;
		primed.add(member.pageIndex);
		primeLayoutSentenceGlyphs(member.pageIndex, query.docId);
	}
}

subscribeTranslatedLinkSource(() => {
	if (!lastQuery || suppressed) return;
	const scope = layoutSentenceScope(lastQuery.docId);
	const pages = new Set<number>([lastQuery.pageIndex]);
	if (hover && layoutSentenceScope(hover.docId) === scope) {
		for (const member of hover.members) pages.add(member.pageIndex);
	}
	let changed = false;
	for (const pageIndex of pages) {
		if (adoptPublishedRuns(scope, pageIndex)) changed = true;
	}
	if (changed) applyPointer(lastQuery);
});

/** Pointer is choosing a sentence. No-op while a text drag owns the page. */
export function syncLayoutSentencePointer(query: PointerQuery): void {
	lastQuery = query;
	applyPointer(query);
}

/** Click / Enter resolves the sentence even if the drag guard had cleared it. */
export function sentenceForActivation(
	query: PointerQuery,
): ElementSentenceHit | null {
	suppressed = false;
	// A new activation supersedes the sentence the previous toolbar owned;
	// otherwise `applyPointer` stays frozen and resolves a stale document.
	held = null;
	lastQuery = query;
	applyPointer(query);
	const current = hover;
	if (
		!current ||
		current.docId !== query.docId ||
		(query.regionId !== "" && current.regionId !== query.regionId)
	) {
		return null;
	}
	return current;
}

/** Keep the matching sentence painted while a double-click toolbar owns it. */
export function holdLayoutSentenceHover(docId: string): void {
	if (hover?.docId !== docId) return;
	held = hover;
	notify();
}

export function heldLayoutSentenceDocument(): string | null {
	return held?.docId ?? null;
}

export function releaseHeldLayoutSentenceHover(docId: string): void {
	if (held?.docId !== docId) return;
	held = null;
	lastQuery = null;
	publish(null);
}

export function suppressLayoutSentenceHover(): void {
	suppressed = true;
	lastQuery = null;
	publish(null);
}

export function releaseLayoutSentenceHover(): void {
	suppressed = false;
}

export function clearLayoutSentenceHover(): void {
	lastQuery = null;
	publish(null);
}
