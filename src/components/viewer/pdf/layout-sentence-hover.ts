/**
 * Sentence under the layout-element pointer.
 * Subscribers paint DOM. Pointer moves do not render the page tree.
 */

import type { PdfEngine, Rect } from "@embedpdf/models";
import {
	type ElementSentenceHit,
	type ElementSentenceMember,
	elementSentenceAtPoint,
	type SentenceFractionRect,
	type SentenceItem,
} from "@/lib/pdf/layout/element-sentence";
import { sentenceGlyphRects } from "@/lib/pdf/layout/layout-sentence-selection";

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

let catalogDocId = "";
let catalog: CatalogItem[] = [];
let generation = 0;
let hover: LayoutSentenceHover | null = null;
let lastQuery: PointerQuery | null = null;
let suppressed = false;
let source: GlyphSource | null = null;

const glyphs = new Map<string, readonly (readonly SentenceFractionRect[])[]>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();

function glyphKey(docId: string, item: CatalogItem): string {
	const quotes =
		item.sentences?.map((sentence) => sentence.quote).join("\u0001") ?? "";
	return `${docId}:${item.id}:${quotes}`;
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
	if (sameHover(hover, next)) return;
	hover = next;
	notify();
}

export function layoutSentenceHover(): LayoutSentenceHover | null {
	return hover;
}

export function subscribeLayoutSentenceHover(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function bindLayoutSentenceGlyphs(next: GlyphSource | null): void {
	if (source?.docId !== next?.docId) {
		glyphs.clear();
		inflight.clear();
		generation += 1;
	}
	source = next;
}

export function publishLayoutSentenceCatalog(
	docId: string,
	items: readonly CatalogItem[],
): void {
	const docChanged = catalogDocId !== docId;
	catalogDocId = docId;
	catalog = items.filter((item) => (item.sentences?.length ?? 0) > 0);
	if (docChanged) {
		glyphs.clear();
		inflight.clear();
		generation += 1;
		lastQuery = null;
		suppressed = false;
		publish(null);
		return;
	}
	if (
		hover &&
		!catalog.some((item) =>
			hover?.members.some((member) => member.itemId === item.id),
		)
	) {
		publish(null);
	}
	notify();
}

function glyphsFor(
	docId: string,
): Map<string, readonly (readonly SentenceFractionRect[])[]> {
	const map = new Map<string, readonly (readonly SentenceFractionRect[])[]>();
	for (const item of catalog) {
		const cached = glyphs.get(glyphKey(docId, item));
		if (cached) map.set(item.id, cached);
	}
	return map;
}

export function primeLayoutSentenceGlyphs(pageIndex: number): void {
	if (!source || source.docId !== catalogDocId) return;
	const docId = source.docId;
	const items = catalog.filter(
		(item) =>
			item.pageIndex === pageIndex &&
			(item.sentences?.length ?? 0) > 0 &&
			!glyphs.has(glyphKey(docId, item)),
	);
	if (items.length === 0) return;
	const flight = `${docId}:${pageIndex}:${generation}`;
	if (inflight.has(flight)) return;
	const engine = source.engine;
	const document = source.getDocument();
	const page = document?.pages[pageIndex];
	if (!document || !page || page.size.width <= 0 || page.size.height <= 0)
		return;
	const captured = generation;
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
		if (captured !== generation || catalogDocId !== docId) return;
		for (const item of items) {
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
			glyphs.set(glyphKey(docId, item), rects);
		}
		if (lastQuery && !suppressed) applyPointer(lastQuery);
		else notify();
	})().finally(() => {
		inflight.delete(flight);
	});
}

function applyPointer(query: PointerQuery): void {
	if (suppressed || query.docId !== catalogDocId) {
		publish(null);
		return;
	}
	const locate = elementSentenceAtPoint({
		items: catalog,
		glyphs: glyphsFor(query.docId),
		regionId: query.regionId,
		x: query.x,
		y: query.y,
		span: query.span,
	});
	if (locate.status === "pending") {
		primeLayoutSentenceGlyphs(query.pageIndex);
		if (hover?.docId === query.docId && hover.regionId === query.regionId)
			return;
		publish(null);
		return;
	}
	if (locate.status === "element") {
		publish(null);
		return;
	}
	const glyphMap = glyphsFor(query.docId);
	publish({
		...locate.hit,
		docId: query.docId,
		regionId: query.regionId,
		pageIndex: query.pageIndex,
		members: locate.hit.members.map((member) => ({
			...member,
			rects: [...(glyphMap.get(member.itemId)?.[member.sentenceIndex] ?? [])],
		})),
	});
}

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
	lastQuery = query;
	applyPointer(query);
	const current = hover;
	if (
		!current ||
		current.docId !== query.docId ||
		current.regionId !== query.regionId
	) {
		return null;
	}
	return current;
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
