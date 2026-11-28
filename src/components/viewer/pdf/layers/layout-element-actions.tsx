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
	anchorLayoutElementAction,
	closeLayoutElementAction,
	type LayoutElementAction,
	type LayoutElementActionMember,
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
import type { VisibleSelectionPage } from "@/lib/pdf/layout/visible-selection-rects";
import { unionNormalizedRegions } from "@/lib/pdf/region";

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
		translatedPages?: readonly VisibleSelectionPage[],
	) => void;
	onNote: (draft: SelectionCommentDraft) => void;
	onAsk: (anchor: PdfAskAnchor) => void;
	onBookmark?: (page: number, title: string) => void;
	translateSelection: (anchor: PdfAskAnchor) => void;
};

function elementContext(
	docId: string,
	member: LayoutElementActionMember,
	heading: string,
) {
	const regions =
		member.source === "element"
			? (layoutAnalysisStore.getState().byDocument[layoutDocumentKey(docId)]
					?.regions ?? [])
			: [];
	const region = regions.find((item) => item.id === member.regionId);
	const located =
		region?.text && member.quote
			? quoteContextFromText(region.text, member.quote)
			: { status: "unavailable" as const };
	if (located.status === "available") {
		return normalizeQuoteContext({ ...located, heading });
	}
	return normalizeQuoteContext({ status: "available", heading });
}

function placeAction(action: LayoutElementAction): LayoutElementScreen | null {
	const anchor = anchorLayoutElementAction(action);
	const page = document.querySelector<HTMLElement>(
		`[data-annotation-pdf="${CSS.escape(action.docId)}"][data-embed-pdf-page="${action.pageIndex}"]`,
	);
	if (!page) return null;
	const bounds = selectionBoundsOnScreen(
		page,
		anchor.visibleRects ?? anchor.rects,
	);
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
			if (
				target.closest(
					"[data-selection-ui], [data-layout-element], [data-layout-element-selection]",
				)
			) {
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
			key={`${action.pageIndex}:${action.anchorId}:${action.members.length}`}
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
	const actionAnchor = anchorLayoutElementAction(action);
	const labelForMember = (member: LayoutElementActionMember) => {
		if (member.kind === "region") return t("figures.kindRegion");
		if (member.sentence) return t("figures.kindSentence");
		return t(layoutKindI18nKey(member.kind));
	};
	const kindLabel =
		action.members.length > 1
			? t("figures.selectedElements", { count: action.members.length })
			: labelForMember(actionAnchor);
	const textMembers: LayoutElementActionMember[] = [];
	const visualMembers: LayoutElementActionMember[] = [];
	for (const member of action.members) {
		if (
			member.kind === "region" ||
			layoutElementNeedsCrop(member.kind) ||
			!member.quote.trim()
		) {
			visualMembers.push(member);
		} else {
			textMembers.push(member);
		}
	}
	const needsCrop = visualMembers.length > 0;
	const quote = textMembers.map((member) => member.quote.trim()).join("\n\n");
	const doc = docCap?.getDocument(docId);
	const sizeFor = (index: number) => doc?.pages[index]?.size ?? null;
	const textRects = textMembers.flatMap((member) => member.rects);
	const size = sizeFor(pageIndex);
	const glyphs =
		!needsCrop && size
			? textMembers.flatMap((member) =>
					member.sentence
						? member.sentence.members
								.filter((item) => item.pageIndex === pageIndex)
								.flatMap((item) => item.rects)
						: layoutSentenceLineRects(docId, pageIndex).filter((rect) =>
								pointInBbox(
									rect.x + rect.w / 2,
									rect.y + rect.h / 2,
									member.bbox,
								),
							),
				)
			: [];
	const pages =
		needsCrop || !size
			? []
			: formattedSelectionPage(
					pageIndex,
					glyphs.length ? glyphs : textRects,
					size,
				);
	const hasMarkup = pages.length > 0;
	const visibleRects = textMembers.flatMap(
		(member) => member.visibleRects ?? [],
	);
	const visiblePages = visibleRects.length
		? [{ pageIndex, rects: visibleRects }]
		: undefined;
	const anchor: PdfAskAnchor = anchorFromEmbedSelection(
		pages,
		quote,
		sizeFor,
		"region",
		pageIndex,
	) ?? {
		page: pageIndex + 1,
		rects: textRects.length ? textRects : actionAnchor.rects,
		quote,
		trigger: "region",
	};

	const pinQuote = () => {
		if (!quote) return false;
		addSelectionToChat({
			text: quote,
			sourcePath: paperRelPath ?? paperAbsPath ?? "PDF",
			origin: "pdf",
			context: elementContext(docId, actionAnchor, kindLabel),
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
			let cropError: unknown = null;
			for (const member of visualMembers) {
				try {
					const image = await captureRegion(member.pageIndex, member.bbox);
					if (!docCap?.isDocumentOpen(docId)) return;
					addVisualDraft({
						id: `layout-el:${member.id}`,
						paperPath: paperRelPath || paperAbsPath || "paper",
						paperAbsPath: paperAbsPath ?? undefined,
						page: member.pageIndex + 1,
						rects: [member.bbox],
						comment: labelForMember(member),
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
					cropError = error;
				}
			}
			if (!cropped && !quote) {
				const message =
					cropError instanceof Error
						? cropError.message
						: t("pdfExplain.cropFailed");
				notifyError(t("pdfExplain.cropFailed"), { description: message });
				return;
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
						rects: [
							unionNormalizedRegions([actionAnchor.bbox]) ?? actionAnchor.bbox,
						],
						visualKind: actionAnchor.kind === "formula" ? "formula" : "figure",
					}
				: anchor,
		);
	};

	useEffect(() => {
		const isCurrent = () =>
			layoutElementActionStore.getState().action === action;
		const unregisterAsk = registerSelectionQuickChat(() => {
			if (!isCurrent() || action.members.length !== 1) return false;
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
			onAsk={action.members.length === 1 ? ask : undefined}
			onHighlight={
				hasMarkup
					? (color, shape) => {
							onHighlight(pages, color, quote, shape, visiblePages);
							closeLayoutElementAction();
						}
					: undefined
			}
			onNote={
				needsCrop || hasMarkup
					? (shape) => {
							const noteRects = needsCrop
								? action.members.flatMap((member) => member.rects)
								: textRects;
							const visualRegion = needsCrop
								? (unionNormalizedRegions(noteRects) ??
									unionNormalizedRegions(
										action.members.map((member) => member.bbox),
									) ??
									actionAnchor.bbox)
								: undefined;
							onNote({
								page: anchor.page,
								anchorY: noteRects.length
									? Math.min(...noteRects.map((rect) => rect.y))
									: actionAnchor.bbox.y,
								quote,
								shape,
								pages,
								visiblePages: needsCrop ? undefined : visiblePages,
								visualRegion,
								visualElements: needsCrop
									? action.members.map((member) => ({
											kind: member.kind,
											...(member.quote.trim()
												? { quote: member.quote.trim() }
												: {}),
										}))
									: undefined,
								rects: noteRects,
							});
							closeLayoutElementAction();
						}
					: undefined
			}
			onBookmark={
				onBookmark && action.members.length === 1
					? () => {
							onBookmark(pageIndex + 1, quote || kindLabel);
							closeLayoutElementAction();
						}
					: undefined
			}
			onTranslate={
				!needsCrop && quote
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
