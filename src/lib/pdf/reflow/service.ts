import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { errorText } from "@/lib/core/error";
import { logger, logOp } from "@/lib/core/logger";
import { LAYOUT_SIDEBAR_MIN_SCORE } from "@/lib/pdf/layout/constants";
import {
	isInsidePreservedRegion,
	preservedLayoutRegions,
} from "@/lib/pdf/layout/translation-exclusions";
import type {
	LayoutTranslateItem,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";
import type { ReflowIrCacheStore } from "./cache";
import { extractReflowDocument } from "./extract";
import {
	REFLOW_IR_SCHEMA_VERSION,
	type ReflowDocument,
	type ReflowPage,
} from "./types";

/** Cached pages only count when they still describe the open PDF. */
function reflowPageMatchesDocument(
	page: ReflowPage,
	doc: PdfDocumentObject,
): boolean {
	const target = doc.pages[page.index];
	if (!target) return false;
	return (
		Math.abs(target.size.width - page.width) < 0.01 &&
		Math.abs(target.size.height - page.height) < 0.01 &&
		page.paragraphs.every((paragraph) => paragraph.pageIndex === page.index)
	);
}

async function readCachedPages(
	cache: ReflowIrCacheStore,
	pageIndexes: readonly number[],
): Promise<Map<number, ReflowPage>> {
	try {
		return await cache.read(pageIndexes);
	} catch (error) {
		logger.warn("pdf.reflow.cache read failed", { error: errorText(error) });
		return new Map();
	}
}

async function writeCachedPages(
	cache: ReflowIrCacheStore,
	pages: readonly ReflowPage[],
): Promise<void> {
	if (!pages.length) return;
	try {
		await cache.write(pages);
	} catch (error) {
		logger.warn("pdf.reflow.cache write failed", { error: errorText(error) });
	}
}

export async function prepareReflowItems(
	engine: PdfEngine,
	doc: PdfDocumentObject,
	items: readonly LayoutTranslateItem[],
	regions: readonly PdfLayoutRegion[],
	signal?: AbortSignal,
	cache?: ReflowIrCacheStore | null,
): Promise<LayoutTranslateItem[]> {
	const pageIndexes = [...new Set(items.map((item) => item.pageIndex))];
	// The Settings switch gates new writes only; files written earlier stay
	// reusable. Fakes without `writesEnabled` run exactly as before.
	const writeCache = cache && (cache.writesEnabled?.() ?? true) ? cache : null;
	const pages = cache
		? await logOp(
				"pdf.reflow.prepare.cache",
				{ phase: "read", pages: pageIndexes.length },
				() => readCachedPages(cache, pageIndexes),
			)
		: new Map<number, ReflowPage>();
	if (cache)
		logger.info("pdf.reflow.cache", {
			result:
				pages.size === pageIndexes.length
					? "hit"
					: pages.size
						? "partial"
						: "miss",
			pages: pages.size,
			total: pageIndexes.length,
		});
	for (const [index, page] of pages)
		if (!reflowPageMatchesDocument(page, doc)) {
			pages.delete(index);
			logger.warn("pdf.reflow.cache rejected", {
				page: index,
				reason: "page geometry",
			});
		}
	const missing = items.filter((item) => !pages.has(item.pageIndex));
	if (missing.length) {
		signal?.throwIfAborted();
		const extracted = await logOp(
			"pdf.reflow.prepare.extract",
			{ pages: new Set(missing.map((item) => item.pageIndex)).size },
			() => extractReflowDocument(engine, doc, missing, regions, signal),
		);
		for (const page of extracted.pages) pages.set(page.index, page);
		if (writeCache && !signal?.aborted)
			await logOp(
				"pdf.reflow.prepare.cache",
				{ phase: "write", pages: extracted.pages.length },
				() => writeCachedPages(writeCache, extracted.pages),
			);
	}
	const prepared = preparedItemsFromDocument(doc, items, {
		version: REFLOW_IR_SCHEMA_VERSION,
		pages: [...pages.values()].sort((a, b) => a.index - b.index),
	});
	const preserved = preservedLayoutRegions(regions);
	return prepared.filter(
		(item) => !isInsidePreservedRegion(item, regions, preserved),
	);
}

function preparedItemsFromDocument(
	doc: PdfDocumentObject,
	items: readonly LayoutTranslateItem[],
	ir: ReflowDocument,
): LayoutTranslateItem[] {
	const byId = new Map(
		ir.pages.flatMap((p) => p.paragraphs.map((q) => [q.id, q] as const)),
	);
	const prepared: LayoutTranslateItem[] = items.flatMap(
		(item): LayoutTranslateItem[] => {
			const reflow = byId.get(item.id);
			if (!reflow) return [];
			const source = reflow.protectedText;
			const page = doc.pages[item.pageIndex];
			return [
				{
					...item,
					source,
					bbox: {
						x: reflow.box.x / page.size.width,
						y: reflow.box.y / page.size.height,
						w: reflow.box.w / page.size.width,
						h: reflow.box.h / page.size.height,
					},
					raw: reflow.source,
					reflow,
					...(source !== item.source
						? {
								status: "pending" as const,
								translated: undefined,
								sentences: undefined,
							}
						: {}),
				},
			];
		},
	);
	for (const page of ir.pages)
		for (const p of page.paragraphs) {
			if (items.some((i) => i.id === p.id)) continue;
			prepared.push({
				id: p.id,
				pageIndex: page.index,
				kind: "text",
				readingOrder: 10000 + p.box.y,
				source: p.protectedText,
				raw: p.source,
				status: "pending",
				reflow: p,
				bbox: {
					x: p.box.x / page.width,
					y: p.box.y / page.height,
					w: p.box.w / page.width,
					h: p.box.h / page.height,
				},
			});
		}
	return prepared;
}

export function reflowDocumentFromItems(
	doc: PdfDocumentObject,
	items: readonly LayoutTranslateItem[],
	regions: readonly PdfLayoutRegion[],
): ReflowDocument {
	return {
		version: REFLOW_IR_SCHEMA_VERSION,
		pages: doc.pages
			.map((page) => ({
				index: page.index,
				width: page.size.width,
				height: page.size.height,
				paragraphs: items
					.filter((i) => i.pageIndex === page.index && i.reflow)
					.flatMap((i) => (i.reflow ? [i.reflow] : [])),
				obstacles: regions
					.filter(
						(r) =>
							r.pageIndex === page.index &&
							r.score >= LAYOUT_SIDEBAR_MIN_SCORE &&
							!items.some((i) => i.id === r.id && i.reflow),
					)
					.map((r) => r.rect),
			}))
			.filter((page) => page.paragraphs.length > 0),
	};
}
