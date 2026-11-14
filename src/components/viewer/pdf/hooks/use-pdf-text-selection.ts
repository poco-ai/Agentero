import {
	selectionInsertionExclusions,
	selectionTextExclusionsForPage,
	selectionTextSlices,
	tightenFormattedSelection,
} from "@/lib/pdf/selection-appearance";
/**
 * Text-selection detection for the EmbedPDF viewer: turning an EmbedPDF drag
 * selection into a placed floating action menu, publishing the selected text to
 * the Agent selection store, and making ⌘/Ctrl+C copy the *PDF* selection.
 *
 * Only detection, placement and menu state live here. The menu's actions
 * (highlight / note / ask / add-to-chat / translate) each belong to another
 * cluster, so they stay with their owners and are passed into the menu by the
 * parent — this hook just says where the menu is and clears it.
 *
 * The copy interception exists because a PDFium text selection is not a DOM
 * selection: the browser has nothing to copy. It is installed only while a menu
 * is open on the active tab, and defers to any real editable target or native
 * selection outside the viewer host or inside the reader so it cannot steal a normal copy.
 */

import type { PdfEngine, Rect } from "@embedpdf/models";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import type {
	FormattedSelection,
	useSelectionCapability,
} from "@embedpdf/plugin-selection/react";
import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	anchorFromEmbedSelection,
	pageElByIndex,
	rectBottomCenterScreen,
} from "@/components/viewer/pdf/coords";
import {
	clearDomSelectionInside,
	hasNativeSelectionOutsideHost,
	isEditableClipboardTarget,
} from "@/components/viewer/pdf/host-dom";
import type {
	ScreenPoint,
	SelectionMenuState,
} from "@/components/viewer/pdf/types";
import { useWritingSelectionGroup } from "@/components/writing/writing-selection-group";
import type { SelectionSide } from "@/lib/agent/selection-side";
import {
	clearActiveSelection,
	publishSelection,
} from "@/lib/agent/selection-store";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { translationHitsFromRange } from "@/lib/pdf/layout/layout-sentence-selection";
import { getLayoutDocumentResult } from "@/lib/pdf/layout/store";
import {
	type PageFrame,
	visibleMenuPoint,
} from "@/lib/pdf/layout/visible-selection-rects";
import { linkPreviewDragActive } from "@/lib/pdf/link-preview-drag";

type SelectionCapabilityProvides = ReturnType<
	typeof useSelectionCapability
>["provides"];

/** DOM-text surfaces inside the viewer that keep native selection. */
const SELECTABLE_PDF_TEXT =
	".pdf-translate-selection, [data-reflow-selection], [data-pdf-reader], [data-selection-comment], input, textarea, [contenteditable='true']";

/**
 * Starting a pointer gesture on the PDF page must not let the browser extend a
 * native selection from the source editor (or any other contenteditable) into
 * the PDF split. PDFium owns the PDF selection, so dropping the DOM range is
 * safe; translation / reflow DOM text and text inputs keep theirs.
 */
export function releaseNativeSelectionForPdfPointer({
	host,
	target,
	event,
}: {
	host: HTMLElement;
	target: EventTarget | null;
	event?: Pick<PointerEvent, "preventDefault">;
}): void {
	const element =
		target instanceof Element
			? target
			: target instanceof Node
				? target.parentElement
				: null;
	if (element?.closest(SELECTABLE_PDF_TEXT)) return;
	if (element?.closest("[data-pdf-chrome]")) return;
	if (element?.closest("[data-embed-pdf-page]")) {
		event?.preventDefault();
		// Canceling the pointer default keeps WebKit from moving focus off a
		// previously focused tree or tab, so claim the reading surface explicitly.
		element
			.closest<HTMLElement>("[data-pdf-viewport]")
			?.focus({ preventScroll: true });
	}
	// CodeMirror is contenteditable: if it keeps focus, its DOM observer can
	// adopt the browser selection dragged across the split.
	const active = document.activeElement;
	if (
		active instanceof HTMLElement &&
		!host.contains(active) &&
		active.isContentEditable
	) {
		active.blur();
	}
	window.getSelection()?.removeAllRanges();
}

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

