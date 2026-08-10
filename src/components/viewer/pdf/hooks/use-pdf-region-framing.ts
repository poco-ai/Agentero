/**
 * Region framing (⌘. marquee) and the crop that turns a framed region into a
 * draft card.
 *
 * Split from {@link usePdfVisualMarks} because it is a different lifecycle: an
 * armed input mode plus one in-flight PDFium crop, with no knowledge of marks,
 * agents or persistence. It produces a draft and hands it to
 * {@link usePdfLayoutHover}, which owns the draft state so its exclusivity with
 * the formula glossary card stays in one place.
 *
 * The two mirrors it writes (`regionSelectingRef`, `visualCropPendingRef`) are
 * created by the parent because the layout-hover guard reads the same ref
 * objects and is declared first.
 */

import type { PdfEngine } from "@embedpdf/models";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import type { useInteractionManagerCapability } from "@embedpdf/plugin-interaction-manager/react";
import type { useSelectionCapability } from "@embedpdf/plugin-selection/react";
import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { isPdfDocumentCloseRaceError } from "@/components/viewer/pdf/host-dom";
import { renderPdfRegionPromptImage } from "@/components/viewer/pdf/region-crop";
import type {
	ScreenPoint,
	SelectionMenuState,
	VisualDraftEditorState,
} from "@/components/viewer/pdf/types";
import { notifyError } from "@/lib/core/notify";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

type SelectionCapabilityProvides = ReturnType<
	typeof useSelectionCapability
>["provides"];

type InteractionManagerCapability = ReturnType<
	typeof useInteractionManagerCapability
>["provides"];

/** Crop options shared by the manual (⌘.) and the layout-hover entry points. */
export type BeginVisualAnnotationOptions = {
	/** Layout-hover sequence token; a stale crop is dropped instead of opening. */
	seq?: number;
	/** Hover-opened drafts auto-hide after the pointer leaves. */
	ephemeral?: boolean;
};

export type UsePdfRegionFramingOptions = {
	docId: string;
	/** Shared PDFium engine (null until the WASM host finished booting). */
	engine: PdfEngine | null;
	/** EmbedPDF capabilities; owned by `PdfViewerInner` (plugin context). */
	docCap: DocumentManagerCapability;
	selectionCap: SelectionCapabilityProvides;
	interactionCap: InteractionManagerCapability;
	/** Text-selection cluster: framing a region dismisses an open menu. */
	setSelectionMenu: Dispatch<SetStateAction<SelectionMenuState | null>>;
	/** Draft card transitions; owned by {@link usePdfLayoutHover}. */
	openVisualDraftEditor: (draft: VisualDraftEditorState) => void;
	closeVisualDraftEditor: () => void;
	/** Closed before a crop starts: a legend must not survive into a draft. */
	closeFormulaAnnotationPreview: () => void;
	/** Screen anchor beside a page-normalized region (draft card placement). */
	screenPointForRegion: (
		pageIndex0: number,
		region: PdfAskNormalizedRect,
	) => ScreenPoint;
	/** Bumped by the layout cluster to drop late crops after leave / supersede. */
	layoutHoverSeqRef: RefObject<number>;
	/** Mirrors written here and read by the layout-hover guard. */
	regionSelectingRef: RefObject<boolean>;
	visualCropPendingRef: RefObject<boolean>;
};

export type PdfRegionFraming = {
	/** Region framing (marquee) mode is armed. */
	regionSelecting: boolean;
	/** A crop is in flight; blocks re-entry and layout hover. */
	visualCropPending: boolean;
	/** Enter / leave region framing. Shared by the toolbar and the handle (⌘.). */
	toggleRegionSelect: () => void;
	/** Crop a region and open the draft editor (does not send). */
	beginVisualAnnotation: (
		page: number,
		region: PdfAskNormalizedRect,
		opts?: BeginVisualAnnotationOptions,
	) => Promise<void>;
	/** Marquee release on a page → crop that region. */
	handleVisualRegionSelect: (
		page: number,
		region: PdfAskNormalizedRect,
	) => void;
};

