import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { addSelectionToChat } from "@/components/selection/add-selection-to-chat";
import { SelectionMenu } from "@/components/viewer/pdf/cards/selection-menu";
import {
	anchorFromEmbedSelection,
	formattedSelectionPage,
	selectionBoundsOnScreen,
} from "@/components/viewer/pdf/coords";
import { isPdfDocumentCloseRaceError } from "@/components/viewer/pdf/host-dom";
import {
	closeLayoutElementAction,
	type LayoutElementAction,
	type LayoutElementScreen,
	layoutElementActionStore,
	moveLayoutElementAction,
} from "@/components/viewer/pdf/layout-element-action-store";
import { layoutSentenceLineRects } from "@/components/viewer/pdf/layout-sentence-hover";
import type { SelectionCommentDraft } from "@/components/viewer/pdf/types";
import type { PromptImage } from "@/lib/agent";
import { presentAgentComposer } from "@/lib/agent/composer-focus";
import {
	normalizeQuoteContext,
	quoteContextFromText,
} from "@/lib/agent/selection-context";
import {
	registerSelectionAddToChat,
	registerSelectionQuickChat,
} from "@/lib/agent/selection-quick-chat";
import { addVisualDraft } from "@/lib/agent/visual-context-store";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { notifyError } from "@/lib/core/notify";
import type { PdfAskAnchor, PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import type { HighlightColor } from "@/lib/pdf/highlight/palette";
import type { PdfTextMarkupKind } from "@/lib/pdf/highlight/types";
import {
	layoutDocumentKey,
	layoutElementNeedsCrop,
	layoutKindI18nKey,
	pointInBbox,
} from "@/lib/pdf/layout";
import { layoutAnalysisStore } from "@/lib/pdf/layout/store";

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

type LayoutElementActionsProps = {
	docId: string;
	docCap: DocumentManagerCapability;
	paperRelPath: string | null;
	paperAbsPath: string | null;
	captureRegion: (
		pageIndex: number,
		region: PdfAskNormalizedRect,
	) => Promise<PromptImage>;
	onHighlight: (
		pages: SelectionCommentDraft["pages"],
		color: HighlightColor,
		quote: string,
		shape: PdfTextMarkupKind,
	) => void;
	onNote: (draft: SelectionCommentDraft) => void;
	onAsk: (anchor: PdfAskAnchor) => void;
	onBookmark?: (page: number, title: string) => void;
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
	...props
}: LayoutElementActionsProps): ReactNode {
	const action = useStore(layoutElementActionStore, (state) =>
		state.action?.docId === docId ? state.action : null,
	);
	const actionOpen = Boolean(action);

	useEffect(() => {
		if (!actionOpen) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			if (layoutElementActionStore.getState().action?.docId !== docId) return;
			event.preventDefault();
			closeLayoutElementAction();
		};
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (target.closest("[data-selection-ui], [data-layout-element]")) {
				return;
			}
			if (layoutElementActionStore.getState().action?.docId === docId) {
				closeLayoutElementAction();
			}
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
	}, [actionOpen, docId]);

	if (!action || typeof document === "undefined") return null;

	return createPortal(
		<LayoutElementMenu
			key={`${action.pageIndex}:${action.regionId}:${action.quote}`}
			{...props}
			action={action}
		/>,
		document.body,
	);
}

