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
import type { useSelectionCapability } from "@embedpdf/plugin-selection/react";
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
	hasNativeSelectionOutsideHost,
	isEditableClipboardTarget,
} from "@/components/viewer/pdf/host-dom";
import type { SelectionMenuState } from "@/components/viewer/pdf/types";
import {
	clearActiveSelection,
	publishSelection,
} from "@/lib/agent/selection-store";

type SelectionCapabilityProvides = ReturnType<
	typeof useSelectionCapability
>["provides"];

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

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
};

export type PdfTextSelection = {
	selectionMenu: SelectionMenuState | null;
	/** Mirror so hover/dwell guards can read it without re-creating callbacks. */
	selectionMenuRef: RefObject<SelectionMenuState | null>;
	setSelectionMenu: Dispatch<SetStateAction<SelectionMenuState | null>>;
	/** Dismiss the menu and drop the underlying PDFium selection. */
	closeSelectionMenu: () => void;
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
}: UsePdfTextSelectionOptions): PdfTextSelection {
	const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(
		null,
	);
	const selectionMenuRef = useRef(selectionMenu);
	selectionMenuRef.current = selectionMenu;

	const closeSelectionMenu = useCallback(() => {
		setSelectionMenu(null);
		selectionCap?.clear(docId);
	}, [selectionCap, docId]);

	// Show the selection action menu when a drag-selection ends.
	useEffect(() => {
		if (!selectionCap || !docCap) return;
		const scope = selectionCap.forDocument(docId);
		const offEnd = scope.onEndSelection(() => {
			const pages = selectionCap.getFormattedSelection(docId);
			if (!pages.length) {
				setSelectionMenu(null);
				return;
			}
			const first = pages[0];
			const pageEl = pageElByIndex(hostRef.current, first.pageIndex);
			if (!pageEl) return;
			const screen = rectTopCenterScreen(pageEl, first.rect, zoomRef.current);
			void (async () => {
				let quote = "";
				try {
					const lines = await selectionCap.getSelectedText(docId).toPromise();
					quote = (lines ?? []).join(" ").replace(/\s+/g, " ").trim();
				} catch {
					// text extraction is best-effort
				}
				const doc = docCap.getDocument(docId);
				const anchor = anchorFromEmbedSelection(
					pages,
					quote,
					(pageIndex) => doc?.pages[pageIndex]?.size ?? null,
				);
				if (!anchor) return;
				setSelectionMenu({ screen, anchor, pages });
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
				setSelectionMenu(null);
				clearActiveSelection("pdf");
			}
		});
		return () => {
			offEnd();
			offChange();
			clearActiveSelection("pdf");
		};
	}, [
		selectionCap,
		docCap,
		docId,
		paperRelPath,
		paperAbsPath,
		hostRef,
		zoomRef,
	]);

	// PDFium selections are invisible to the browser: intercept copy so ⌘/Ctrl+C
	// yields the selected PDF text instead of nothing.
	useEffect(() => {
		if (!isActive || !selectionMenu || !selectionCap) return;
		const selectedText = selectionMenu.anchor.quote ?? "";
		if (!selectedText.trim()) return;
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
		selectionMenu,
		selectionMenuRef,
		setSelectionMenu,
		closeSelectionMenu,
	};
}
