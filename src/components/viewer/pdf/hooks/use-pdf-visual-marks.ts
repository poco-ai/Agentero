/**
 * Region-crop visual marks for the EmbedPDF viewer.
 *
 * Note-only marks live in the right-rail comment card column; marks that carry
 * an Agent conversation but no note use a floating conversation card beside
 * their gutter pin. The "add to sidebar chat" action lives on the comment card.
 * This hook updates comments on saved marks, deletes marks,
 * and adds existing marks to the Agent composer.
 *
 * Boundaries:
 * - the persisted mark array lives in {@link usePdfMarksIo}: setters and the
 *   mirror ref are injected, never re-declared here;
 * - comment-rail edits are owned by {@link usePdfNoteEditor}; this hook only
 *   supplies the visual-specific writers.
 */

import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
} from "react";
import { useTranslation } from "react-i18next";
import { presentAgentComposer } from "@/lib/agent/composer-focus";
import { addVisualDraft } from "@/lib/agent/visual-context-store";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import {
	deletePdfVisualTrace,
	type PdfVisualSessionTrace,
	writePdfVisualTrace,
} from "@/lib/pdf/agent-trace";
import { loadPdfVisualTraceImage } from "@/lib/pdf/agent-trace/image";

export type UsePdfVisualMarksOptions = {
	/** Sidecar root for `marks/<id>.json` (null for loose PDFs — nothing persists). */
	paperAbsPath: string | null;
	/** Vault-relative provenance for crops added to the composer. */
	paperRelPath: string | null;
	/** Persisted visual marks; owned by {@link usePdfMarksIo}. */
	visualTracesRef: RefObject<PdfVisualSessionTrace[]>;
	setVisualTraces: Dispatch<SetStateAction<PdfVisualSessionTrace[]>>;
	upsertVisualTrace: (trace: PdfVisualSessionTrace) => void;
};

export type PdfVisualMarks = {
	/** Persist a comment by mark id (comment-rail in-place edit). */
	updateVisualComment: (id: string, comment: string) => void;
	/** Add an existing visual mark's crop to the Agent sidebar composer (#396). */
	handleVisualAddToChatById: (id: string) => void;
	/** Drop a mark from state + disk (also used by the imperative handle). */
	deleteVisualTraceById: (id: string) => void;
};

export function usePdfVisualMarks({
	paperAbsPath,
	paperRelPath,
	visualTracesRef,
	setVisualTraces,
	upsertVisualTrace,
}: UsePdfVisualMarksOptions): PdfVisualMarks {
	const { t } = useTranslation("viewer");

	/** Persist a comment by mark id (rail in-place edit). */
	const updateVisualComment = useCallback(
		(id: string, comment: string) => {
			const latest = visualTracesRef.current.find((tr) => tr.id === id);
			if (!latest) return;
			const next: PdfVisualSessionTrace = {
				...latest,
				comment: comment.trim(),
				updatedAt: new Date().toISOString(),
			};
			// Keep content invariant: need comment, agent, or crop image.
			if (
				!next.comment &&
				!next.agent &&
				!next.image?.path &&
				!next.image?.data
			) {
				return;
			}
			upsertVisualTrace(next);
			if (paperAbsPath) {
				void writePdfVisualTrace(paperAbsPath, next).catch((error) => {
					console.warn("[visual-mark] update comment failed", error);
					notifyError(errorText(error));
				});
			}
		},
		[paperAbsPath, upsertVisualTrace, visualTracesRef],
	);

	/** Add an existing visual mark's crop to the Agent sidebar composer (#396). */
	const handleVisualAddToChatById = useCallback(
		(id: string) => {
			const latest = visualTracesRef.current.find((tr) => tr.id === id);
			if (!latest) return;
			void (async () => {
				const image = await loadPdfVisualTraceImage(
					paperAbsPath ?? "",
					latest.image,
				);
				if (!image?.data) {
					notifyError(t("pdfExplain.cropFailed"));
					return;
				}
				addVisualDraft({
					id: latest.id,
					paperPath:
						latest.paperPath || paperRelPath || paperAbsPath || "paper",
					paperAbsPath: paperAbsPath ?? undefined,
					page: latest.page,
					rects: latest.rects,
					comment: latest.comment,
					image: {
						data: image.data,
						mimeType: image.mimeType || "image/png",
					},
				});
				presentAgentComposer({ preserveCaret: true });
			})();
		},
		[paperAbsPath, paperRelPath, t, visualTracesRef],
	);

	const deleteVisualTraceById = useCallback(
		(id: string) => {
			setVisualTraces((prev) => prev.filter((tr) => tr.id !== id));
			if (paperAbsPath) void deletePdfVisualTrace(paperAbsPath, id);
		},
		[paperAbsPath, setVisualTraces],
	);

	return {
		updateVisualComment,
		handleVisualAddToChatById,
		deleteVisualTraceById,
	};
}