function LayoutElementMenu({
	action,
	docCap,
	paperRelPath,
	paperAbsPath,
	captureRegion,
	onHighlight,
	onNote,
	onAsk,
	onBookmark,
	translateSelection,
}: Omit<LayoutElementActionsProps, "docId"> & { action: LayoutElementAction }) {
	const { t } = useTranslation("viewer");
	const { docId, pageIndex } = action;
	const kindLabel = t(layoutKindI18nKey(action.kind));
	const quote = action.quote.trim();
	const needsCrop = layoutElementNeedsCrop(action.kind) || !quote;
	const doc = docCap?.getDocument(docId);
	const sizeFor = (index: number) => doc?.pages[index]?.size ?? null;
	const members = action.sentence?.members;
	const pages = needsCrop
		? []
		: [
				...new Set([
					pageIndex,
					...(members?.map((member) => member.pageIndex) ?? []),
				]),
			].flatMap((index) => {
				const size = sizeFor(index);
				if (!size) return [];
				const glyphs = members
					? members
							.filter((member) => member.pageIndex === index)
							.flatMap((member) => member.rects)
					: layoutSentenceLineRects(docId, index).filter((rect) =>
							pointInBbox(
								rect.x + rect.w / 2,
								rect.y + rect.h / 2,
								action.bbox,
							),
						);
				return formattedSelectionPage(
					index,
					glyphs.length || index !== pageIndex ? glyphs : action.rects,
					size,
				);
			});
	const hasMarkup = pages.length > 0;
	const anchor: PdfAskAnchor = anchorFromEmbedSelection(
		pages,
		quote,
		sizeFor,
		"region",
		pageIndex,
	) ?? {
		page: pageIndex + 1,
		rects: action.rects,
		quote,
		trigger: "region",
	};

	const pinQuote = () => {
		if (!quote) return false;
		addSelectionToChat({
			text: quote,
			sourcePath: paperRelPath ?? paperAbsPath ?? "PDF",
			origin: "pdf",
			context: elementContext(action, kindLabel),
			page: anchor.page,
			rects: anchor.rects,
			paperAbsPath: paperAbsPath ?? undefined,
		});
		return true;
	};

	const addToChat = () => {
		closeLayoutElementAction();
		if (!needsCrop) {
			pinQuote();
			return;
		}
		void (async () => {
			let cropped = false;
			try {
				const image = await captureRegion(pageIndex, action.bbox);
				if (!docCap?.isDocumentOpen(docId)) return;
				addVisualDraft({
					id: `layout-el:${action.regionId}`,
					paperPath: paperRelPath || paperAbsPath || "paper",
					paperAbsPath: paperAbsPath ?? undefined,
					page: pageIndex + 1,
					rects: [action.bbox],
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

	const ask = () => {
		closeLayoutElementAction();
		onAsk(
			needsCrop
				? {
						...anchor,
						rects: [action.bbox],
						visualKind: action.kind === "formula" ? "formula" : "figure",
					}
				: anchor,
		);
	};

	useEffect(() => {
		const isCurrent = () =>
			layoutElementActionStore.getState().action === action;
		const unregisterAsk = registerSelectionQuickChat(() => {
			if (!isCurrent()) return false;
			ask();
			return true;
		});
		const unregisterChat = registerSelectionAddToChat(() => {
			if (!isCurrent()) return false;
			addToChat();
			return true;
		});
		return () => {
			unregisterAsk();
			unregisterChat();
		};
	});

	return (
		<SelectionMenu
			screen={action.screen}
			selectionText={quote}
			onAddToChat={addToChat}
			onAsk={ask}
			onHighlight={
				hasMarkup
					? (color, shape) => {
							onHighlight(pages, color, quote, shape);
							closeLayoutElementAction();
						}
					: undefined
			}
			onNote={
				needsCrop || hasMarkup
					? (shape) => {
							onNote({
								page: anchor.page,
								anchorY: anchor.rects[0]?.y ?? action.bbox.y,
								quote,
								shape,
								pages,
								visualRegion: needsCrop ? action.bbox : undefined,
								rects: needsCrop ? [action.bbox] : anchor.rects,
							});
							closeLayoutElementAction();
						}
					: undefined
			}
			onBookmark={
				onBookmark
					? () => {
							onBookmark(pageIndex + 1, quote || kindLabel);
							closeLayoutElementAction();
						}
					: undefined
			}
			onTranslate={
				quote
					? () => {
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
		/>
	);
}
