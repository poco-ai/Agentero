import { tightenFormattedSelection } from "@/lib/pdf/selection-appearance";
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
 * selection outside the viewer host so it cannot steal a normal copy.
 */

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
	rectTopCenterScreen,
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
import {
	clearActiveSelection,
	publishSelection,
} from "@/lib/agent/selection-store";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { translationHitsFromRange } from "@/lib/pdf/layout/layout-sentence-selection";
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
	".pdf-translate-selection, [data-reflow-selection], [data-selection-comment], input, textarea, [contenteditable='true']";

/**
 * Starting a pointer gesture on the PDF page must not let the browser extend a
 * native selection from the source editor (or any other contenteditable) into
 * the PDF split. PDFium owns the PDF selection, so dropping the DOM range is
 * safe; translation / reflow DOM text and text inputs keep theirs.
 */
export function releaseNativeSelectionForPdfPointer({
	host,
	target,
}: {
	host: HTMLElement;
	target: EventTarget | null;
}): void {
	const element =
		target instanceof Element
			? target
			: target instanceof Node
				? target.parentElement
				: null;
	if (element?.closest(SELECTABLE_PDF_TEXT)) return;
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
): ScreenPoint | null {
	const pageEl = pageElByIndex(host, anchorPage.pageIndex);
	if (!pageEl) return null;
	return rectTopCenterScreen(pageEl, anchorPage.rect, zoom);
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
): ScreenPoint | null {
	if (host && menu.visiblePages?.length) {
		const screen = visibleMenuPoint(
			menu.visiblePages,
			menu.anchor.page - 1,
			(pageIndex) => pageFrame(host, pageIndex),
		);
		if (screen) return screen;
	}
	const anchorPage = menuAnchorPage(menu.pages, menu.anchor.page - 1);
	if (!anchorPage) return null;
	return menuScreenPoint(host, anchorPage, zoom);
}

export type UsePdfTextSelectionOptions = {
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
	const selectionGroup = useWritingSelectionGroup();
	const selectionEpochRef = useRef(0);

	const closeSelectionMenu = useCallback(() => {
		selectionEpochRef.current += 1;
		clearDomSelectionInside(hostRef.current);
		setSelectionMenu(null);
		selectionCap?.clear(docId);
		clearActiveSelection("pdf");
	}, [selectionCap, docId, hostRef]);

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
			);
			if (!screen) return prev;
			if (screen.x === prev.screen.x && screen.y === prev.screen.y) {
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
			releaseNativeSelectionForPdfPointer({
				host,
				target: event.target,
			});
		};
		host.addEventListener("pointerdown", onPointerDown, true);
		return () => host.removeEventListener("pointerdown", onPointerDown, true);
	}, [hostRef]);

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
			return translationHitsFromRange(selection.getRangeAt(0), host).length > 0;
		};
		const offBegin = scope.onBeginSelection(() => {
			setIsSelecting(true);
		});
		const offEnd = scope.onEndSelection(() => {
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
			const pages = tightenFormattedSelection(
				rawPages,
				state.geometry,
				state.selection,
			);
			const endPage = state.selection?.end?.page ?? null;
			const anchorPage = menuAnchorPage(
				pages,
				endPage != null ? endPage : undefined,
			);
			if (!anchorPage) {
				setIsSelecting(false);
				return;
			}

			const screen = menuScreenPoint(
				hostRef.current,
				anchorPage,
				zoomRef.current,
			);
			if (!screen) {
				setIsSelecting(false);
				return;
			}
			// Keep isSelecting true across the async quote extract so link
			// previews cannot flash between mouseup and the selection menu.
			const epoch = selectionEpochRef.current;
			void (async () => {
				let quote = "";
				try {
					const lines = await selectionCap.getSelectedText(docId).toPromise();
					quote = (lines ?? []).join(" ").replace(/\s+/g, " ").trim();
				} catch {
					// text extraction is best-effort
				}
				if (epoch !== selectionEpochRef.current) {
					setIsSelecting(false);
					return;
				}
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
				setSelectionMenu({ screen, anchor, pages });
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
				setIsSelecting(false);
				if (selectionInsideTranslation()) return;
				if (
					isCommentDraftActive?.() ||
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
		isCommentDraftActive,
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
			if (hasNativeSelectionOutsideHost(host)) return false;
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
			// PDFium's clipboard is the English text layer. A translation
			// selection has no PDFium range; copy the visible translation.
			if (selectionMenu.fromTranslation) {
				void copyTextToClipboard(selectedText);
				return;
			}
			selectionCap.copyToClipboard(docId);
		};

		document.addEventListener("copy", onCopy);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("copy", onCopy);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [isActive, selectionMenu, selectionCap, docId, hostRef]);

	return {
		selectionMenu: isActive ? selectionMenu : null,
		setSelectionMenu,
		isSelecting,
		closeSelectionMenu,
		rePlaceSelectionMenu,
	};
}
