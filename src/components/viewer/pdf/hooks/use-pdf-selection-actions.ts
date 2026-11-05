import {
	normalizeQuoteContext,
	quoteContextFromText,
} from "@/lib/agent/selection-context";
import { layoutAnalysisStore } from "@/lib/pdf/layout/store";
/**
 * Selection actions (highlight / note / copy / ask / add-to-chat / translate).
 *
 * The floating toolbar opens actions; notes are edited in the right rail.
 * Copy leaves the toolbar open.
 * Detection and menu state stay in {@link usePdfTextSelection}; each action's
 * real work belongs to its own cluster.
 */

import type { FormattedSelection } from "@embedpdf/plugin-selection/react";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSelectionQuickChat } from "@/components/selection/use-selection-quick-chat";
import type { SelectionMenuState } from "@/components/viewer/pdf/types";
import { annotationPdfAnchors } from "@/lib/agent/selection-annotations";
import {
	openSelectionChat,
	selectionChatStore,
} from "@/lib/agent/selection-chat-store";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import type { PdfAskAnchor } from "@/lib/pdf/ask/types";
import {
	DEFAULT_HIGHLIGHT_COLOR,
	type HighlightColor,
} from "@/lib/pdf/highlight/palette";
import type { VisibleSelectionPage } from "@/lib/pdf/layout/visible-selection-rects";

export type UsePdfSelectionActionsOptions = {
	/** Placed menu; every action no-ops when null. */
	selectionMenu: SelectionMenuState | null;
	closeSelectionMenu: () => void;
	/** Highlights cluster writer. */
	createHighlights: (
		pages: FormattedSelection[],
		color: HighlightColor,
		quote: string,
		translatedPages?: readonly VisibleSelectionPage[],
	) => { pageIndex: number; id: string }[];
	/** Write the note body onto a freshly created highlight. */
	updateHighlightComment: (
		pageIndex: number,
		id: string,
		comment: string,
	) => void;
	docId: string;
	/** Ask cluster entry (creates an empty thread from the anchor). */
	startFromAnchor: (anchor: PdfAskAnchor, translation?: string) => void;
	/** Translate cluster entry (creates the record and starts the run). */
	translateSelection: (anchor: PdfAskAnchor) => void;
	paperRelPath: string | null;
	paperAbsPath: string | null;
};

export type PdfSelectionActions = {
	handleHighlight: (color: HighlightColor) => void;
	/**
	 * Create a highlight + comment from a snapped selection draft. Used by the
	 * right-rail editor so typing can survive EmbedPDF clearing the live selection.
	 */
	handleCommitSelectionNote: (
		draft: {
			pages: FormattedSelection[];
			quote: string;
			visiblePages?: readonly VisibleSelectionPage[];
		},
		comment: string,
	) => void;
	handleMenuAsk: () => void;
	handleMenuAddToChat: () => void;
	handleMenuTranslate: () => void;
	/** Copies without a success toast. False when there is nothing to copy or the write fails. */
	handleMenuCopy: () => Promise<boolean>;
};

