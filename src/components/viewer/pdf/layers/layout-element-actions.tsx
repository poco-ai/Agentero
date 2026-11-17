/**
 * Action view for the layout element under the pointer.
 * Add to chat and selection-translate go through the shared selection
 * actions. A figure / table / formula crop is composer input only: nothing
 * is written to marks and the annotation editor stays closed.
 */

import type { PdfEngine } from "@embedpdf/models";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { addSelectionToChat } from "@/components/selection/add-selection-to-chat";
import { SelectionActionMenu } from "@/components/selection/selection-action-menu";
import { selectionBoundsOnScreen } from "@/components/viewer/pdf/coords";
import { isPdfDocumentCloseRaceError } from "@/components/viewer/pdf/host-dom";
import {
	closeLayoutElementAction,
	type LayoutElementAction,
	type LayoutElementScreen,
	layoutElementActionStore,
	moveLayoutElementAction,
} from "@/components/viewer/pdf/layout-element-action-store";
import { renderPdfRegionPromptImage } from "@/components/viewer/pdf/region-crop";
import { presentAgentComposer } from "@/lib/agent/composer-focus";
import {
	normalizeQuoteContext,
	quoteContextFromText,
} from "@/lib/agent/selection-context";
import { addVisualDraft } from "@/lib/agent/visual-context-store";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { notifyError } from "@/lib/core/notify";
import type { PdfAskAnchor } from "@/lib/pdf/ask/types";
import {
	layoutDocumentKey,
	layoutElementNeedsCrop,
	layoutKindI18nKey,
} from "@/lib/pdf/layout";
import { layoutAnalysisStore } from "@/lib/pdf/layout/store";

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

type LayoutElementActionsProps = {
	docId: string;
	engine: PdfEngine | null;
	docCap: DocumentManagerCapability;
	paperRelPath: string | null;
	paperAbsPath: string | null;
	translateSelection: (anchor: PdfAskAnchor) => void;
};

function elementContext(action: LayoutElementAction, heading: string) {
	const regions =
		layoutAnalysisStore.getState().byDocument[layoutDocumentKey(action.docId)]
			?.regions ?? [];
	const region = regions.find((item) => item.id === action.regionId);
	const located =
		region?.text && action.quote
			? quoteContextFromText(region.text, action.quote)
			: { status: "unavailable" as const };
	if (located.status === "available") {
		return normalizeQuoteContext({ ...located, heading });
	}
	return normalizeQuoteContext({ status: "available", heading });
}

function placeAction(action: LayoutElementAction): LayoutElementScreen | null {
	const page = document.querySelector<HTMLElement>(
		`[data-annotation-pdf="${CSS.escape(action.docId)}"][data-embed-pdf-page="${action.pageIndex}"]`,
	);
	if (!page) return null;
	const bounds = selectionBoundsOnScreen(page, action.rects);
	if (!bounds) return null;
	return {
		x: (bounds.left + bounds.right) / 2,
		y: bounds.top,
		top: bounds.top,
		bottom: bounds.bottom,
		cursorX: (bounds.left + bounds.right) / 2,
		selectionBounds: bounds,
		side: "above",
	};
}

export function LayoutElementActions({
	docId,
	engine,
	docCap,
	paperRelPath,
	paperAbsPath,
	translateSelection,
}: LayoutElementActionsProps): ReactNode {
	const { t } = useTranslation("viewer");
	const action = useStore(layoutElementActionStore, (state) =>
		state.action?.docId === docId ? state.action : null,
	);

	useEffect(() => {
		const current = layoutElementActionStore.getState().action;
		if (current && current.docId !== docId) closeLayoutElementAction();
	}, [docId]);

	useEffect(() => {
		if (!action) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			closeLayoutElementAction();
		};
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (target.closest("[data-selection-menu], [data-layout-element]")) {
				return;
			}
			closeLayoutElementAction();
		};
		let raf = 0;
		const onScroll = () => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				const current = layoutElementActionStore.getState().action;
				if (!current || current.docId !== docId) return;
				const screen = placeAction(current);
				if (!screen) {
					closeLayoutElementAction();
					return;
				}
				moveLayoutElementAction(screen);
			});
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("scroll", onScroll, true);
			if (raf) cancelAnimationFrame(raf);
		};
	}, [action, docId]);

	if (!action || typeof document === "undefined") return null;

	const kindLabel = t(layoutKindI18nKey(action.kind));
	const quote = action.quote.trim();
	const sourcePath = paperRelPath ?? paperAbsPath ?? "PDF";

	const pinQuote = () => {
		if (!quote) return false;
		addSelectionToChat({
			text: quote,
			sourcePath,
			origin: "pdf",
			context: elementContext(action, kindLabel),
			page: action.pageIndex + 1,
			rects: action.rects,
			paperAbsPath: paperAbsPath ?? undefined,
		});
		return true;
	};

	const addToChat = () => {
		const current = action;
		closeLayoutElementAction();
		const needsCrop = layoutElementNeedsCrop(current.kind);
		if (!needsCrop) {
			pinQuote();
			return;
		}
		void (async () => {
			let cropped = false;
			try {
				if (!engine || !docCap || !docCap.isDocumentOpen(docId)) {
					throw new Error(t("pdfExplain.cropFailed"));
				}
				const documentObject = docCap.getDocument(docId);
				if (!documentObject) throw new Error(t("pdfExplain.cropFailed"));
				const image = await renderPdfRegionPromptImage({
					engine,
					document: documentObject,
					pageIndex: current.pageIndex,
					region: current.bbox,
				});
				if (!docCap.isDocumentOpen(docId)) return;
				addVisualDraft({
					id: `layout-el:${current.regionId}`,
					paperPath: paperRelPath || paperAbsPath || "paper",
					paperAbsPath: paperAbsPath ?? undefined,
					page: current.pageIndex + 1,
					rects: [current.bbox],
					comment: kindLabel,
					image,
				});
				cropped = true;
			} catch (error) {
				if (
					!docCap?.isDocumentOpen(docId) ||
					isPdfDocumentCloseRaceError(error)
				) {
					return;
				}
				if (!quote) {
					const message =
						error instanceof Error ? error.message : t("pdfExplain.cropFailed");
					notifyError(t("pdfExplain.cropFailed"), { description: message });
					return;
				}
			}
			if (pinQuote()) return;
			if (cropped) presentAgentComposer({ preserveCaret: true });
		})();
	};

	return createPortal(
		<SelectionActionMenu
			screen={action.screen}
			selectionText={quote}
			onAddToChat={addToChat}
			onTranslate={
				quote
					? () => {
							const anchor: PdfAskAnchor = {
								page: action.pageIndex + 1,
								rects: action.rects,
								quote,
								trigger: "region",
							};
							closeLayoutElementAction();
							translateSelection(anchor);
						}
					: undefined
			}
			onCopy={
				quote
					? () =>
							copyTextToClipboard(quote, {
								errorMessage: t("selection.copyFailed"),
							})
					: undefined
			}
		/>,
		document.body,
	);
}
