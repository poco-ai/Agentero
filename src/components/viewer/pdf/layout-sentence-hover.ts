/**
 * Sentence under the layout-element pointer.
 * Subscribers paint DOM. Pointer moves do not render the page tree.
 * Source and translation panes share one catalog keyed by paper scope.
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
	sentenceItemsUnderPoint,
	sourceSentenceHoverBands,
} from "@/lib/pdf/layout/element-sentence";
import { pointInBbox } from "@/lib/pdf/layout/hit-test";
import {
	reflowSentenceGlyphRects,
	sentenceGlyphRects,
} from "@/lib/pdf/layout/layout-sentence-selection";
import { splitLayoutSentences } from "@/lib/pdf/layout/layout-sentences";
import { orderByReadingLine } from "@/lib/pdf/layout/reading-order";
import {
	layoutSentenceScope,
	setLayoutSentenceScopeLookup,
} from "@/lib/pdf/layout/store";
import {
	getTranslatedLinkSource,
	subscribeTranslatedLinkSource,
} from "@/lib/pdf/layout/translated-link-source";
import type { Paragraph, ParagraphLayout } from "@/lib/pdf/reflow/types";
import {
	pageSelectionInkRects,
	selectionGlyphInkRect,
} from "@/lib/pdf/selection-appearance";
import { getTabs } from "@/lib/workspace/store";
import { findTranslationSourceId } from "@/lib/workspace/tabs/translation-split";

setLayoutSentenceScopeLookup((documentId) =>
	findTranslationSourceId(getTabs(), documentId),
);

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
	reflowLayout?: ParagraphLayout;
	bbox: { x: number; y: number; w: number; h: number };
	source: string;
	raw?: string;
	translated?: string;
};

/** Blocks currently published for this paper, including reflow placement. */
export function layoutSentenceCatalogItems(
	docId: string,
): readonly CatalogItem[] {
	return itemsForScope(layoutSentenceScope(docId));
}

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
let lastSample: PointerQuery | null = null;
let suppressed = false;
const sources = new Map<string, GlyphSource>();

const slots = new Map<string, CatalogSlot>();
/**
 * Pages that already have layout-analysis regions, keyed per publishing pane.
 * The whole-page text-run fallback exists for PDFs that were never analysed;
 * on an analysed page it would turn the text inside a figure / table /
 * algorithm box into sentences and wash the graphic on hover.
 */
const analysedPages = new Map<string, { scope: string; pages: Set<number> }>();
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

/** Whether this paper's layout analysis already covers the page. */
function pageIsAnalysed(scope: string, pageIndex: number): boolean {
	for (const slot of analysedPages.values()) {
		if (slot.scope === scope && slot.pages.has(pageIndex)) return true;
	}
	return false;
}

/** Drop the whole-page text fallback for pages that just got analysis. */
function dropPageFallbacks(scope: string, pages: ReadonlySet<number>): boolean {
	let changed = false;
	const pageItems = sourcePages.get(scope);
	for (const pageIndex of pages) {
		if (pageItems?.delete(pageIndex)) changed = true;
		const prefix = `${scope}:source-page-${pageIndex}:`;
		for (const key of glyphs.keys()) {
			if (!key.startsWith(prefix)) continue;
			glyphs.delete(key);
			changed = true;
		}
	}
	if (changed) invalidateCatalog(scope);
	return changed;
}

/**
 * Layout analysis published its regions for `docId`.
 * Pages in this list no longer receive synthesized whole-page sentences.
 */
