import type { PdfEngine } from "@embedpdf/models";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	createSelectionAskThread,
	useSelectionAsk,
} from "@/components/selection/use-selection-ask";
import { useSelectionTranslation } from "@/components/selection/use-selection-translation";
import type { PdfHighlights } from "@/components/viewer/pdf/hooks/use-pdf-highlights";
import { usePdfSelectionActions } from "@/components/viewer/pdf/hooks/use-pdf-selection-actions";
import { usePdfTextSelection } from "@/components/viewer/pdf/hooks/use-pdf-text-selection";
import { usePdfTranslationSelection } from "@/components/viewer/pdf/hooks/use-pdf-translation-selection";
import type {
	ScreenPoint,
	SelectionCommentDraft,
} from "@/components/viewer/pdf/types";
import { pdfAskContextRequest } from "@/lib/agent/context-request";
import { createSelectionContext } from "@/lib/agent/selection-store";
import {
	buildPdfAskPrompt,
	rememberPairedAskTranslation,
} from "@/lib/pdf/ask/prompt";
import type { PdfAskAnchor } from "@/lib/pdf/ask/types";
import type { PdfTextMarkupKind } from "@/lib/pdf/highlight/types";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";

type DocumentCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

/** Native translated selection, using the reader's existing menu and annotation actions. */
export function usePdfCompanionSelection({
	docId,
	hostRef,
	zoomRef,
	engineRef,
	docCapRef,
	enabled,
	isActive,
	itemsByPage,
	paperRelPath,
	paperAbsPath,
	highlights,
}: {
	docId: string;
	hostRef: RefObject<HTMLDivElement | null>;
	zoomRef: RefObject<number>;
	engineRef: RefObject<PdfEngine | null>;
	docCapRef: RefObject<DocumentCapability>;
	enabled: boolean;
	isActive: boolean;
	itemsByPage: ReadonlyMap<number, readonly LayoutTranslateItem[]>;
	paperRelPath: string | null;
	paperAbsPath: string | null;
	highlights: PdfHighlights;
}) {
	const [noteDraft, setNoteDraft] = useState<SelectionCommentDraft | null>(
		null,
	);
	const selection = usePdfTextSelection({
		selectionCap: null,
		docCap: docCapRef.current,
		docId,
		hostRef,
		zoomRef,
		isActive,
		sideBySide: true,
		paperRelPath,
		paperAbsPath,
	});
	usePdfTranslationSelection({
		...selection,
		docId,
		hostRef,
		zoomRef,
		engineRef,
		docCapRef,
		enabled,
		itemsByPage,
		paperRelPath,
		paperAbsPath,
	});
	const activeSessionRef = useRef<string | null>(null);
	const ask = useSelectionAsk<ScreenPoint>({
		activeSessionRef,
		buildPrompt: buildPdfAskPrompt,
		context: pdfAskContextRequest,
	});
	const translation = useSelectionTranslation();
	const { selectionMenu, closeSelectionMenu } = selection;
	const startFromAnchor = useCallback(
		(anchor: PdfAskAnchor, paired?: string) => {
			if (!selectionMenu) return;
			const thread = createSelectionAskThread(
				paperRelPath ?? paperAbsPath ?? "PDF",
				anchor.quote ?? "",
			);
			thread.anchor = anchor;
			rememberPairedAskTranslation(thread.id, paired ?? "");
			translation.close();
			ask.setAsk({ thread, screen: selectionMenu.screen });
		},
		[selectionMenu, paperRelPath, paperAbsPath, translation.close, ask.setAsk],
	);
	const actions = usePdfSelectionActions({
		...selection,
		...highlights,
		docId,
		paperRelPath,
		paperAbsPath,
		startFromAnchor,
		translateSelection: () => {},
	});
	const translateSelection = useCallback(() => {
		if (!selectionMenu) return;
		const context = createSelectionContext({
			text: selectionMenu.copyText ?? selectionMenu.anchor.quote ?? "",
			sourcePath: paperRelPath ?? paperAbsPath ?? "PDF",
			origin: "pdf",
			page: selectionMenu.anchor.page,
			rects: selectionMenu.anchor.rects,
			paperAbsPath: paperAbsPath ?? undefined,
		});
		if (!context) return;
		ask.hideAsk();
		translation.translate(context, selectionMenu.screen);
		closeSelectionMenu();
	}, [
		selectionMenu,
		paperRelPath,
		paperAbsPath,
		ask.hideAsk,
		translation.translate,
		closeSelectionMenu,
	]);
	const openNote = useCallback(
		(shape: PdfTextMarkupKind) => {
			if (!selectionMenu?.pages.length) return;
			const visible = selectionMenu.visiblePages?.find(
				(page) => page.pageIndex === selectionMenu.anchor.page - 1,
			);
			setNoteDraft({
				page: selectionMenu.anchor.page,
				anchorY: visible?.rects[0]?.y ?? 0,
				quote: selectionMenu.anchor.quote ?? "",
				shape,
				pages: selectionMenu.pages,
				visiblePages: selectionMenu.visiblePages,
			});
			closeSelectionMenu();
		},
		[selectionMenu, closeSelectionMenu],
	);
	const dismissNote = useCallback(() => setNoteDraft(null), []);
	const commitNote = useCallback(
		(comment: string) => {
			if (noteDraft) actions.handleCommitSelectionNote(noteDraft, comment);
			setNoteDraft(null);
		},
		[noteDraft, actions.handleCommitSelectionNote],
	);
	const zoom = zoomRef.current;
	useEffect(() => {
		if (zoom > 0) selection.rePlaceSelectionMenu();
	}, [zoom, selection.rePlaceSelectionMenu]);
	useEffect(() => {
		if (selectionMenu) setNoteDraft(null);
	}, [selectionMenu]);

	useEffect(() => {
		if (isActive && enabled) return;
		ask.hideAsk();
		translation.close();
		setNoteDraft(null);
	}, [isActive, enabled, ask.hideAsk, translation.close]);
	return {
		...selection,
		actions,
		ask,
		translation,
		translateSelection,
		noteDraft,
		openNote,
		dismissNote,
		commitNote,
	};
}
