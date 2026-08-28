/**
 * Per-page text geometry for the EmbedPDF viewer: normalized 0–1 rects for
 * every glyph run on a page, fetched from PDFium (`getPageTextRects`).
 *
 * Gutter pins need this to decide which side of a selection to sit on and
 * whether they land on real glyphs (translucent) or in a free gutter, so the
 * map is shared by `pinsByPage`, {@link usePdfCards} placement and the per-page
 * layer stack. Fetching is lazy and idempotent: only pages that carry a mark or
 * sit within ±2 of the current page are loaded, each at most once.
 *
 * It lives in its own hook because the fetch is the only writer while three
 * unrelated clusters (ask / translate / visual marks) are readers.
 */

import type { PdfEngine } from "@embedpdf/models";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
	detectPdfTextLinks,
	type PdfTextLink,
} from "@/components/viewer/pdf/layers/citation-links";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import { threadHasUserQuestion } from "@/lib/pdf/ask/schema";
import type { PdfAskThread } from "@/lib/pdf/ask/types";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";
import {
	type NormalizedRect,
	normalizePageTextRects,
} from "@/lib/pdf/selection";
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
	currentPage: number;
	/** Mark arrays decide which off-screen pages must also load their text. */
	translates: PdfTranslateRecord[];
	threads: PdfAskThread[];
	highlights: PdfHighlight[];
	visualTraces: PdfVisualSessionTrace[];
};

export type PdfPageText = {
	/** 0-based page index → normalized text rects (missing while unloaded). */
	pageTextMap: Map<number, NormalizedRect[]>;
	/** 0-based page index → external links detected from plain PDF text. */
	pageTextLinkMap: Map<number, PdfTextLink[]>;
	/** Mirror for callbacks that must not re-create on every fetch. */
	pageTextMapRef: RefObject<Map<number, NormalizedRect[]>>;
};

export function usePdfPageText({
	engine,
	docCap,
	docId,
	totalPages,
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
	const pageTextPendingRef = useRef(new Set<number>());
	const pageTextMapRef = useRef(pageTextMap);
	pageTextMapRef.current = pageTextMap;

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

	// Load real page text geometry for pages that have pins (or near the viewport).
	// biome-ignore lint/correctness/useExhaustiveDependencies: mark arrays are intentionally represented by markPagesKey — the anchor page set is the only input the fetch consumes
	useEffect(() => {
		if (!engine || !docCap || totalPages <= 0) return;
		const doc = docCap.getDocument(docId);
		if (!doc) return;

		const need = new Set<number>();
		const from = Math.max(0, currentPage - 2);
		const to = Math.min(totalPages, currentPage + 2);
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

		for (const pageIndex of need) {
			if (
				pageTextMapRef.current.has(pageIndex) ||
				pageTextPendingRef.current.has(pageIndex)
			) {
				continue;
			}
			const page = doc.pages[pageIndex];
			if (!page) continue;
			pageTextPendingRef.current.add(pageIndex);
			void engine
				.getPageTextRects(doc, page)
				.toPromise()
				.then((rects) => {
					const norm = normalizePageTextRects(rects, page.size);
					const textLinks = detectPdfTextLinks(rects);
					setPageTextMap((prev) => {
						if (prev.get(pageIndex) === norm) return prev;
						const next = new Map(prev);
						next.set(pageIndex, norm);
						return next;
					});
					setPageTextLinkMap((prev) => {
						const next = new Map(prev);
						next.set(pageIndex, textLinks);
						return next;
					});
				})
				.catch(() => {
					// Leave unloaded; pins stay solid until text geometry is available.
				})
				.finally(() => {
					pageTextPendingRef.current.delete(pageIndex);
				});
		}
	}, [engine, docCap, docId, totalPages, currentPage, markPagesKey]);

	return { pageTextMap, pageTextLinkMap, pageTextMapRef };
}
