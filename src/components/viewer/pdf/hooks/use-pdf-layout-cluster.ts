/**
 * Layout-analysis cluster for the PDF viewer: region buckets, the analysis
 * run, the Figures-panel handlers, the visual-draft card state and the
 * bulk-translate job.
 *
 * Grouped because they form one capability around `layoutAnalysisStore` +
 * the layout-analysis plugin: the run feeds the store, the store feeds the
 * buckets / Figures rail, and bulk translate walks the run's raw regions.
 * Capability scopes (scroll / layout / doc manager) are passed in as refs —
 * EmbedPDF returns a fresh scope object every render, so they must never
 * become effect deps inside this cluster.
 */

import type { PdfEngine } from "@embedpdf/models";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import type { useLayoutAnalysisCapability } from "@embedpdf/plugin-layout-analysis/react";
import type { useScroll } from "@embedpdf/plugin-scroll/react";
import { type RefObject, useCallback, useMemo } from "react";
import type { PdfLayoutRegions } from "@/components/viewer/pdf/hooks/use-pdf-layout-regions";
import { usePdfLayoutRegions } from "@/components/viewer/pdf/hooks/use-pdf-layout-regions";
import { usePdfLayoutRun } from "@/components/viewer/pdf/hooks/use-pdf-layout-run";
import { usePdfLayoutTranslate } from "@/components/viewer/pdf/hooks/use-pdf-layout-translate";
import { usePdfVisualDraft } from "@/components/viewer/pdf/hooks/use-pdf-visual-draft";
import { renderPdfRegionPromptImage } from "@/components/viewer/pdf/region-crop";
import type { PromptImage } from "@/lib/agent/api";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import { type PdfLayoutRegion, setFocusedLayoutRegion } from "@/lib/pdf/layout";

type LayoutCapability = ReturnType<
	typeof useLayoutAnalysisCapability
>["provides"];

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

type ScrollCapability = ReturnType<typeof useScroll>["provides"];

export type UsePdfLayoutClusterOptions = {
	docId: string;
	totalPages: number;
	/** Workspace active tab; only the active viewer auto-runs the analysis. */
	isActive: boolean;
	/** Paper folder holding the `layout.json` sidecar (null for loose PDFs). */
	paperAbsPath: string | null;
	/** Vault-relative path, used as the background-task label. */
	paperRelPath: string | null;
	/** Stable paper identifier for per-document Agent session reuse. */
	paperKey: string | null;
	/** Vault root passed to the Agent as its cwd. */
	vaultPath: string | null;
	/** Layout capability value gates the auto-run effect; the ref is never a dep. */
	layoutCap: LayoutCapability;
	layoutCapRef: RefObject<LayoutCapability>;
	/** Document manager scope + ref (fresh scope each render, never a dep). */
	docCap: DocumentManagerCapability;
	docCapRef: RefObject<DocumentManagerCapability>;
	/** Shared PDFium engine mirror, for region-crop thumbnails. */
	engineRef: RefObject<PdfEngine | null>;
	/** Scroll scope mirror, for region jumps. */
	scrollRef: RefObject<ScrollCapability>;
	/** Viewer host element, for the visual-draft card anchor. */
	hostRef: RefObject<HTMLDivElement | null>;
};

export type PdfLayoutCluster = Omit<
	PdfLayoutRegions,
	"layoutDocRegions" | "layoutRawRegions"
> &
	ReturnType<typeof usePdfLayoutRun> &
	ReturnType<typeof usePdfVisualDraft> &
	ReturnType<typeof usePdfLayoutTranslate> & {
		/** Figures panel: run (or re-run) the layout analysis. */
		handleAnalyzeLayout: () => void;
		/** Figures panel: scroll to a region and focus-outline it. */
		handleJumpToLayoutRegion: (region: PdfLayoutRegion) => void;
		/** Figures panel thumbnails: render a region crop (null on any miss). */
		handleRenderLayoutThumb: (
			region: PdfLayoutRegion,
		) => Promise<PromptImage | null>;
		/** On-page draft frame while the visual draft card is open. */
		visualDraftRegion: { page: number; region: PdfAskNormalizedRect } | null;
	};