export function usePdfSelectionActions({
	selectionMenu,
	closeSelectionMenu,
	createHighlights,
	updateHighlightComment,
	docId,
	startFromAnchor,
	translateSelection,
	paperRelPath,
	paperAbsPath,
}: UsePdfSelectionActionsOptions): PdfSelectionActions {
	// The right-rail note editor lives inside the page DOM. EmbedPDF often
	// clears the live selection on pointerdown before React re-renders, so
	// action handlers read this snapshot instead of the possibly-null state.
	const { t } = useTranslation("viewer");
	const selectionMenuRef = useRef(selectionMenu);
	selectionMenuRef.current = selectionMenu;

	const handleHighlight = useCallback(
		(color: HighlightColor) => {
			const menu = selectionMenuRef.current;
			// A translation selection is recovered English plus a page-fraction
			// band. Storing that as a highlight lands in the wrong place once
			// the overlay is cleared.
			if (!menu || menu.fromTranslation) return;
			createHighlights(
				menu.pages,
				color,
				menu.anchor.quote ?? "",
				menu.visiblePages,
			);
			closeSelectionMenu();
		},
		[createHighlights, closeSelectionMenu],
	);

	const handleCommitSelectionNote = useCallback(
		(
			draft: {
				pages: FormattedSelection[];
				quote: string;
				visiblePages?: readonly VisibleSelectionPage[];
			},
			comment: string,
		) => {
			const trimmed = comment.trim();
			if (!trimmed || !draft.pages.length) return;
			const created = createHighlights(
				draft.pages,
				DEFAULT_HIGHLIGHT_COLOR,
				draft.quote,
				draft.visiblePages,
			);
			const first = created[0];
			closeSelectionMenu();
			if (!first) return;
			updateHighlightComment(first.pageIndex, first.id, trimmed);
		},
		[createHighlights, updateHighlightComment, closeSelectionMenu],
	);

	const handleMenuAsk = useCallback(() => {
		const menu = selectionMenuRef.current;
		if (!menu) return;
		const translatedRects = menu.visiblePages?.find(
			(page) => page.pageIndex === menu.anchor.page - 1,
		)?.rects;
		const anchor =
			translatedRects && translatedRects.length > 0
				? { ...menu.anchor, translatedRects }
				: menu.anchor;
		const translation = menu.pairedTranslation;
		closeSelectionMenu();
		startFromAnchor(anchor, translation);
	}, [startFromAnchor, closeSelectionMenu]);

	// ⌘K Quick chat — only while this viewer's selection toolbar is armed.
	useSelectionQuickChat(() => selectionMenuRef.current != null, handleMenuAsk);

	const handleMenuAddToChat = useCallback(() => {
		const menu = selectionMenuRef.current;
		if (!menu) return;
		const anchor = menu.anchor;
		const quote = anchor.quote?.trim();
		const paired = menu.pairedTranslation;
		closeSelectionMenu();
		if (!quote) return;
		const regions =
			layoutAnalysisStore.getState().byDocument[docId]?.regions ?? [];
		const matches = regions.filter(
			(region) =>
				region.pageIndex === anchor.page - 1 && region.text?.includes(quote),
		);
		const regionContext =
			matches.length === 1
				? quoteContextFromText(matches[0]?.text ?? "", quote)
				: { status: "unavailable" as const };
		const context = paired
			? normalizeQuoteContext({ ...regionContext, translation: paired })
			: regionContext;
		// Keep a draft after clear: typing a comment must not depend on live selection.
		// Keep page geometry so the next Agent turn can write a conversation card pin.
		openSelectionChat(
			{
				text: quote,
				sourcePath: paperRelPath ?? paperAbsPath ?? "PDF",
				origin: "pdf",
				context,
				page: anchor.page,
				rects: anchor.rects,
				paperAbsPath: paperAbsPath ?? undefined,
			},
			menu.screen,
		);
		const id = selectionChatStore.getState().draft?.selection.id;
		const rect = menu.anchor.rects?.at(-1);
		if (id && rect)
			annotationPdfAnchors.set(id, {
				documentId: docId,
				page: menu.anchor.page,
				rect: { ...rect },
			});
	}, [closeSelectionMenu, docId, paperRelPath, paperAbsPath]);

	const handleMenuTranslate = useCallback(() => {
		const menu = selectionMenuRef.current;
		if (!menu || menu.fromTranslation) return;
		const anchor = menu.anchor;
		closeSelectionMenu();
		translateSelection(anchor);
	}, [closeSelectionMenu, translateSelection]);

	const handleMenuCopy = useCallback(async () => {
		const menu = selectionMenuRef.current;
		if (!menu) return false;
		const quote = (menu.copyText ?? menu.anchor.quote)?.trim();
		if (!quote) return false;
		// Leave the toolbar and the PDFium selection in place. The button
		// swaps to a check; do not toast success or clear the selection.
		return copyTextToClipboard(quote, {
			errorMessage: t("selection.copyFailed"),
		});
	}, [t]);

	return {
		handleHighlight,
		handleCommitSelectionNote,
		handleMenuAsk,
		handleMenuAddToChat,
		handleMenuTranslate,
		handleMenuCopy,
	};
}
