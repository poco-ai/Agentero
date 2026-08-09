/**
 * Register the viewer's imperative handle for the annotations panel, the
 * References rail and the command palette (see `pdf-viewer-registry`).
 *
 * Its own hook because it is the one place that reaches into every cluster.
 * Every option is either a stable callback or a mirror ref, so the handle is
 * registered once per document instead of once per paint — the annotations
 * panel re-reads `getHighlights()` on demand rather than through a new handle.
 */

import type { PdfEngine } from "@embedpdf/models";
import type { useAnnotationCapability } from "@embedpdf/plugin-annotation/react";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import type { useScroll } from "@embedpdf/plugin-scroll/react";
import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useEffect,
	useRef,
} from "react";
import { renderPdfRegionPromptImage } from "@/components/viewer/embed/pdf-region-crop";
import type {
	PdfViewerHandle,
	PdfViewerProps,
} from "@/components/viewer/embed/pdf-viewer-types";
import type {
	LayoutAnalysisTask,
	StartLayoutAnalysisOptions,
} from "@/components/viewer/embed/use-pdf-layout-analysis";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import { deletePdfAskThread, type PdfAskThread } from "@/lib/pdf/ask";
import { isHighlightObject } from "@/lib/pdf/highlight/annotation-store";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";
import { setFocusedLayoutRegion } from "@/lib/pdf/layout";
import type { ActiveSelectionCard } from "@/lib/pdf/selection";

/** Longest edge of a figure-rail thumbnail crop (px). */
const REGION_THUMBNAIL_MAX_EDGE = 360;

type AnnotationCapabilityProvides = ReturnType<
	typeof useAnnotationCapability
>["provides"];

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

type ScrollCapability = ReturnType<typeof useScroll>["provides"];

export type UsePdfViewerHandleOptions = {
	docId: string;
	/** Sidecar root; deleting an ask also removes its `marks/<id>.json`. */
	paperAbsPath: string | null;
	/** Parent callback, often an inline lambda — kept in a ref. */
	onHandle: PdfViewerProps["onHandle"];
	/** EmbedPDF capability; owned by `PdfViewerInner` (plugin context). */
	annotationCap: AnnotationCapabilityProvides;
	/** Capability refs: `forDocument()` returns a fresh scope every render. */
	scrollRef: RefObject<ScrollCapability>;
	engineRef: RefObject<PdfEngine | null>;
	docCapRef: RefObject<DocumentManagerCapability>;
	/** Mark mirrors, so a new mark never re-registers the handle. */
	highlightsRef: RefObject<PdfHighlight[]>;
	threadsRef: RefObject<PdfAskThread[]>;
	visualTracesRef: RefObject<PdfVisualSessionTrace[]>;
	setThreads: Dispatch<SetStateAction<PdfAskThread[]>>;
	/** Layout cluster; owned by {@link usePdfLayoutAnalysis}. */
	layoutTaskRef: RefObject<LayoutAnalysisTask | null>;
	startLayoutAnalysisRef: RefObject<
		(opts?: StartLayoutAnalysisOptions) => void
	>;
	openEditorForAnnotation: (id: string) => void;
	openThread: (thread: PdfAskThread) => void;
	openCard: (card: ActiveSelectionCard) => void;
	deleteVisualTraceById: (id: string) => void;
	toggleRegionSelect: () => void;
};

export function usePdfViewerHandle({
	docId,
	paperAbsPath,
	onHandle,
	annotationCap,
	scrollRef,
	engineRef,
	docCapRef,
	highlightsRef,
	threadsRef,
	visualTracesRef,
	setThreads,
	layoutTaskRef,
	startLayoutAnalysisRef,
	openEditorForAnnotation,
	openThread,
	openCard,
	deleteVisualTraceById,
	toggleRegionSelect,
}: UsePdfViewerHandleOptions): void {
	const onHandleRef = useRef(onHandle);
	onHandleRef.current = onHandle;

	// biome-ignore lint/correctness/useExhaustiveDependencies: the injected refs and setters are stable identities; depending on them would re-register the handle on every mark change.
	useEffect(() => {
		const register = onHandleRef.current;
		if (!register) return;
		const handle: PdfViewerHandle = {
			getHighlights: () => highlightsRef.current,
			scrollToHighlight: (id) => {
				const obj = annotationCap
					?.forDocument(docId)
					.getAnnotationById(id)?.object;
				if (!obj || !isHighlightObject(obj)) return;
				// Instant: smooth jumps across distant pages feel like slow render.
				scrollRef.current?.scrollToPage({
					pageNumber: obj.pageIndex + 1,
					behavior: "instant",
				});
				annotationCap?.forDocument(docId).selectAnnotation(obj.pageIndex, id);
			},
			editComment: (id) => openEditorForAnnotation(id),
			deleteHighlight: (id) => {
				const obj = annotationCap
					?.forDocument(docId)
					.getAnnotationById(id)?.object;
				if (obj && isHighlightObject(obj))
					annotationCap?.forDocument(docId).deleteAnnotation(obj.pageIndex, id);
			},
			scrollToAsk: (id) => {
				const thread = threadsRef.current.find((th) => th.id === id);
				if (!thread) return;
				scrollRef.current?.scrollToPage({
					pageNumber: thread.anchor.page,
					behavior: "instant",
				});
				// openThread → openCard places after page mount (retry if virtualized).
				openThread({ ...thread, status: "open" });
			},
			deleteAsk: (id) => {
				setThreads((prev) => prev.filter((th) => th.id !== id));
				if (paperAbsPath) void deletePdfAskThread(paperAbsPath, id);
			},
			scrollToVisualTrace: (id) => {
				const tr = visualTracesRef.current.find((item) => item.id === id);
				if (!tr) return;
				scrollRef.current?.scrollToPage({
					pageNumber: tr.page,
					behavior: "instant",
				});
				openCard({ kind: "visual", id: tr.id });
			},
			deleteVisualTrace: (id) => {
				deleteVisualTraceById(id);
			},
			toggleVisualAnnotation: toggleRegionSelect,
			analyzeLayout: () => {
				// Prefer source/layout.json → merge → sidebar. Full ONNX (PDF→JSON)
				// only when there is no sidecar (or force is set elsewhere).
				startLayoutAnalysisRef.current({
					force: false,
					openFigures: true,
					showOverlay: true,
					asBackgroundTask: true,
					notifyOnError: true,
				});
			},
			scrollToLayoutRegion: (region) => {
				scrollRef.current?.scrollToPage({
					pageNumber: region.pageIndex + 1,
					behavior: "instant",
				});
				setFocusedLayoutRegion(docId, region.id);
			},
			renderRegion: async ({ pageIndex, bbox, maxEdgePx }) => {
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
						pageIndex,
						region: bbox,
						maxEdgePx: maxEdgePx ?? REGION_THUMBNAIL_MAX_EDGE,
					});
					if (!docs.isDocumentOpen(docId)) return null;
					return image;
				} catch {
					return null;
				}
			},
		};
		register(handle);
		return () => {
			layoutTaskRef.current?.abort({
				type: "no-document",
				message: "unmount",
			});
			layoutTaskRef.current = null;
			register(null);
		};
	}, [
		annotationCap,
		docId,
		paperAbsPath,
		openEditorForAnnotation,
		openThread,
		openCard,
		deleteVisualTraceById,
		toggleRegionSelect,
	]);
}