/** Pick the page the floating menu should track (cursor-end page when known). */
function menuAnchorPage(
	pages: FormattedSelection[],
	preferredPageIndex?: number,
): FormattedSelection | null {
	if (!pages.length) return null;
	if (preferredPageIndex != null) {
		const match = pages.find((p) => p.pageIndex === preferredPageIndex);
		if (match) return match;
	}
	return pages[pages.length - 1] ?? pages[0] ?? null;
}

/** Map a formatted selection page to the floating toolbar screen anchor. */
function menuScreenPoint(
	host: HTMLElement | null,
	anchorPage: FormattedSelection,
	zoom: number,
	side?: SelectionSide,
	cursorXFraction?: number,
): ScreenPoint | null {
	const pageEl = pageElByIndex(host, anchorPage.pageIndex);
	if (!pageEl) return null;
	const box = rectBottomCenterScreen(pageEl, anchorPage.rect, zoom);
	const pageBox = pageEl.getBoundingClientRect();
	const cursorX =
		cursorXFraction != null && pageBox.width > 0
			? pageBox.left + cursorXFraction * pageBox.width
			: undefined;
	return {
		x: box.x,
		cursorX,
		y: box.top,
		top: box.top,
		bottom: box.bottom,
		side,
	};
}

function pageFrame(host: HTMLElement, pageIndex: number): PageFrame | null {
	const el = pageElByIndex(host, pageIndex);
	if (!el) return null;
	const box = el.getBoundingClientRect();
	if (box.width <= 0 || box.height <= 0) return null;
	return {
		pageIndex,
		left: box.left,
		top: box.top,
		width: box.width,
		height: box.height,
	};
}

/**
 * Toolbar anchor. A translation selection tracks the translated boxes; an
 * English text-layer selection tracks the glyph rect.
 */
function menuScreenFromState(
	host: HTMLElement | null,
	menu: SelectionMenuState,
	zoom: number,
	side?: SelectionSide,
): ScreenPoint | null {
	if (host && menu.visiblePages?.length) {
		const screen = visibleMenuPoint(
			menu.visiblePages,
			menu.anchor.page - 1,
			(pageIndex) => pageFrame(host, pageIndex),
			menu.cursorXFraction,
		);
		if (screen) return { ...screen, side };
	}
	const anchorPage = menuAnchorPage(menu.pages, menu.anchor.page - 1);
	if (!anchorPage) return null;
	return menuScreenPoint(host, anchorPage, zoom, side, menu.cursorXFraction);
}

export type UsePdfTextSelectionOptions = {
	ensureSelectionTextExclusions?: (
		pages: readonly number[],
	) => Promise<ReadonlyMap<number, readonly Rect[]>>;
	engine?: PdfEngine | null;
	selectionTextExclusionsByPage?: ReadonlyMap<number, readonly Rect[]>;
	/** EmbedPDF capabilities; owned by `PdfViewerInner` (plugin context). */
	selectionCap: SelectionCapabilityProvides;
	docCap: DocumentManagerCapability;
	docId: string;
	hostRef: RefObject<HTMLDivElement | null>;
	/** Current zoom, mirrored so menu placement never re-subscribes. */
	zoomRef: RefObject<number>;
	/** Only the active tab may hijack copy. */
	isActive: boolean;
	/** Provenance for the published selection (Agent chips / conversation pins). */
	paperRelPath: string | null;
	paperAbsPath: string | null;
	/** Keep toolbar placed while editing a selection note chip. */
	isCommentDraftActive?: () => boolean;
};

