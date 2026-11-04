/**
 * Turn a DOM selection on the full-document translation overlay into the same
 * floating menu the English text layer uses.
 *
 * The menu's quote is the English sentence (or the whole block when that block
 * has no sentence pairs). Copy stays the visible translation. Listeners attach
 * only while layout translation is painted on the main viewer.
 */

import type { PdfEngine, Rect } from "@embedpdf/models";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import type { FormattedSelection } from "@embedpdf/plugin-selection/react";
import { type RefObject, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
	anchorFromEmbedSelection,
	EMBED_PAGE_ATTR,
	pageElByIndex,
	rectTopCenterScreen,
} from "@/components/viewer/pdf/coords";
import type { SelectionMenuState } from "@/components/viewer/pdf/types";
import { publishSelection } from "@/lib/agent/selection-store";
import {
	bboxToPageRect,
	locateQuoteInBlock,
	type TranslationPagePick,
	type TranslationSelection,
	translationHitsFromRange,
	translationSelectionFromHits,
	unionPageRect,
} from "@/lib/pdf/layout/layout-sentence-selection";
import { normalizeSentenceKey } from "@/lib/pdf/layout/layout-sentences";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";
import {
	type PageFrame,
	visibleMenuPoint,
	visiblePagesFromClientRects,
} from "@/lib/pdf/layout/visible-selection-rects";
import { holdLinkPreviewDrag } from "@/lib/pdf/link-preview-drag";
import { loadSettings } from "@/lib/settings/store";
import { langsFromSettings } from "@/lib/translate/lang";

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

export type UsePdfTranslationSelectionOptions = {
	/** Main viewer with the translation overlay painted. */
	enabled: boolean;
	hostRef: RefObject<HTMLDivElement | null>;
	zoomRef: RefObject<number>;
	engineRef: RefObject<PdfEngine | null>;
	docCapRef: RefObject<DocumentManagerCapability>;
	docId: string;
	itemsByPage: ReadonlyMap<number, readonly LayoutTranslateItem[]>;
	selectionMenu: SelectionMenuState | null;
	setSelectionMenu: (menu: SelectionMenuState | null) => void;
	closeSelectionMenu: () => void;
	paperRelPath: string | null;
	paperAbsPath: string | null;
};

function caretInsideLayoutItem(host: HTMLElement | null): boolean {
	if (!host) return false;
	const selection = window.getSelection();
	const node = selection?.anchorNode;
	if (!node) return false;
	const el = node instanceof Element ? node : node.parentElement;
	return Boolean(el && host.contains(el) && el.closest("[data-layout-item]"));
}

function pageFrames(host: HTMLElement): PageFrame[] {
	const frames: PageFrame[] = [];
	for (const el of host.querySelectorAll<HTMLElement>(`[${EMBED_PAGE_ATTR}]`)) {
		const pageIndex = Number(el.getAttribute(EMBED_PAGE_ATTR));
		if (!Number.isInteger(pageIndex)) continue;
		const box = el.getBoundingClientRect();
		if (box.width <= 0 || box.height <= 0) continue;
		frames.push({
			pageIndex,
			left: box.left,
			top: box.top,
			width: box.width,
			height: box.height,
		});
	}
	return frames;
}

function hostRange(host: HTMLElement): Range | null {
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
		return null;
	}
	const range = selection.getRangeAt(0);
	const node = range.commonAncestorContainer;
	const el = node instanceof Element ? node : node.parentElement;
	if (!el || !host.contains(el)) return null;
	return range;
}

