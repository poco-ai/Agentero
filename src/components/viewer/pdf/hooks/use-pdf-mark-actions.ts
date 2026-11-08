/**
 * Mark-open and highlight-annotation actions for the page layers.
 *
 * `handleOpenPin` re-opens whatever a gutter pin points at (ask thread /
 * translate card / highlight editor / visual mark card); the other three wire
 * the in-PDF highlight annotation menu (edit note / delete / recolor) to the
 * highlights cluster.
 */

import type { useAnnotationCapability } from "@embedpdf/plugin-annotation/react";
import { type RefObject, useCallback } from "react";
import type { RailEditState } from "@/components/viewer/pdf/types";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import { isVisualMarkKind } from "@/lib/pdf/agent-trace";
import type { PdfAskThread } from "@/lib/pdf/ask/types";
import {
	DEFAULT_HIGHLIGHT_COLOR,
	type HighlightColor,
} from "@/lib/pdf/highlight/palette";
import type { ActiveSelectionCard, SelectionPin } from "@/lib/pdf/selection";

type AnnotationCapabilityProvides = ReturnType<
	typeof useAnnotationCapability
>["provides"];

export type UsePdfMarkActionsOptions = {
	activeCardRef: RefObject<ActiveSelectionCard | null>;
	/** Marks-io mirrors; pin opens read the latest records. */
	threadsRef: RefObject<PdfAskThread[]>;
	visualTracesRef: RefObject<PdfVisualSessionTrace[]>;
	upsertThread: (thread: PdfAskThread) => void;
	/** Ask cluster: re-open a pin's thread. */
	openThread: (thread: PdfAskThread) => void;
	/** Cards cluster: open a translate / visual card beside its mark. */
	openCard: (card: ActiveSelectionCard) => void;
	/** Note editor: open the rail edit of a highlight pin. */
	openEditorForAnnotation: (id: string) => void;
	/** Note editor: open the rail edit of a visual pin (#396). */
	beginRailEdit: (state: RailEditState) => void;
	/** EmbedPDF capability; owned by `PdfViewerInner` (plugin context). */
	annotationCap: AnnotationCapabilityProvides;
	docId: string;
	/** Highlights cluster writers. */
	deleteHighlightAnnotation: (pageIndex: number, id: string) => void;
	updateHighlightColor: (
		pageIndex: number,
		id: string,
		color: HighlightColor,
	) => void;
};

export type PdfMarkActions = {
	handleOpenPin: (pin: SelectionPin, preview?: boolean) => void;
	handleEditHighlightAnnotation: (id: string) => void;
	handleDeleteHighlightAnnotation: (pageIndex: number, id: string) => void;
	handleChangeHighlightColor: (
		pageIndex: number,
		id: string,
		color: HighlightColor,
	) => void;
};

export function usePdfMarkActions({
	activeCardRef,
	threadsRef,
	visualTracesRef,
	upsertThread,
	openThread,
	openCard,
	openEditorForAnnotation,
	beginRailEdit,
	annotationCap,
	docId,
	deleteHighlightAnnotation,
	updateHighlightColor,
}: UsePdfMarkActionsOptions): PdfMarkActions {
	const handleOpenPin = useCallback(
		(pin: SelectionPin, preview = false) => {
			// A pin can pass under a stationary pointer while the reader scrolls.
			if (preview && activeCardRef.current?.kind === "translate") return;
			if (pin.kind === "ask") {
				const thread = threadsRef.current.find((th) => th.id === pin.id);
				if (!thread) return;
				const open: PdfAskThread = { ...thread, status: "open" };
				upsertThread(open);
				openThread(open);
				return;
			}
			if (pin.kind === "translate") openCard({ kind: "translate", id: pin.id });
			if (pin.kind === "annotate") openEditorForAnnotation(pin.id);
			if (isVisualMarkKind(pin.kind)) {
				const markId = pin.traceId || pin.id;
				const tr = visualTracesRef.current.find((item) => item.id === markId);
				if (!tr) return;
				const hasComment = tr.comment.trim().length > 0;
				const hasAgent = Boolean(tr.agent);
				// Marks with a comment open the rail editor. Marks that only carry
				// an Agent conversation open it in a floating card beside the pin.
				if (!hasComment && hasAgent) {
					openCard({ kind: "visual", id: tr.id });
					return;
				}
				const state: RailEditState = {
					id: tr.id,
					pageIndex: tr.page - 1,
					kind: "visual",
					comment: tr.comment,
					quote: "",
					color: DEFAULT_HIGHLIGHT_COLOR,
					anchorY: tr.rects[0]?.y ?? 0,
					rects: tr.rects,
				};
				beginRailEdit(state);
			}
		},
		[
			activeCardRef,
			upsertThread,
			openThread,
			openCard,
			openEditorForAnnotation,
			beginRailEdit,
			threadsRef,
			visualTracesRef,
		],
	);

	const handleEditHighlightAnnotation = useCallback(
		(id: string) => {
			annotationCap?.forDocument(docId).deselectAnnotation();
			openEditorForAnnotation(id);
		},
		[annotationCap, docId, openEditorForAnnotation],
	);

	const handleDeleteHighlightAnnotation = useCallback(
		(pageIndex: number, id: string) => {
			deleteHighlightAnnotation(pageIndex, id);
		},
		[deleteHighlightAnnotation],
	);

	const handleChangeHighlightColor = useCallback(
		(pageIndex: number, id: string, color: HighlightColor) => {
			updateHighlightColor(pageIndex, id, color);
		},
		[updateHighlightColor],
	);

	return {
		handleOpenPin,
		handleEditHighlightAnnotation,
		handleDeleteHighlightAnnotation,
		handleChangeHighlightColor,
	};
}