export type PdfTextSelection = {
	selectionStartPageIndex: number | null;
	selectionMenu: SelectionMenuState | null;
	setSelectionMenu: Dispatch<SetStateAction<SelectionMenuState | null>>;
	/**
	 * True while the pointer is mid drag-select (between EmbedPDF begin/end).
	 * Used to suppress ephemeral link previews that would otherwise pop while
	 * the selection sweeps across citation / crossref hit targets.
	 */
	isSelecting: boolean;
	/** Dismiss the menu and drop the underlying PDFium selection. */
	closeSelectionMenu: () => void;
	/**
	 * Recompute the toolbar screen anchor from the live page DOM.
	 * Call on viewport scroll and zoom so the menu stays glued to the selection.
	 */
	rePlaceSelectionMenu: () => void;
};

export function usePdfTextSelection({
	ensureSelectionTextExclusions,
	engine,
	selectionTextExclusionsByPage,
	selectionCap,
	docCap,
	docId,
	hostRef,
	zoomRef,
	isActive,
	paperRelPath,
	paperAbsPath,
	isCommentDraftActive,
}: UsePdfTextSelectionOptions): PdfTextSelection {
	const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(
		null,
	);
	const [isSelecting, setIsSelecting] = useState(false);
	const [selectionStartPageIndex, setSelectionStartPageIndex] = useState<
		number | null
	>(null);
	const selectionGroup = useWritingSelectionGroup();
	const selectionEpochRef = useRef(0);
	const contentRef = useRef({
		engine,
		selectionTextExclusionsByPage,
		ensureSelectionTextExclusions,
	});
	contentRef.current = {
		engine,
		selectionTextExclusionsByPage,
		ensureSelectionTextExclusions,
	};
	const selectionStartPageRef = useRef<number | null>(null);
	/** Vertical drag direction; PDFium normalizes start/end, so track the pointer. */
	const dragPointerRef = useRef<{
		downY: number;
		upY: number | null;
		upX: number | null;
	} | null>(null);
	// Read through a ref: callers pass an inline lambda, and putting it in the
	// subscription deps would tear down and re-register the EmbedPDF listeners
	// on every viewer render (clearing the live selection each time).
	const isCommentDraftActiveRef = useRef(isCommentDraftActive);
	isCommentDraftActiveRef.current = isCommentDraftActive;

	const clearPdfSelection = useCallback(() => {
		selectionEpochRef.current += 1;
		setIsSelecting(false);
		hostRef.current?.removeAttribute("data-pdf-drag-selection");
		setSelectionMenu(null);
		selectionCap?.clear(docId);
		clearActiveSelection("pdf");
	}, [selectionCap, docId, hostRef]);
	const closeSelectionMenu = useCallback(() => {
		clearDomSelectionInside(hostRef.current);
		clearPdfSelection();
	}, [clearPdfSelection, hostRef]);

	// Dockview keeps hidden tabs mounted. Drop their selection, including any
	// pending text extraction, as soon as this viewer loses focus or unmounts.
	useEffect(() => {
		if (!isActive) return;
		return closeSelectionMenu;
	}, [isActive, closeSelectionMenu]);

	const rePlaceSelectionMenu = useCallback(() => {
		setSelectionMenu((prev) => {
			if (!prev) return prev;
			const screen = menuScreenFromState(
				hostRef.current,
				prev,
				zoomRef.current,
				prev.screen.side,
			);
			if (!screen) return prev;
			if (
				screen.x === prev.screen.x &&
				screen.y === prev.screen.y &&
				screen.bottom === prev.screen.bottom &&
				screen.cursorX === prev.screen.cursorX &&
				screen.side === prev.screen.side
			) {
				return prev;
			}
			return { ...prev, screen };
		});
	}, [hostRef, zoomRef]);

	// A drag that starts on the PDF page must not extend the browser's native
	// selection from the previously focused source editor. PDFium owns the PDF
	// selection, so dropping the DOM range is safe; DOM-text translation and
	// input surfaces keep theirs.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const onPointerDown = (event: PointerEvent) => {
			if (event.button !== 0) return;
			const element = event.target instanceof Element ? event.target : null;
			if (
				element?.closest("[data-embed-pdf-page]") &&
				!element.closest(
					"[data-pdf-chrome], input, textarea, [contenteditable='true']",
				)
			) {
				host.setAttribute("data-pdf-drag-selection", "");
			} else {
				host.removeAttribute("data-pdf-drag-selection");
			}
			dragPointerRef.current = {
				downY: event.clientY,
				upY: null,
				upX: null,
			};
			const target =
				event.target instanceof Element
					? event.target
					: event.target instanceof Node
						? event.target.parentElement
						: null;
			if (target?.closest("[data-pdf-reader]")) {
				// Reader DOM ranges must survive clearing the old PDFium selection.
				clearPdfSelection();
				return;
			}
			releaseNativeSelectionForPdfPointer({
				host,
				target: event.target,
				event,
			});
		};
		const onPointerUp = (event: PointerEvent) => {
			if (event.button !== 0) return;
			const drag = dragPointerRef.current;
			if (drag) {
				drag.upY = event.clientY;
				drag.upX = event.clientX;
			}
		};
		host.addEventListener("pointerdown", onPointerDown, true);
		// Window capture runs before PDFium's own pointerup, so the menu can
		// compare where the drag ended with where it started.
		window.addEventListener("pointerup", onPointerUp, true);
		return () => {
			host.removeEventListener("pointerdown", onPointerDown, true);
			host.removeAttribute("data-pdf-drag-selection");
			window.removeEventListener("pointerup", onPointerUp, true);
		};
	}, [hostRef, clearPdfSelection]);

	// Source editor took over the writing split: drop the PDFium selection and
	// its toolbar so only one side stays visibly selected.
	useEffect(() => {
		if (!selectionGroup) return;
		return selectionGroup.subscribe((origin) => {
			if (origin === "source") closeSelectionMenu();
		});
	}, [selectionGroup, closeSelectionMenu]);

	// Show the selection action menu when a drag-selection ends.
	useEffect(() => {
		if (!isActive || !selectionCap || !docCap) return;

		const scope = selectionCap.forDocument(docId);
		// A translation drag is a DOM range on top of the English glyphs. Ending
		// or clearing the PDFium selection must not dismiss the menu that range owns.
		const selectionInsideTranslation = (): boolean => {
			const host = hostRef.current;
			const selection = window.getSelection();
			if (
				!host ||
				!selection ||
				selection.isCollapsed ||
				selection.rangeCount === 0
			) {
				return false;
			}
			const range = selection.getRangeAt(0);
			const node = range.startContainer;
			const element = node instanceof Element ? node : node.parentElement;
			return (
				Boolean(
					element &&
						host.contains(element) &&
						element.closest("[data-pdf-reader]"),
				) || translationHitsFromRange(range, host).length > 0
			);
		};
		const offBegin = scope.onBeginSelection(({ page }) => {
			setSelectionStartPageIndex(page);
			selectionEpochRef.current += 1;
			selectionStartPageRef.current = page;
			setIsSelecting(true);
		});
		const offEnd = scope.onEndSelection(async () => {
			const epoch = selectionEpochRef.current;
			const drag = dragPointerRef.current;
			dragPointerRef.current = null;
			let side: SelectionSide | undefined =
				drag?.upY != null && Math.abs(drag.upY - drag.downY) >= 4
					? drag.upY > drag.downY
						? "below"
						: "above"
					: undefined;
			// Glyphs under the overlay share the pointer, so a drag on the
			// translation also ends an English selection. Drop those rects and
			// leave the DOM range's menu in place.
			// The drag flag covers the moment the DOM range is not ready yet.
			// Leaving the English rects would paint them under the Chinese.
			if (selectionInsideTranslation() || linkPreviewDragActive()) {
				setIsSelecting(false);
				selectionCap.clear(docId);
				return;
			}
			const rawPages = selectionCap.getFormattedSelection(docId);
			if (!rawPages.length) {
				setIsSelecting(false);
				setSelectionMenu(null);
				return;
			}

			// Anchor the toolbar to the page where the cursor ended. For cross-page
			// selections the first page may be scrolled out of view, which makes the
			// toolbar appear off-screen and seem missing.
			const state = selectionCap.getState(docId);
			const content = { ...contentRef.current };
			const crossPageSelection =
				state.selection &&
				state.selection.start.page !== state.selection.end.page;
			if (crossPageSelection && content.ensureSelectionTextExclusions) {
				content.selectionTextExclusionsByPage =
					await content.ensureSelectionTextExclusions(
						rawPages.map((page) => page.pageIndex),
					);
				if (epoch !== selectionEpochRef.current) return;
			}
			const excludedByPage = new Map(
				crossPageSelection ? content.selectionTextExclusionsByPage : [],
			);
			if (crossPageSelection) {
				for (const [pageIndex, rects] of excludedByPage) {
					excludedByPage.set(
						pageIndex,
						selectionTextExclusionsForPage(
							rects,
							state.geometry,
							state.selection,
							pageIndex,
							selectionStartPageRef.current,
						),
					);
				}
			}
			const layout = getLayoutDocumentResult(docId);
			const insertions = selectionInsertionExclusions(
				state.geometry,
				state.selection,
				[...(layout?.rawRegions ?? []), ...(layout?.regions ?? [])],
				selectionStartPageRef.current,
				"cached",
			);
			for (const [pageIndex, rects] of insertions) {
				excludedByPage.set(pageIndex, [
					...(excludedByPage.get(pageIndex) ?? []),
					...rects,
				]);
			}
			const pages = tightenFormattedSelection(
				rawPages,
				state.geometry,
				state.selection,
				excludedByPage,
			);
			// EmbedPDF sorts the range in reading order. The endpoint opposite
			// the drag's start page is the cursor page, including upward drags.
			const endPage =
				selectionStartPageRef.current === state.selection?.end.page
					? state.selection?.start.page
					: state.selection?.end.page;
			const startPage = selectionStartPageRef.current;
			if (startPage != null && endPage != null && startPage !== endPage) {
				side = endPage > startPage ? "below" : "above";
			}
			const anchorPage = menuAnchorPage(
				pages.filter((page) => pageElByIndex(hostRef.current, page.pageIndex)),
				endPage,
			);
			if (!anchorPage) {
				setIsSelecting(false);
				return;
			}

			const pageEl = pageElByIndex(hostRef.current, anchorPage.pageIndex);
			const pageBox = pageEl?.getBoundingClientRect();
			const cursorXFraction =
				drag?.upX != null && pageBox && pageBox.width > 0
					? (drag.upX - pageBox.left) / pageBox.width
					: undefined;
			const screen = menuScreenPoint(
				hostRef.current,
				anchorPage,
				zoomRef.current,
				side,
				cursorXFraction,
			);
			if (!screen) {
				setIsSelecting(false);
				return;
			}
			// Keep isSelecting true across the async quote extract so link
			// previews cannot flash between mouseup and the selection menu.
			void (async () => {
				let quote = "";
				try {
					// Keep the selection capability's copy-permission checks before
					// requesting the same text with margins and table cells omitted.
					let lines = await selectionCap.getSelectedText(docId).toPromise();
					const doc = docCap.getDocument(docId);
					const { engine } = content;
					const requests =
						engine &&
						doc &&
						rawPages.some((page) => excludedByPage.get(page.pageIndex)?.length)
							? Object.entries(state.slices).flatMap(([key, slice]) => {
									const pageIndex = Number(key);
									const excluded = excludedByPage.get(pageIndex) ?? [];
									const geometry = state.geometry[pageIndex];
									const slices =
										geometry && excluded.length
											? selectionTextSlices(
													geometry,
													slice.start,
													slice.count,
													excluded,
												)
											: [slice];
									return slices.map(({ start, count }) => ({
										pageIndex,
										charIndex: start,
										charCount: count,
									}));
								})
							: null;
					if (requests && engine && doc) {
						lines = await engine.getTextSlices(doc, requests).toPromise();
					}
					quote = (lines ?? []).join(" ").replace(/\s+/g, " ").trim();
				} catch {
					// text extraction is best-effort
				}
				if (epoch !== selectionEpochRef.current) return;
				const doc = docCap.getDocument(docId);
				const anchor = anchorFromEmbedSelection(
					pages,
					quote,
					(pageIndex) => doc?.pages[pageIndex]?.size ?? null,
					"selection",
					anchorPage.pageIndex,
				);
				if (!anchor) {
					setIsSelecting(false);
					return;
				}
				setSelectionMenu({ screen, cursorXFraction, anchor, pages });
				setIsSelecting(false);
				selectionGroup?.announce("pdf");
				publishSelection({
					text: quote,
					sourcePath: paperRelPath ?? paperAbsPath ?? "PDF",
					origin: "pdf",
					page: anchor.page,
					rects: anchor.rects,
					paperAbsPath: paperAbsPath ?? undefined,
				});
			})();
		});
		const offChange = scope.onSelectionChange((sel) => {
			if (!sel) {
				selectionEpochRef.current += 1;
				setIsSelecting(false);
				if (selectionInsideTranslation()) return;
				if (
					isCommentDraftActiveRef.current?.() ||
					document.activeElement?.closest("[data-selection-comment]")
				) {
					return;
				}
				setSelectionMenu(null);
				clearActiveSelection("pdf");
			}
		});
		return () => {
			offBegin();
			offEnd();
			offChange();
			setIsSelecting(false);
			clearActiveSelection("pdf");
		};
	}, [
		isActive,
		selectionCap,
		docCap,
		docId,
		paperRelPath,
		paperAbsPath,
		hostRef,
		zoomRef,
		selectionGroup,
	]);

	// PDFium selections are invisible to the browser: intercept copy so ⌘/Ctrl+C
	// yields the selected PDF text instead of nothing.
	useEffect(() => {
		if (!isActive || !selectionMenu || !selectionCap) return;
		const selectedText = (
			selectionMenu.copyText ??
			selectionMenu.anchor.quote ??
			""
		).trim();
		if (!selectedText) return;
		const host = hostRef.current;

		const shouldHandlePdfCopy = (target: EventTarget | null): boolean => {
			if (isEditableClipboardTarget(target)) return false;
			const node = window.getSelection()?.anchorNode;
			const element = node instanceof Element ? node : node?.parentElement;
			if (element?.closest("[data-pdf-chrome]")) return false;
			if (hasNativeSelectionOutsideHost(host)) return false;
			const selection = window.getSelection();
			if (selection && !selection.isCollapsed) {
				for (const node of [selection.anchorNode, selection.focusNode]) {
					const element = node instanceof Element ? node : node?.parentElement;
					if (element?.closest("[data-pdf-reader]")) return false;
				}
			}
			return true;
		};

		const onCopy = (event: ClipboardEvent) => {
			if (!shouldHandlePdfCopy(event.target)) return;
			event.preventDefault();
			event.clipboardData?.setData("text/plain", selectedText);
		};

		const onKeyDown = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey)) return;
			if (event.shiftKey || event.altKey || event.key.toLowerCase() !== "c")
				return;
			if (!shouldHandlePdfCopy(event.target)) return;
			event.preventDefault();
			void copyTextToClipboard(selectedText);
		};

		document.addEventListener("copy", onCopy);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("copy", onCopy);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [isActive, selectionMenu, selectionCap, hostRef]);

	return {
		selectionStartPageIndex,
		selectionMenu: isActive ? selectionMenu : null,
		setSelectionMenu,
		isSelecting,
		closeSelectionMenu,
		rePlaceSelectionMenu,
	};
}