async function locatePages(
	engine: PdfEngine | null,
	docCap: DocumentManagerCapability,
	docId: string,
	selection: TranslationSelection,
	generation: () => boolean,
): Promise<FormattedSelection[] | null> {
	const doc = docCap?.getDocument(docId);
	const grouped = new Map<number, TranslationPagePick[]>();
	for (const pick of selection.pages) {
		const list = grouped.get(pick.pageIndex) ?? [];
		list.push(pick);
		grouped.set(pick.pageIndex, list);
	}
	const formatted: FormattedSelection[] = [];
	for (const [pageIndex, picks] of grouped) {
		if (!generation()) return null;
		const page = doc?.pages[pageIndex];
		const size = page?.size;
		if (!page || !size || size.width <= 0 || size.height <= 0) continue;
		let runs: { text: string; rect: Rect }[] = [];
		if (engine && doc) {
			try {
				const pageRuns = await engine.getPageTextRuns(doc, page).toPromise();
				runs = (pageRuns?.runs ?? []).map((run) => ({
					text: run.text ?? "",
					rect: run.rect,
				}));
			} catch {
				runs = [];
			}
			if (!runs.length) {
				try {
					const raw = await engine.getPageTextRects(doc, page).toPromise();
					runs = (raw ?? []).map((glyph) => ({
						text: glyph.content ?? "",
						rect: glyph.rect,
					}));
				} catch {
					runs = [];
				}
			}
		}
		if (!generation()) return null;
		const rects = picks.flatMap((pick) => {
			if (pick.glyphRects?.length) return pick.glyphRects;
			const located = runs.length
				? locateQuoteInBlock({
						quote: pick.locateText,
						runs,
						pageWidth: size.width,
						pageHeight: size.height,
						bbox: pick.bbox,
						blockText: pick.blockText,
					})
				: [];
			if (located.length) return located;
			// The whole block is the annotation only when the selection is that
			// block. A sentence that missed the text layer must not fill the block.
			const quote = normalizeSentenceKey(pick.locateText);
			const block = normalizeSentenceKey(pick.blockText);
			if (quote && quote === block) {
				return [bboxToPageRect(pick.bbox, size.width, size.height)];
			}
			return [];
		});
		if (!rects.length) continue;
		formatted.push({
			pageIndex,
			rect: unionPageRect(rects),
			segmentRects: rects,
		});
	}
	return formatted;
}

