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
	rectBottomCenterScreen,
} from "@/components/viewer/pdf/coords";
import { clearDomSelectionInside } from "@/components/viewer/pdf/host-dom";
import type { SelectionMenuState } from "@/components/viewer/pdf/types";
import {
	selectionFocusRect,
	selectionSideFromSelection,
} from "@/lib/agent/selection-side";
import { publishSelection } from "@/lib/agent/selection-store";
import {
	bboxToPageRect,
	locateSelectionGlyphs,
	type TranslationPagePick,
	type TranslationSelection,
	translationHitsFromRange,
	translationSelectionFromHits,
	translationTextFromRange,
} from "@/lib/pdf/layout/layout-sentence-selection";
import {
	clearTranslationSelectionBands,
	publishTranslationSelectionBands,
} from "@/lib/pdf/layout/translation-selection-bands";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";
import {
	mergeClientRectsIntoLines,
	type PageFrame,
	visibleMenuPoint,
	visiblePagesFromClientRects,
} from "@/lib/pdf/layout/visible-selection-rects";
import { holdLinkPreviewDrag } from "@/lib/pdf/link-preview-drag";
import {
	mergeTightGlyphRects,
	unionRectsAll,
} from "@/lib/pdf/selection-appearance";
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

function rangeElement(node: Node): Element | null {
	return node instanceof Element ? node : node.parentElement;
}

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
	if (!selection.canLocate) return [];
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
		if (!page || !size || size.width <= 0 || size.height <= 0) return [];
		let glyphs: { text: string; rect: Rect }[] = [];
		if (engine && doc && picks.some((pick) => !pick.glyphRects?.length)) {
			try {
				const raw = await engine.getPageGlyphs(doc, page).toPromise();
				if (!generation()) return null;
				const text = await engine
					.getTextSlices(
						doc,
						raw.map((_, charIndex) => ({
							pageIndex,
							charIndex,
							charCount: 1,
							rawCharacters: true,
						})),
					)
					.toPromise();
				glyphs = raw.map((glyph, index) => ({
					text: text[index] ?? "",
					rect: {
						origin: glyph.tightOrigin ?? glyph.origin,
						size: glyph.tightSize ?? glyph.size,
					},
				}));
			} catch {
				glyphs = [];
			}
		}
		if (!generation()) return null;
		const locatePick = (pick: TranslationPagePick): Rect[] => {
			if (pick.glyphRects?.length) return pick.glyphRects;
			const located = locateSelectionGlyphs(
				pick,
				glyphs,
				size.width,
				size.height,
			);
			if (located.length) return located;
			// The whole block is the annotation only when the selection is that
			// block. A sentence that missed the text layer must not fill the block.
			if (pick.wholeBlock) {
				return [bboxToPageRect(pick.bbox, size.width, size.height)];
			}
			return [];
		};
		const rectsByBlock = new Map<TranslationPagePick["bbox"], Rect[]>();
		for (const pick of picks) {
			const located = locatePick(pick).filter(
				(rect) => rect.size.width > 0 && rect.size.height > 0,
			);
			// Do not persist only the locatable pieces of a multi-sentence selection.
			if (!located.length) return [];
			const rects = rectsByBlock.get(pick.bbox);
			if (rects) rects.push(...located);
			else rectsByBlock.set(pick.bbox, located);
		}
		const segmentRects = [...rectsByBlock.values()].flatMap(
			mergeTightGlyphRects,
		);
		const rect = unionRectsAll(segmentRects);
		if (!rect) return [];
		formatted.push({ pageIndex, rect, segmentRects });
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

	useEffect(() => {
		if (enabled || !menuRef.current?.fromTranslation) return;
		closeSelectionMenu();
	}, [enabled, closeSelectionMenu]);

	useEffect(() => {
		if (!enabled) {
			clearTranslationSelectionBands(docId);
			return;
		}
		const host = hostRef.current;
		if (!host) return;
		let disposed = false;
		let visible = true;
		let pointerDown = false;
		let releaseDrag: (() => void) | null = null;
		let releaseFrame = 0;
		let bandFrame = 0;
		const inflight = new Set<number>();
		const reset = () => {
			genRef.current += 1;
			pointerDown = false;
			inflight.clear();
			if (bandFrame) cancelAnimationFrame(bandFrame);
			if (releaseFrame) cancelAnimationFrame(releaseFrame);
			bandFrame = 0;
			releaseFrame = 0;
			clearTranslationSelectionBands(docId);
			releaseDrag?.();
			releaseDrag = null;
		};
		// Dockview retains hidden tabs. Visibility, rather than workspace focus,
		// ends a drag so a visible split pane can still select translated text.
		const observer =
			typeof IntersectionObserver === "undefined"
				? null
				: new IntersectionObserver((entries) => {
						visible = entries.some((entry) => entry.isIntersecting);
						if (visible) return;
						reset();
						clearDomSelectionInside(host);
						if (menuRef.current?.fromTranslation) setSelectionMenu(null);
					});
		observer?.observe(host);

		// Drop the hold once the locate has settled and React has painted the
		// selection menu, which suppresses previews on its own. A locate that
		// finishes mid-drag must not release early.
		const scheduleReleaseDrag = () => {
			if (releaseFrame || !releaseDrag) return;
			releaseFrame = requestAnimationFrame(() => {
				releaseFrame = 0;
				if (pointerDown || inflight.size > 0) return;
				releaseDrag?.();
				releaseDrag = null;
			});
		};

		const commit = () => {
			if (!visible) return;
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
			const lastHit = hits.at(-1);
			const preferredPageIndex = items.find(
				(item) => item.id === lastHit?.itemId,
			)?.pageIndex;
			const targetLang = langsFromSettings(
				loadSettings().translate,
				langRef.current ?? "en",
			).targetLang;
			const resolved = translationSelectionFromHits(
				hits,
				items,
				targetLang,
				translationTextFromRange(range, root),
			);
			if (!resolved) return;
			void (async () => {
				inflight.add(generation);
				try {
					const pages = await locatePages(
						engineRef.current,
						docCapRef.current,
						docId,
						resolved,
						alive,
					);
					if (!pages || !alive()) return;
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
					const anchorPage =
						pages.find((page) => page.pageIndex === preferredPageIndex) ??
						pages.at(-1);
					const pageIndex =
						anchorPage?.pageIndex ??
						preferredPageIndex ??
						resolved.pages.at(-1)?.pageIndex;
					if (pageIndex == null) return;
					// A geometry miss still has a quote for copy and chat. It has no
					// original rectangles for a persisted highlight or note.
					const anchor = anchorFromEmbedSelection(
						pages,
						resolved.quote,
						(pageIndex) => doc?.pages[pageIndex]?.size ?? null,
						"selection",
						pageIndex,
					) ?? {
						page: pageIndex + 1,
						rects: [],
						quote: resolved.quote,
						trigger: "selection" as const,
					};
					const frames = pageFrames(root);
					const visiblePages = visiblePagesFromClientRects(
						mergeClientRectsIntoLines(Array.from(live.getClientRects())),
						frames,
					);
					const pageEl = pageElByIndex(root, pageIndex);
					const domSelection = window.getSelection();
					const side = selectionSideFromSelection(domSelection);
					const focusRect = selectionFocusRect(domSelection);
					const anchorFrame = frames.find(
						(frame) => frame.pageIndex === pageIndex,
					);
					const cursorXFraction =
						focusRect && anchorFrame && anchorFrame.width > 0
							? (focusRect.left - anchorFrame.left) / anchorFrame.width
							: undefined;
					const visibleScreen = visibleMenuPoint(
						visiblePages,
						pageIndex,
						(pageIndex) =>
							frames.find((frame) => frame.pageIndex === pageIndex) ?? null,
						cursorXFraction,
					);
					const fallbackBox =
						!visibleScreen && pageEl && anchorPage
							? rectBottomCenterScreen(pageEl, anchorPage.rect, zoomRef.current)
							: null;
					const screen = visibleScreen
						? { ...visibleScreen, side }
						: fallbackBox
							? {
									x: fallbackBox.x,
									y: fallbackBox.top,
									top: fallbackBox.top,
									bottom: fallbackBox.bottom,
									side,
									cursorX: focusRect?.left,
								}
							: null;
					if (!screen || !alive()) return;
					setSelectionMenu({
						screen,
						cursorXFraction,
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
					inflight.delete(generation);
					if (!disposed && visible && !pointerDown) scheduleReleaseDrag();
				}
			})();
		};

		const onPointerDown = (event: PointerEvent) => {
			if (!visible || event.button !== 0) return;
			pointerDown = true;
			const target = event.target;
			const el =
				target instanceof Element
					? target
					: target instanceof Node
						? target.parentElement
						: null;
			if (!el || !host.contains(el) || !el.closest("[data-layout-item]"))
				return;
			if (!releaseDrag) {
				releaseDrag = holdLinkPreviewDrag();
			}
		};
		// The page ends a text drag on bubble pointerup. Stopping that event
		// here leaves the drag active, so later moves keep extending it.
		const onPointerUp = () => {
			pointerDown = false;
			commit();
			scheduleReleaseDrag();
		};
		// One rectangle per line. Reflow places one absolute box per character
		// above the raster; painting ::selection on each of those boxes stacks
		// in the seam. The band covers a reflow drag too.
		const publishBands = () => {
			if (!visible) return;
			const root = hostRef.current;
			const selection = window.getSelection();
			if (
				!root ||
				!selection ||
				selection.isCollapsed ||
				selection.rangeCount === 0
			) {
				clearTranslationSelectionBands(docId);
				return;
			}
			const range = selection.getRangeAt(0);
			const anchor = rangeElement(range.startContainer);
			const focus = rangeElement(range.endContainer);
			const inside = (el: Element | null) =>
				Boolean(el && root.contains(el) && el.closest("[data-layout-item]"));
			if (!inside(anchor) && !inside(focus)) {
				clearTranslationSelectionBands(docId);
				return;
			}
			publishTranslationSelectionBands(
				docId,
				visiblePagesFromClientRects(
					mergeClientRectsIntoLines(Array.from(range.getClientRects())),
					pageFrames(root),
				),
			);
		};
		const scheduleBands = () => {
			if (bandFrame) return;
			bandFrame = requestAnimationFrame(() => {
				bandFrame = 0;
				publishBands();
			});
		};
		const onSelectionChange = () => {
			if (!visible) return;
			scheduleBands();
			if (pointerDown) return;
			commit();
		};

		host.addEventListener("pointerdown", onPointerDown);
		host.addEventListener("pointerup", onPointerUp, true);
		host.addEventListener("pointercancel", onPointerUp, true);
		document.addEventListener("selectionchange", onSelectionChange);
		return () => {
			disposed = true;
			observer?.disconnect();
			reset();
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
