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
} from "@/lib/pdf/layout/element-sentence";
import { sentenceGlyphRects } from "@/lib/pdf/layout/layout-sentence-selection";
import { layoutSentenceScope } from "@/lib/pdf/layout/store";

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

type CatalogSlot = { scope: string; items: CatalogItem[] };

let hover: LayoutSentenceHover | null = null;
let lastQuery: PointerQuery | null = null;
let suppressed = false;
let source: GlyphSource | null = null;

const slots = new Map<string, CatalogSlot>();
const generationByScope = new Map<string, number>();
const glyphs = new Map<string, readonly (readonly SentenceFractionRect[])[]>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();

function glyphKey(scope: string, item: CatalogItem): string {
	const quotes =
		item.sentences?.map((sentence) => sentence.quote).join("\u0001") ?? "";
	return `${scope}:${item.id}:${quotes}`;
}

function scopeGeneration(scope: string): number {
	return generationByScope.get(scope) ?? 0;
}

function bumpScope(scope: string): void {
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
	const groups: CatalogItem[][] = [];
	for (const slot of slots.values()) {
		if (slot.scope === scope) groups.push(slot.items);
	}
	return mergeSentenceItems(groups);
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
	const previous = source ? layoutSentenceScope(source.docId) : null;
	const nextScope = next ? layoutSentenceScope(next.docId) : null;
	source = next;
	if (previous && previous !== nextScope && !scopeStillPublished(previous)) {
		bumpScope(previous);
	}
}

export function publishLayoutSentenceCatalog(
	docId: string,
	items: readonly CatalogItem[],
): void {
	const scope = layoutSentenceScope(docId);
	const previous = slots.get(docId);
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
	if (!scopeStillPublished(scope)) bumpScope(scope);
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
}

function glyphsFor(
	scope: string,
): Map<string, readonly (readonly SentenceFractionRect[])[]> {
	const map = new Map<string, readonly (readonly SentenceFractionRect[])[]>();
	for (const item of itemsForScope(scope)) {
		const cached = glyphs.get(glyphKey(scope, item));
		if (cached) map.set(item.id, cached);
	}
	return map;
}

export function primeLayoutSentenceGlyphs(pageIndex: number): void {
	if (!source) return;
	const scope = layoutSentenceScope(source.docId);
	const docId = source.docId;
	const items = itemsForScope(scope).filter(
		(item) =>
			item.pageIndex === pageIndex &&
			(item.sentences?.length ?? 0) > 0 &&
			!glyphs.has(glyphKey(scope, item)),
	);
	if (items.length === 0) return;
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
		if (
			captured !== scopeGeneration(scope) ||
			!source ||
			source.docId !== docId
		) {
			return;
		}
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
			glyphs.set(glyphKey(scope, item), rects);
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

function applyPointer(query: PointerQuery): void {
	if (suppressed) {
		publish(null);
		return;
	}
	const scope = layoutSentenceScope(query.docId);
	const locate = elementSentenceAtPoint({
		items: itemsForScope(scope),
		glyphs: glyphsFor(scope),
		regionId: query.regionId,
		x: query.x,
		y: query.y,
		span: query.span,
	});
	if (locate.status === "pending") {
		primeLayoutSentenceGlyphs(query.pageIndex);
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
		publish(null);
		return;
	}
	const glyphMap = glyphsFor(scope);
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