export function usePdfLayoutCluster({
	docId,
	totalPages,
	isActive,
	paperAbsPath,
	paperRelPath,
	paperKey,
	vaultPath,
	layoutCap,
	layoutCapRef,
	docCap,
	docCapRef,
	engineRef,
	scrollRef,
	hostRef,
}: UsePdfLayoutClusterOptions): PdfLayoutCluster {
	// Four hooks: region buckets, the analysis run, hover (sole owner of the two
	// mutually exclusive hover cards) and the bulk-translate job.
	const {
		layoutOverlayVisible,
		layoutRawRegions,
		hoverableRegionsByPage,
		rawRegionsByPage,
	} = usePdfLayoutRegions(docId);

	const { startLayoutAnalysisRef, layoutTaskRef } = usePdfLayoutRun({
		docId,
		paperAbsPath,
		paperRelPath,
		isActive,
		totalPages,
		layoutCap,
		layoutCapRef,
		docCap,
		docCapRef,
	});

	const handleAnalyzeLayout = useCallback(() => {
		startLayoutAnalysisRef.current({
			force: false,
			openFigures: true,
			showOverlay: true,
			asBackgroundTask: true,
			notifyOnError: true,
		});
	}, [startLayoutAnalysisRef]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrollRef is an injected stable ref; EmbedPDF returns a fresh scope object per render, so only the ref may be read here.
	const handleJumpToLayoutRegion = useCallback(
		(region: PdfLayoutRegion) => {
			scrollRef.current?.scrollToPage({
				pageNumber: region.pageIndex + 1,
				behavior: "instant",
			});
			setFocusedLayoutRegion(docId, region.id);
		},
		[docId],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: engineRef/docCapRef are injected stable refs (fresh EmbedPDF scope objects per render, never deps).
	const handleRenderLayoutThumb = useCallback(
		async (region: PdfLayoutRegion) => {
			const eng = engineRef.current;
			const docs = docCapRef.current;
			if (!eng || !docs) return null;
			if (!docs.isDocumentOpen(docId)) return null;
			const document = docs.getDocument(docId);
			if (!document) return null;
			try {
				const image = await renderPdfRegionPromptImage({
					engine: eng,
					document,
					pageIndex: region.pageIndex,
					region: region.bbox,
					maxEdgePx: 360,
				});
				if (!docs.isDocumentOpen(docId)) return null;
				return image;
			} catch {
				return null;
			}
		},
		[docId],
	);

	const {
		visualDraftEditor,
		openVisualDraftEditor,
		closeVisualDraftEditor,
		screenPointForRegion,
	} = usePdfVisualDraft({ hostRef });

	const {
		layoutTranslateItemsByPage,
		layoutTranslatePageStateByPage,
		layoutTranslateRunning,
		layoutTranslateActive,
		layoutTranslateLabel,
		toggleLayoutTranslate,
		togglePageLayoutTranslate,
	} = usePdfLayoutTranslate({
		docId,
		layoutRawRegions,
		paperAbsPath,
		paperKey,
		vaultPath,
	});

	const visualDraftRegion = useMemo(
		() =>
			visualDraftEditor
				? {
						page: visualDraftEditor.page,
						region: visualDraftEditor.region,
					}
				: null,
		[visualDraftEditor],
	);

	return {
		layoutOverlayVisible,
		hoverableRegionsByPage,
		rawRegionsByPage,
		startLayoutAnalysisRef,
		layoutTaskRef,
		handleAnalyzeLayout,
		handleJumpToLayoutRegion,
		handleRenderLayoutThumb,
		visualDraftEditor,
		openVisualDraftEditor,
		closeVisualDraftEditor,
		screenPointForRegion,
		layoutTranslateItemsByPage,
		layoutTranslatePageStateByPage,
		layoutTranslateRunning,
		layoutTranslateActive,
		layoutTranslateLabel,
		toggleLayoutTranslate,
		togglePageLayoutTranslate,
		visualDraftRegion,
	};
}