export function usePdfRegionFraming({
	docId,
	engine,
	docCap,
	selectionCap,
	interactionCap,
	setSelectionMenu,
	openVisualDraftEditor,
	closeVisualDraftEditor,
	closeFormulaAnnotationPreview,
	screenPointForRegion,
	layoutHoverSeqRef,
	regionSelectingRef,
	visualCropPendingRef,
}: UsePdfRegionFramingOptions): PdfRegionFraming {
	const { t } = useTranslation("viewer");
	const [regionSelecting, setRegionSelecting] = useState(false);
	const [visualCropPending, setVisualCropPending] = useState(false);
	regionSelectingRef.current = regionSelecting;
	visualCropPendingRef.current = visualCropPending;

	// Disarm framing when the active PDF document changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: docId is the effect trigger, not a value read inside the effect.
	useEffect(() => {
		setRegionSelecting(false);
	}, [docId]);

	/** Enter/leave region framing. Shared by the toolbar and the handle. */
	const toggleRegionSelect = useCallback(() => {
		if (visualCropPendingRef.current) return;
		setSelectionMenu(null);
		closeVisualDraftEditor();
		selectionCap?.clear(docId);
		setRegionSelecting((active) => !active);
	}, [
		closeVisualDraftEditor,
		selectionCap,
		docId,
		setSelectionMenu,
		visualCropPendingRef,
	]);

	/** Crop a region and open the visual-annotation draft editor (does not send). */
	const beginVisualAnnotation = useCallback(
		async (
			page: number,
			region: PdfAskNormalizedRect,
			opts?: BeginVisualAnnotationOptions,
		) => {
			if (!engine || !docCap || visualCropPendingRef.current) return;
			if (!docCap.isDocumentOpen(docId)) return;
			const document = docCap.getDocument(docId);
			if (!document) {
				notifyError(t("pdfExplain.cropFailed"));
				return;
			}
			setVisualCropPending(true);
			setRegionSelecting(false);
			// Visual draft and formula legend are mutually exclusive; close the
			// legend up front so it does not linger for the length of the crop.
			closeFormulaAnnotationPreview();
			try {
				const image = await renderPdfRegionPromptImage({
					engine,
					document,
					pageIndex: page - 1,
					region,
				});
				if (!docCap.isDocumentOpen(docId)) return;
				if (opts?.seq != null && opts.seq !== layoutHoverSeqRef.current) {
					return;
				}
				const screen = screenPointForRegion(page - 1, region);
				const ephemeral = opts?.ephemeral === true;
				openVisualDraftEditor({
					screen,
					page,
					region,
					image,
					ephemeral: ephemeral || undefined,
				});
			} catch (error) {
				if (opts?.seq != null && opts.seq !== layoutHoverSeqRef.current) {
					return;
				}
				if (
					!docCap.isDocumentOpen(docId) ||
					isPdfDocumentCloseRaceError(error)
				) {
					return;
				}
				const message =
					error instanceof Error ? error.message : t("pdfExplain.cropFailed");
				notifyError(t("pdfExplain.cropFailed"), { description: message });
			} finally {
				setVisualCropPending(false);
			}
		},
		[
			engine,
			docCap,
			docId,
			t,
			closeFormulaAnnotationPreview,
			openVisualDraftEditor,
			screenPointForRegion,
			layoutHoverSeqRef,
			visualCropPendingRef,
		],
	);

	const handleVisualRegionSelect = useCallback(
		(page: number, region: PdfAskNormalizedRect) => {
			void beginVisualAnnotation(page, region);
		},
		[beginVisualAnnotation],
	);

	useEffect(() => {
		if (!regionSelecting) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setRegionSelecting(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [regionSelecting]);

	// Region-select mode must not allow EmbedPDF text selection under the marquee.
	useEffect(() => {
		if (!regionSelecting) return;
		setSelectionMenu(null);
		selectionCap?.clear(docId);
		const scope = interactionCap?.forDocument(docId);
		scope?.pause();
		return () => {
			scope?.resume();
		};
	}, [regionSelecting, selectionCap, interactionCap, docId, setSelectionMenu]);

	return {
		regionSelecting,
		visualCropPending,
		toggleRegionSelect,
		beginVisualAnnotation,
		handleVisualRegionSelect,
	};
}
