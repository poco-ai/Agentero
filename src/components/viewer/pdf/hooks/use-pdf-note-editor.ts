/**
 * The 批注 note editor for a text highlight.
 *
 * Small but its own hook because it is the one card that is not opened by the
 * cards cluster: the annotations panel and a gutter pin both open it by
 * annotation id, so it reads the annotation straight from the plugin scope and
 * claims the shared hover surface so a pin leave cannot close it mid-edit.
 */

import type { useAnnotationCapability } from "@embedpdf/plugin-annotation/react";
import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useState,
} from "react";
import { pageElByIndex, rectRightScreen } from "@/components/viewer/pdf/coords";
import type { EditorState } from "@/components/viewer/pdf/types";
import { isHighlightObject } from "@/lib/pdf/highlight/annotation-store";

type AnnotationCapabilityProvides = ReturnType<
	typeof useAnnotationCapability
>["provides"];

export type UsePdfNoteEditorOptions = {
	docId: string;
	/** EmbedPDF capability; owned by `PdfViewerInner` (plugin context). */
	annotationCap: AnnotationCapabilityProvides;
	hostRef: RefObject<HTMLDivElement | null>;
	zoomRef: RefObject<number>;
	/** Cards cluster: opening claims the hover surface, like `openCard` does. */
	cancelHoverHide: () => void;
	cardHoverSurfaceRef: RefObject<boolean>;
	/** Highlights cluster writers. */
	updateHighlightComment: (
		pageIndex: number,
		id: string,
		comment: string,
	) => void;
	deleteHighlightAnnotation: (pageIndex: number, id: string) => void;
};

export type PdfNoteEditor = {
	editor: EditorState | null;
	/** Open for a highlight that was just created from the selection menu. */
	setEditor: Dispatch<SetStateAction<EditorState | null>>;
	/** Open for an existing highlight (annotations panel row or gutter pin). */
	openEditorForAnnotation: (id: string) => void;
	closeEditor: () => void;
	saveEditor: (text: string) => void;
	/** Header delete: remove the highlight and close. */
	deleteEditorAnnotation: () => void;
};

export function usePdfNoteEditor({
	docId,
	annotationCap,
	hostRef,
	zoomRef,
	cancelHoverHide,
	cardHoverSurfaceRef,
	updateHighlightComment,
	deleteHighlightAnnotation,
}: UsePdfNoteEditorOptions): PdfNoteEditor {
	const [editor, setEditor] = useState<EditorState | null>(null);

	const openEditorForAnnotation = useCallback(
		(id: string) => {
			const obj = annotationCap
				?.forDocument(docId)
				.getAnnotationById(id)?.object;
			if (!obj || !isHighlightObject(obj)) return;
			const pageEl = pageElByIndex(hostRef.current, obj.pageIndex);
			if (!pageEl) return;
			// Same sticky-hover contract as openCard — pin leave must not close
			// the note editor while the user is moving onto / into the modal.
			cancelHoverHide();
			cardHoverSurfaceRef.current = true;
			setEditor({
				screen: rectRightScreen(pageEl, obj.rect, zoomRef.current),
				pageIndex: obj.pageIndex,
				id,
				comment: obj.contents?.trim() ?? "",
			});
		},
		[
			annotationCap,
			docId,
			cancelHoverHide,
			cardHoverSurfaceRef,
			hostRef,
			zoomRef,
		],
	);

	const closeEditor = useCallback(() => setEditor(null), []);

	const saveEditor = useCallback(
		(text: string) => {
			if (!editor) return;
			updateHighlightComment(editor.pageIndex, editor.id, text);
			setEditor(null);
		},
		[editor, updateHighlightComment],
	);

	const deleteEditorAnnotation = useCallback(() => {
		if (!editor) return;
		deleteHighlightAnnotation(editor.pageIndex, editor.id);
		setEditor(null);
	}, [editor, deleteHighlightAnnotation]);

	return {
		editor,
		setEditor,
		openEditorForAnnotation,
		closeEditor,
		saveEditor,
		deleteEditorAnnotation,
	};
}
