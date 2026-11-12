/**
 * Per-page text geometry for the EmbedPDF viewer: normalized 0–1 rects for
 * every glyph run on a page, fetched from PDFium (`getPageTextRects`).
 *
 * Gutter pins need this to decide which side of a selection to sit on and
 * whether they land on real glyphs (translucent) or in a free gutter, so the
 * map is shared by `pinsByPage`, {@link usePdfCards} placement and the per-page
 * layer stack. Fetching is lazy and idempotent: only pages that carry a mark or
 * sit within ±1 of the current page are loaded, each at most once.
 *
 * The window is intentionally narrow: `getPageTextRects` is an O(glyphs)
 * extraction in the single PDFium worker, so widening it competes with raster
 * rendering and with the selection plugin's own `getPageGeometry` extraction.
 * It also waits until the current page has stopped changing, so a fling does
 * not enqueue one extraction per page it flies through. Pages that already
 * carry a mark still load immediately.
 *
 * It lives in its own hook because the fetch is the only writer while three
 * unrelated clusters (ask / translate / visual marks) are readers.
 */

import type { PdfEngine, Rect } from "@embedpdf/models";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { PDF_WORKER_SETTLE_MS } from "@/components/viewer/pdf/constants";
import {
	detectPdfTextLinks,
	type PdfTextLink,
} from "@/components/viewer/pdf/layers/citation-links";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import { threadHasUserQuestion } from "@/lib/pdf/ask/schema";
import type { PdfAskThread } from "@/lib/pdf/ask/types";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";
import { recoverCaptionsFromRuns } from "@/lib/pdf/layout/captions-from-runs";
import {
	type NormalizedRect,
	normalizePageTextRects,
} from "@/lib/pdf/selection";
import {
	type SelectionMarginCandidate,
	selectionMarginCandidates,
	selectionPageMargins,
} from "@/lib/pdf/selection-page-margins";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

export type UsePdfPageTextOptions = {
	/** Shared PDFium engine (null until the WASM host finished booting). */
	engine: PdfEngine | null;
	/** EmbedPDF capability; returns a fresh scope each render, so never a dep. */
	docCap: DocumentManagerCapability;
	docId: string;
	totalPages: number;
	paperTitle?: string;
	currentPage: number;
	/** Mark arrays decide which off-screen pages must also load their text. */
	translates: PdfTranslateRecord[];
	threads: PdfAskThread[];
	highlights: PdfHighlight[];
	visualTraces: PdfVisualSessionTrace[];
};

export type PdfPageText = {
	ensureSelectionTextExclusions: (
		pages: readonly number[],
	) => Promise<ReadonlyMap<number, readonly Rect[]>>;
	selectionTextExclusionsByPage: ReadonlyMap<number, readonly Rect[]>;
	/** 0-based page index → normalized text rects (missing while unloaded). */
	pageTextMap: Map<number, NormalizedRect[]>;
	/** 0-based page index → external links detected from plain PDF text. */
	pageTextLinkMap: Map<number, PdfTextLink[]>;
	/** Mirror for callbacks that must not re-create on every fetch. */
	pageTextMapRef: RefObject<Map<number, NormalizedRect[]>>;
};

/**
 * Content equality for one page's detected text links: `detectPdfTextLinks`
 * builds fresh objects per call, so compare url + rect fields element-wise.
 * Lets the setter keep the previous map reference when nothing changed.
 */
function sameTextLinks(
	previous: PdfTextLink[] | undefined,
	next: PdfTextLink[],
): boolean {
	if (!previous || previous.length !== next.length) return false;
	return previous.every(
		(link, i) =>
			link.url === next[i].url &&
			link.rect.origin.x === next[i].rect.origin.x &&
			link.rect.origin.y === next[i].rect.origin.y &&
			link.rect.size.width === next[i].rect.size.width &&
			link.rect.size.height === next[i].rect.size.height,
	);
}

function textExclusions(
	candidates: ReadonlyMap<number, readonly SelectionMarginCandidate[]>,
	paperTitle: string | undefined,
	captions: ReadonlyMap<number, readonly Rect[]>,
): ReadonlyMap<number, readonly Rect[]> {
	const result = new Map(selectionPageMargins(candidates, paperTitle));
	for (const [page, rects] of captions)
		result.set(page, [...(result.get(page) ?? []), ...rects]);
	return result;
}

