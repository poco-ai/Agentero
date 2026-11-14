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
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type {
	LayoutAnalysisTask,
	StartLayoutAnalysisOptions,
} from "@/components/viewer/pdf/hooks/use-pdf-layout-run";
import { renderPdfRegionPromptImage } from "@/components/viewer/pdf/region-crop";
import type {
	PdfViewerHandle,
	PdfViewerProps,
} from "@/components/viewer/pdf/types";
import { errorText } from "@/lib/core/error";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import { deletePdfAskThread, type PdfAskThread } from "@/lib/pdf/ask";
import {
	isLiveAnnotation,
	isTextMarkupObject,
} from "@/lib/pdf/highlight/annotation-store";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";
import { setFocusedLayoutRegion } from "@/lib/pdf/layout";
import { planVisualTraceJump } from "@/lib/pdf/visual-trace-jump";
import { writeVaultBytes } from "@/lib/vault/fs";

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
	goToRegion: PdfViewerHandle["scrollToLayoutRegion"];
	docId: string;
	/** Sidecar root; deleting an ask also removes its `marks/<id>.json`. */
	paperAbsPath: string | null;
	/** Default file name (no extension) for the exported annotated PDF. */
	defaultExportName: string;
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
	/** Layout cluster; owned by {@link usePdfLayoutRun}. */
	layoutTaskRef: RefObject<LayoutAnalysisTask | null>;
	startLayoutAnalysisRef: RefObject<
		(opts?: StartLayoutAnalysisOptions) => void
	>;
	openEditorForAnnotation: (id: string) => void;
	openThread: (thread: PdfAskThread) => void;
	deleteVisualTraceById: (id: string) => void;
	/** Highlight deletion coordinated with any in-flight commit for the same uid. */
	deleteHighlightAnnotation: (pageIndex: number, id: string) => void;
	toggleRegionSelect: () => void;
	/** Dual-pane-aware full-text translate toggle; parent callback — kept in a ref. */
	toggleLayoutTranslate: () => void;
};

export function usePdfViewerHandle({
	goToRegion,
	docId,
	paperAbsPath,
	defaultExportName,
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
	deleteVisualTraceById,
	deleteHighlightAnnotation,
	toggleRegionSelect,
	toggleLayoutTranslate,
}: UsePdfViewerHandleOptions): void {
	const { t } = useTranslation("viewer");
	const goToRegionRef = useRef(goToRegion);
	goToRegionRef.current = goToRegion;
	const onHandleRef = useRef(onHandle);
	onHandleRef.current = onHandle;
	// Dual-pane deps (translation-tab callback) churn per render; mirror the
	// latest callback so the handle object never needs re-registering.
	const toggleLayoutTranslateRef = useRef(toggleLayoutTranslate);
	toggleLayoutTranslateRef.current = toggleLayoutTranslate;
	const defaultExportNameRef = useRef(defaultExportName);
	defaultExportNameRef.current = defaultExportName;

	// biome-ignore lint/correctness/useExhaustiveDependencies: the injected refs and setters are stable identities; depending on them would re-register the handle on every mark change.
	useEffect(() => {
		const register = onHandleRef.current;
		if (!register) return;
		const handle: PdfViewerHandle = {
			getHighlights: () => highlightsRef.current,
			scrollToHighlight: (id) => {
				const tracked = annotationCap?.forDocument(docId).getAnnotationById(id);
				if (!tracked || !isLiveAnnotation(tracked)) return;
				const obj = tracked.object;
				if (!isTextMarkupObject(obj)) return;
				// Instant: smooth jumps across distant pages feel like slow render.
				scrollRef.current?.scrollToPage({
					pageNumber: obj.pageIndex + 1,
					behavior: "instant",
				});
				annotationCap?.forDocument(docId).selectAnnotation(obj.pageIndex, id);
			},
			editComment: (id) => openEditorForAnnotation(id),
			deleteHighlight: (id) => {
				const tracked = annotationCap?.forDocument(docId).getAnnotationById(id);
				if (tracked && isTextMarkupObject(tracked.object)) {
					deleteHighlightAnnotation(tracked.object.pageIndex, id);
				}
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
				const page =
					docCapRef.current?.getDocument(docId)?.pages[
						Math.max(0, tr.page - 1)
					];
				const plan = planVisualTraceJump(tr, page?.size);
				// Locate only. The floating transcript card stays on the pin click.
				scrollRef.current?.scrollToPage({
					pageNumber: plan.pageNumber,
					behavior: "instant",
					...(plan.pageCoordinates
						? {
								pageCoordinates: plan.pageCoordinates,
								alignX: 0,
								alignY: 18,
							}
						: {}),
				});
				if (plan.bbox) {
					setFocusedLayoutRegion(
						docId,
						tr.id,
						{
							pageIndex: plan.pageIndex,
							bbox: plan.bbox,
							kind: "image",
						},
						{ flash: true },
					);
				}
			},
			deleteVisualTrace: (id) => {
				deleteVisualTraceById(id);
			},
			toggleVisualAnnotation: toggleRegionSelect,
			toggleLayoutTranslate: () => toggleLayoutTranslateRef.current(),
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
			scrollToLayoutRegion: (region) => goToRegionRef.current(region),
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
			exportAnnotatedPdf: async () => {
				if (!isTauri()) {
					notifyError(t("pdf.exportDesktopOnly"));
					return;
				}
				const engine = engineRef.current;
				const docCap = docCapRef.current;
				if (!engine || !docCap) return;
				const document = docCap.getDocument(docId);
				if (!document) return;

				let path: string | null;
				try {
					const { save } = await import("@tauri-apps/plugin-dialog");
					path = await save({
						defaultPath: `${defaultExportNameRef.current}.pdf`,
						filters: [{ name: "PDF", extensions: ["pdf"] }],
					});
				} catch (error) {
					notifyError(errorText(error));
					return;
				}
				if (!path) return;

				const exportingToast = toast.loading(t("pdf.exportingAnnotatedPdf"));
				try {
					const scope = annotationCap?.forDocument(docId);
					if (scope) {
						await scope.commit().toPromise();
					}
					const buffer = await engine.saveAsCopy(document).toPromise();
					await writeVaultBytes(path, new Uint8Array(buffer));
					notifySuccess(t("pdf.exportAnnotatedPdfSaved"), {
						id: exportingToast,
					});
				} catch (error) {
					toast.dismiss(exportingToast);
					notifyError(errorText(error) || t("pdf.exportAnnotatedPdfFailed"));
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
		deleteVisualTraceById,
		deleteHighlightAnnotation,
		toggleRegionSelect,
	]);
}
