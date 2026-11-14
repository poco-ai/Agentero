/**
 * The 批注 note editor for a text highlight or visual note.
 *
 * Comments always edit in-place on the right-rail comment card (Notion-style).
 * The annotations panel and rail cards open it by annotation id, so it reads
 * the annotation straight from the plugin scope.
 */

import type { useAnnotationCapability } from "@embedpdf/plugin-annotation/react";
import { useCallback, useState } from "react";
import type {
	PageAnnotationComment,
	RailEditState,
} from "@/components/viewer/pdf/types";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask";
import {
	highlightColorOf,
	highlightQuoteOf,
	isLiveAnnotation,
	isTextMarkupObject,
	textMarkupKindOf,
} from "@/lib/pdf/highlight/annotation-store";

type AnnotationCapabilityProvides = ReturnType<
	typeof useAnnotationCapability
>["provides"];

export type UsePdfNoteEditorOptions = {
	docId: string;
	/** EmbedPDF capability; owned by `PdfViewerInner` (plugin context). */
	annotationCap: AnnotationCapabilityProvides;
	/** Normalized Y of a highlight (0–1) for a pending rail card. */
	anchorYForHighlight: (id: string) => number;
	/** Normalized rects of a highlight for hover emphasis; empty when unknown. */
	rectsForHighlight: (id: string) => PdfAskNormalizedRect[];
	/** Highlights cluster writers. */
	updateHighlightComment: (
		pageIndex: number,
		id: string,
		comment: string,
	) => void;
	deleteHighlightAnnotation: (pageIndex: number, id: string) => void;
	/** Visual-mark comment writer / deleter (rail cards). */
	updateVisualComment: (id: string, comment: string) => void;
	deleteVisualTraceById: (id: string) => void;
};

export type PdfNoteEditor = {
	/** In-place rail edit; null when idle. */
	railEdit: RailEditState | null;
	/** Open the rail editor (new note from the selection menu, or a rail card). */
	beginRailEdit: (state: RailEditState) => void;
	/** Open for an existing highlight. */
	openEditorForAnnotation: (id: string) => void;
	closeRailEdit: () => void;
	saveRailEdit: (comment: PageAnnotationComment, text: string) => void;
	/** Delete a highlight / visual note from its comment-rail card. */
	deleteRailComment: (comment: PageAnnotationComment) => void;
};

export function usePdfNoteEditor({
	docId,
	annotationCap,
	anchorYForHighlight,
	rectsForHighlight,
	updateHighlightComment,
	deleteHighlightAnnotation,
	updateVisualComment,
	deleteVisualTraceById,
}: UsePdfNoteEditorOptions): PdfNoteEditor {
	const [railEdit, setRailEdit] = useState<RailEditState | null>(null);

	const beginRailEdit = useCallback((state: RailEditState) => {
		setRailEdit((current) => (current?.id === state.id ? current : state));
	}, []);

	const closeRailEdit = useCallback(() => {
		setRailEdit((current) => {
			if (current?.isNew) {
				if (current.kind === "visual") {
					deleteVisualTraceById(current.id);
				} else {
					deleteHighlightAnnotation(current.pageIndex, current.id);
				}
			}
			return null;
		});
	}, [deleteHighlightAnnotation, deleteVisualTraceById]);

	const openEditorForAnnotation = useCallback(
		(id: string) => {
			const tracked = annotationCap?.forDocument(docId).getAnnotationById(id);
			if (!tracked || !isLiveAnnotation(tracked)) return;
			const obj = tracked.object;
			if (!isTextMarkupObject(obj)) return;
			beginRailEdit({
				id,
				pageIndex: obj.pageIndex,
				kind: "highlight",
				comment: obj.contents?.trim() ?? "",
				quote: highlightQuoteOf(obj),
				color: highlightColorOf(obj),
				shape: textMarkupKindOf(obj),
				anchorY: anchorYForHighlight(id),
				rects: rectsForHighlight(id),
			});
		},
		[
			annotationCap,
			docId,
			beginRailEdit,
			anchorYForHighlight,
			rectsForHighlight,
		],
	);

	const saveRailEdit = useCallback(
		(comment: PageAnnotationComment, text: string) => {
			const trimmed = text.trim();
			if (comment.isNew && !trimmed) {
				if (comment.kind === "visual") {
					deleteVisualTraceById(comment.id);
				} else {
					deleteHighlightAnnotation(comment.pageIndex, comment.id);
				}
			} else {
				if (comment.kind === "visual") {
					updateVisualComment(comment.id, trimmed);
				} else {
					updateHighlightComment(comment.pageIndex, comment.id, trimmed);
				}
			}
			setRailEdit((current) => (current?.id === comment.id ? null : current));
		},
		[
			updateHighlightComment,
			updateVisualComment,
			deleteHighlightAnnotation,
			deleteVisualTraceById,
		],
	);

	const deleteRailComment = useCallback(
		(comment: PageAnnotationComment) => {
			if (comment.kind === "visual") {
				deleteVisualTraceById(comment.id);
			} else {
				deleteHighlightAnnotation(comment.pageIndex, comment.id);
			}
			setRailEdit((current) => (current?.id === comment.id ? null : current));
		},
		[deleteHighlightAnnotation, deleteVisualTraceById],
	);

	return {
		railEdit,
		beginRailEdit,
		openEditorForAnnotation,
		closeRailEdit,
		saveRailEdit,
		deleteRailComment,
	};
}

export function railEditFromComment(
	comment: PageAnnotationComment,
): RailEditState {
	return {
		id: comment.id,
		pageIndex: comment.pageIndex,
		kind: comment.kind,
		comment: comment.comment,
		quote: comment.quote,
		color: comment.color,
		shape: comment.shape,
		anchorY: comment.anchorY,
		rects: comment.rects,
		isNew: comment.isNew,
	};
}