export function usePdfPageText({
	engine,
	docCap,
	docId,
	totalPages,
	paperTitle,
	currentPage,
	translates,
	threads,
	highlights,
	visualTraces,
}: UsePdfPageTextOptions): PdfPageText {
	const [pageTextMap, setPageTextMap] = useState(
		() => new Map<number, NormalizedRect[]>(),
	);
	const [pageTextLinkMap, setPageTextLinkMap] = useState(
		() => new Map<number, PdfTextLink[]>(),
	);
	const [headerCandidates, setHeaderCandidates] = useState(
		() => new Map<number, SelectionMarginCandidate[]>(),
	);
	const [captionRects, setCaptionRects] = useState(
		() => new Map<number, readonly Rect[]>(),
	);
	const captionRectsRef = useRef(captionRects);
	const selectionTextExclusionsByPage = useMemo(
		() => textExclusions(headerCandidates, paperTitle, captionRects),
		[headerCandidates, paperTitle, captionRects],
	);
	const pageTextPendingRef = useRef(new Map<number, Promise<void>>());
	const headerCandidatesRef = useRef(headerCandidates);
	const pageTextMapRef = useRef(pageTextMap);
	pageTextMapRef.current = pageTextMap;
	const [settledPage, setSettledPage] = useState(currentPage);

	useEffect(() => {
		const timer = window.setTimeout(
			() => setSettledPage(currentPage),
			PDF_WORKER_SETTLE_MS,
		);
		return () => window.clearTimeout(timer);
	}, [currentPage]);

	// Which off-screen pages carry a mark and must load their text geometry.
	// Keyed on the resulting page set (a primitive), not the mark arrays: while a
	// reply / translation streams, those arrays get a fresh identity on every
	// chunk although no anchor page changes, and re-running the fetch effect per
	// chunk is pure waste.
	const markPagesKey = useMemo(() => {
		const pages = new Set<number>();
		for (const tr of translates) {
			if (!tr.error) pages.add(tr.page - 1);
		}
		for (const th of threads) {
			if (threadHasUserQuestion(th)) pages.add(th.anchor.page - 1);
		}
		for (const h of highlights) {
			if (h.comment?.trim()) pages.add(h.page - 1);
		}
		for (const v of visualTraces) pages.add(v.page - 1);
		return [...pages].sort((a, b) => a - b).join(",");
	}, [translates, threads, highlights, visualTraces]);

	const loadPageText = useCallback(
		(pageIndex: number): Promise<void> => {
			const pending = pageTextPendingRef.current.get(pageIndex);
			if (pending) return pending;
			if (headerCandidatesRef.current.has(pageIndex)) return Promise.resolve();
			const doc = docCap?.getDocument(docId);
			const page = doc?.pages[pageIndex];
			if (!engine || !doc || !page) return Promise.resolve();
			const task = engine
				.getPageTextRects(doc, page)
				.toPromise()
				.then((rects) => {
					const captions = recoverCaptionsFromRuns(
						[],
						pageIndex,
						rects.map(({ content, rect }) => ({ text: content, rect })),
						page.size,
					).map(({ rect: { x, y, w, h } }) => ({
						origin: { x, y },
						size: { width: w, height: h },
					}));
					captionRectsRef.current = new Map(captionRectsRef.current).set(
						pageIndex,
						captions,
					);
					setCaptionRects(captionRectsRef.current);
					const norm = normalizePageTextRects(rects, page.size);
					const candidates = selectionMarginCandidates(rects, page.size);
					headerCandidatesRef.current = new Map(
						headerCandidatesRef.current,
					).set(pageIndex, candidates);
					setHeaderCandidates(headerCandidatesRef.current);
					setPageTextMap((prev) => new Map(prev).set(pageIndex, norm));
					const textLinks = detectPdfTextLinks(rects);
					setPageTextLinkMap((prev) =>
						sameTextLinks(prev.get(pageIndex), textLinks)
							? prev
							: new Map(prev).set(pageIndex, textLinks),
					);
				})
				.catch(() => {
					// Leave failed pages unloaded so later interactions can retry.
				})
				.finally(() => pageTextPendingRef.current.delete(pageIndex));
			pageTextPendingRef.current.set(pageIndex, task);
			return task;
		},
		[engine, docCap, docId],
	);

	const ensureSelectionTextExclusions = useCallback(
		async (pages: readonly number[]) => {
			await Promise.all(pages.map(loadPageText));
			return textExclusions(
				headerCandidatesRef.current,
				paperTitle,
				captionRectsRef.current,
			);
		},
		[loadPageText, paperTitle],
	);

	// Load real page text geometry for pages that have pins (or near the viewport).
	// biome-ignore lint/correctness/useExhaustiveDependencies: mark arrays are intentionally represented by markPagesKey — the anchor page set is the only input the fetch consumes
	useEffect(() => {
		if (!engine || !docCap || totalPages <= 0) return;
		const doc = docCap.getDocument(docId);
		if (!doc) return;

		const need = new Set<number>();
		const from = Math.max(0, settledPage - 2);
		const to = Math.min(totalPages, settledPage + 1);
		for (let i = from; i < to; i++) need.add(i);
		for (const tr of translates) {
			if (!tr.error) need.add(tr.page - 1);
		}
		for (const th of threads) {
			if (threadHasUserQuestion(th)) need.add(th.anchor.page - 1);
		}
		for (const h of highlights) {
			if (h.comment?.trim()) need.add(h.page - 1);
		}
		for (const v of visualTraces) need.add(v.page - 1);

		for (const pageIndex of need) void loadPageText(pageIndex);
	}, [
		engine,
		docCap,
		docId,
		totalPages,
		settledPage,
		markPagesKey,
		loadPageText,
	]);

	return {
		pageTextMap,
		pageTextLinkMap,
		pageTextMapRef,
		selectionTextExclusionsByPage,
		ensureSelectionTextExclusions,
	};
}