export function publishLayoutSentencePageAnalysis(
	docId: string,
	pages: readonly number[] | null | undefined,
): void {
	const scope = layoutSentenceScope(docId);
	const next = new Set(pages ?? []);
	if (next.size === 0) {
		analysedPages.delete(docId);
		return;
	}
	analysedPages.set(docId, { scope, pages: next });
	if (!dropPageFallbacks(scope, next)) return;
	// Force a fresh locate: the pointer may still sit on a sentence drawn from
	// the fallback, and a normal resolve would short-circuit on it.
	if (!held) hover = null;
	notify();
	if (
		lastQuery &&
		!suppressed &&
		layoutSentenceScope(lastQuery.docId) === scope
	) {
		applyPointer(lastQuery);
	}
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
	point?: { x: number; y: number },
): Map<string, readonly (readonly SentenceFractionRect[])[]> {
	const map = new Map<string, readonly (readonly SentenceFractionRect[])[]>();
	const pageLines = layoutSentenceLineRects(scope, pageIndex);
	const lines = pageLines.length ? pageLines : EMPTY_LINE_RECTS;
	const items = point
		? sentenceItemsUnderPoint(itemsForScope(scope), pageIndex, point.x, point.y)
		: itemsForScope(scope);
	for (const item of items) {
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
	// An analysed page never invents whole-page sentences. Figures, tables and
	// algorithms have no text-like regions of their own, so the fallback would
	// pick up their inner text runs and wash the graphic under the pointer.
	if (items.length === 0 && pageIsAnalysed(scope, pageIndex)) return;
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
		let runs: { text: string; rect: Rect; fontSize?: number }[] = [];
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
				fontSize: run.fontSize,
			}));
		} catch {
			runs = [];
		}
		if (captured !== scopeGeneration(scope) || sources.get(scope) !== source) {
			return;
		}

		if (!items.length && runs.length && !pageIsAnalysed(scope, pageIndex)) {
			const ordered = orderByReadingLine(runs, (run) => ({
				x: run.rect.origin.x,
				y: run.rect.origin.y,
				width: run.rect.size.width,
				height: run.rect.size.height,
				size: run.fontSize,
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

/** One text line, in page fractions. A sample that lands just outside still counts. */
const SENTENCE_LOOKBACK = 0.02;

function pointerInCurrentSentence(query: PointerQuery): boolean {
	if (!hover || held || suppressed) return false;
	if (layoutSentenceScope(hover.docId) !== layoutSentenceScope(query.docId)) {
		return false;
	}
	if (query.span) {
		return hover.members.some(
			(member) =>
				member.pageIndex === query.pageIndex &&
				member.itemId === query.span?.itemId &&
				member.sentenceIndex === query.span.sentenceIndex,
		);
	}
	if (
		hover.pageIndex === query.pageIndex &&
		hover.rects.some((rect) => pointInBbox(query.x, query.y, rect))
	) {
		return true;
	}
	return hover.members.some(
		(member) =>
			member.pageIndex === query.pageIndex &&
			member.rects.some((rect) => pointInBbox(query.x, query.y, rect)),
	);
}

/**
 * Points within one line back along this move, then the pointer itself.
 * The caller tries the pointer first. A miss can still light the block the
 * frame just crossed. Landing on the next block does not replay the ones
 * in between.
 */
function samplesNearPointer(query: PointerQuery): PointerQuery[] {
	const previous = lastSample;
	if (
		query.span ||
		!previous ||
		layoutSentenceScope(previous.docId) !== layoutSentenceScope(query.docId) ||
		previous.pageIndex !== query.pageIndex
	) {
		return [query];
	}
	const dx = query.x - previous.x;
	const dy = query.y - previous.y;
	const dist = Math.hypot(dx, dy);
	if (dist <= 0.012) return [query];
	const reach = Math.min(dist, SENTENCE_LOOKBACK);
	const steps = Math.min(3, Math.ceil(reach / 0.01));
	const samples: PointerQuery[] = [];
	for (let step = steps; step >= 1; step--) {
		const scale = (reach * step) / dist;
		samples.push({
			...query,
			x: query.x - dx * scale,
			y: query.y - dy * scale,
			span: null,
		});
	}
	samples.push(query);
	return samples;
}

function locateSentence(scope: string, query: PointerQuery) {
	return elementSentenceAtPoint({
		items: itemsForScope(scope),
		glyphs: glyphsFor(scope, query.pageIndex, {
			x: query.x,
			y: query.y,
		}),
		regionId: query.regionId,
		pageIndex: query.pageIndex,
		x: query.x,
		y: query.y,
		span: query.span,
	});
}

function applyPointer(query: PointerQuery, track = false): void {
	if (held) return;
	if (suppressed) {
		lastSample = null;
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
	if (pointerInCurrentSentence(query)) {
		lastSample = query;
		return;
	}
	const samples = track ? samplesNearPointer(query) : null;
	lastSample = query;
	let locate = locateSentence(scope, query);
	let chosen = query;
	if (samples && locate.status !== "sentence" && locate.status !== "pending") {
		for (let index = samples.length - 2; index >= 0; index--) {
			const sample = samples[index];
			if (!sample) continue;
			const result = locateSentence(scope, sample);
			if (result.status !== "sentence") continue;
			locate = result;
			chosen = sample;
			break;
		}
	}
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
	const members = hoveredMembers(chosen, locate.hit);
	const regionId =
		chosen === query
			? query.regionId
			: (locate.hit.members.find(
					(member) => member.pageIndex === query.pageIndex,
				)?.itemId ?? query.regionId);
	publish({
		...locate.hit,
		docId: query.docId,
		regionId,
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
	applyPointer(query, true);
}

/** Click / Enter resolves the sentence even if the drag guard had cleared it. */
export function sentenceForActivation(
	query: PointerQuery,
): LayoutSentenceHover | null {
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
	lastSample = null;
	publish(null);
}

export function suppressLayoutSentenceHover(): void {
	suppressed = true;
	lastQuery = null;
	lastSample = null;
	publish(null);
}

export function releaseLayoutSentenceHover(): void {
	suppressed = false;
}

export function clearLayoutSentenceHover(): void {
	lastQuery = null;
	lastSample = null;
	publish(null);
}