export function usePdfTranslationSelection({
	enabled,
	hostRef,
	zoomRef,
	engineRef,
	docCapRef,
	docId,
	itemsByPage,
	selectionMenu,
	setSelectionMenu,
	closeSelectionMenu,
	paperRelPath,
	paperAbsPath,
}: UsePdfTranslationSelectionOptions): void {
	const { i18n } = useTranslation();
	const itemsRef = useRef(itemsByPage);
	itemsRef.current = itemsByPage;
	const menuRef = useRef(selectionMenu);
	menuRef.current = selectionMenu;
	const langRef = useRef(i18n.language);
	langRef.current = i18n.language;
	const genRef = useRef(0);
	const pointerDownRef = useRef(false);
	const inflightRef = useRef(0);
	const releaseDragRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		if (enabled || !menuRef.current?.fromTranslation) return;
		closeSelectionMenu();
	}, [enabled, closeSelectionMenu]);

	useEffect(() => {
		if (!enabled) return;
		const host = hostRef.current;
		if (!host) return;

		// Drop the hold once the locate has settled and React has painted the
		// selection menu, which suppresses previews on its own. A locate that
		// finishes mid-drag must not release early.
		const scheduleReleaseDrag = () => {
			requestAnimationFrame(() => {
				if (pointerDownRef.current || inflightRef.current > 0) return;
				releaseDragRef.current?.();
				releaseDragRef.current = null;
			});
		};

		const commit = () => {
			const root = hostRef.current;
			if (!root) return;
			const range = hostRange(root);
			if (!range) {
				// Do not bump the generation. A focus move collapses the range
				// after pointerup, and that must not cancel the locate already
				// started for the text the reader just selected.
				if (menuRef.current?.fromTranslation && caretInsideLayoutItem(root)) {
					closeSelectionMenu();
				}
				return;
			}
			const selectedText = range.toString();
			const generation = ++genRef.current;
			const alive = () => genRef.current === generation;
			const hits = translationHitsFromRange(range, root);
			if (!hits.length) return;
			const items = [...itemsRef.current.values()].flat();
			const targetLang = langsFromSettings(
				loadSettings().translate,
				langRef.current ?? "en",
			).targetLang;
			const resolved = translationSelectionFromHits(
				hits,
				items,
				targetLang,
				range.toString(),
			);
			if (!resolved) return;
			void (async () => {
				inflightRef.current += 1;
				try {
					const pages = await locatePages(
						engineRef.current,
						docCapRef.current,
						docId,
						resolved,
						alive,
					);
					if (!pages?.length || !alive()) return;
					const live = hostRange(root);
					if (
						!live ||
						live.toString() !== selectedText ||
						translationHitsFromRange(live, root).length === 0 ||
						!alive()
					) {
						return;
					}
					const doc = docCapRef.current?.getDocument(docId);
					const anchorPage = pages[pages.length - 1];
					if (!anchorPage) return;
					const anchor = anchorFromEmbedSelection(
						pages,
						resolved.quote,
						(pageIndex) => doc?.pages[pageIndex]?.size ?? null,
						"selection",
						anchorPage.pageIndex,
					);
					const frames = pageFrames(root);
					const visiblePages = visiblePagesFromClientRects(
						Array.from(live.getClientRects()),
						frames,
					);
					const pageEl = pageElByIndex(root, anchorPage.pageIndex);
					const screen =
						visibleMenuPoint(
							visiblePages,
							anchorPage.pageIndex,
							(pageIndex) =>
								frames.find((frame) => frame.pageIndex === pageIndex) ?? null,
						) ??
						(pageEl
							? rectTopCenterScreen(pageEl, anchorPage.rect, zoomRef.current)
							: null);
					if (!anchor || !screen || !alive()) return;
					setSelectionMenu({
						screen,
						anchor,
						pages,
						copyText: resolved.copyText,
						fromTranslation: true,
						pairedTranslation: resolved.paired || undefined,
						visiblePages: visiblePages.length ? visiblePages : undefined,
					});
					publishSelection({
						text: resolved.quote,
						sourcePath: paperRelPath ?? paperAbsPath ?? "PDF",
						origin: "pdf",
						page: anchor.page,
						rects: anchor.rects,
						paperAbsPath: paperAbsPath ?? undefined,
						context: resolved.paired
							? { status: "unavailable", translation: resolved.paired }
							: undefined,
					});
				} finally {
					inflightRef.current = Math.max(0, inflightRef.current - 1);
					if (!pointerDownRef.current) scheduleReleaseDrag();
				}
			})();
		};

		const onPointerDown = (event: PointerEvent) => {
			pointerDownRef.current = true;
			if (event.button !== 0) return;
			const target = event.target;
			const el =
				target instanceof Element
					? target
					: target instanceof Node
						? target.parentElement
						: null;
			if (!el || !host.contains(el) || !el.closest("[data-layout-item]"))
				return;
			if (!releaseDragRef.current) {
				releaseDragRef.current = holdLinkPreviewDrag();
			}
		};
		// The page ends a text drag on bubble pointerup. Stopping that event
		// here leaves the drag active, so later moves keep extending it.
		const onPointerUp = () => {
			pointerDownRef.current = false;
			commit();
			scheduleReleaseDrag();
		};
		const onSelectionChange = () => {
			if (pointerDownRef.current) return;
			commit();
		};

		host.addEventListener("pointerdown", onPointerDown);
		host.addEventListener("pointerup", onPointerUp, true);
		host.addEventListener("pointercancel", onPointerUp, true);
		document.addEventListener("selectionchange", onSelectionChange);
		return () => {
			genRef.current += 1;
			releaseDragRef.current?.();
			releaseDragRef.current = null;
			host.removeEventListener("pointerdown", onPointerDown);
			host.removeEventListener("pointerup", onPointerUp, true);
			host.removeEventListener("pointercancel", onPointerUp, true);
			document.removeEventListener("selectionchange", onSelectionChange);
		};
	}, [
		enabled,
		hostRef,
		zoomRef,
		engineRef,
		docCapRef,
		docId,
		setSelectionMenu,
		closeSelectionMenu,
		paperRelPath,
		paperAbsPath,
	]);
}
