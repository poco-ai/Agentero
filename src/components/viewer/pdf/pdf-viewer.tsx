import { createPluginRegistration } from "@embedpdf/core";
import { EmbedPDF } from "@embedpdf/core/react";
import type { PdfLinkAnnoObject, Rect } from "@embedpdf/models";
import { AiManagerPluginPackage } from "@embedpdf/plugin-ai-manager/react";
import {
	AnnotationPluginPackage,
	useAnnotationCapability,
} from "@embedpdf/plugin-annotation/react";
import {
	BookmarkPluginPackage,
	useBookmarkCapability,
} from "@embedpdf/plugin-bookmark/react";
import {
	DocumentContent,
	DocumentManagerPluginPackage,
	useDocumentManagerCapability,
} from "@embedpdf/plugin-document-manager/react";
import {
	GlobalPointerProvider,
	InteractionManagerPluginPackage,
	useInteractionManagerCapability,
} from "@embedpdf/plugin-interaction-manager/react";
import {
	LayoutAnalysisPluginPackage,
	useLayoutAnalysis,
	useLayoutAnalysisCapability,
} from "@embedpdf/plugin-layout-analysis/react";
import { RenderPluginPackage } from "@embedpdf/plugin-render/react";
import {
	type PageLayout,
	Scroller,
	ScrollPluginPackage,
	ScrollStrategy,
	useScroll,
} from "@embedpdf/plugin-scroll/react";
import { SearchPluginPackage, useSearch } from "@embedpdf/plugin-search/react";
import type { FormattedSelection } from "@embedpdf/plugin-selection/react";
import {
	SelectionPluginPackage,
	useSelectionCapability,
} from "@embedpdf/plugin-selection/react";
import { SpreadMode, SpreadPluginPackage } from "@embedpdf/plugin-spread/react";
import { TilingPluginPackage } from "@embedpdf/plugin-tiling/react";
import { ViewportPluginPackage } from "@embedpdf/plugin-viewport/react";
import {
	useZoom,
	ZoomGestureWrapper,
	ZoomMode,
	ZoomPluginPackage,
} from "@embedpdf/plugin-zoom/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { PdfBottomBar } from "@/components/viewer/pdf/chrome/pdf-bottom-bar";
import { PdfCardStack } from "@/components/viewer/pdf/chrome/pdf-card-stack";
import { PdfFiguresPanel } from "@/components/viewer/pdf/chrome/pdf-figures-panel";
import { PdfFindBar } from "@/components/viewer/pdf/chrome/pdf-find-bar";
import { PdfJumpBackChip } from "@/components/viewer/pdf/chrome/pdf-jump-back-chip";
import { PdfLeftToolbar } from "@/components/viewer/pdf/chrome/pdf-left-toolbar";
import { PdfOutlinePanel } from "@/components/viewer/pdf/chrome/pdf-outline-panel";
import { PdfReferencesPanel } from "@/components/viewer/pdf/chrome/pdf-references-panel";
import { PdfToolbar } from "@/components/viewer/pdf/chrome/pdf-toolbar";

import { usePdfEngineContext } from "@/components/viewer/pdf/engine-provider";
import { usePdfActiveAnchors } from "@/components/viewer/pdf/hooks/use-pdf-active-anchors";
import { usePdfAskThreads } from "@/components/viewer/pdf/hooks/use-pdf-ask-threads";
import { usePdfCards } from "@/components/viewer/pdf/hooks/use-pdf-cards";
import { usePdfChromeVisibility } from "@/components/viewer/pdf/hooks/use-pdf-chrome-visibility";
import { usePdfCitations } from "@/components/viewer/pdf/hooks/use-pdf-citations";
import { usePdfCrossrefPreview } from "@/components/viewer/pdf/hooks/use-pdf-crossref-preview";
import { usePdfFind } from "@/components/viewer/pdf/hooks/use-pdf-find";
import { usePdfHighlights } from "@/components/viewer/pdf/hooks/use-pdf-highlights";
import { usePdfJumpBack } from "@/components/viewer/pdf/hooks/use-pdf-jump-back";
import { usePdfLayoutCluster } from "@/components/viewer/pdf/hooks/use-pdf-layout-cluster";
import { usePdfMarkActions } from "@/components/viewer/pdf/hooks/use-pdf-mark-actions";
import { usePdfMarksIo } from "@/components/viewer/pdf/hooks/use-pdf-marks-io";
import { usePdfNavigation } from "@/components/viewer/pdf/hooks/use-pdf-navigation";
import {
	railEditFromComment,
	usePdfNoteEditor,
} from "@/components/viewer/pdf/hooks/use-pdf-note-editor";
import { usePdfOutline } from "@/components/viewer/pdf/hooks/use-pdf-outline";
import { usePdfPageText } from "@/components/viewer/pdf/hooks/use-pdf-page-text";
import { usePdfPaperTone } from "@/components/viewer/pdf/hooks/use-pdf-paper-tone";
import { usePdfPinAnchors } from "@/components/viewer/pdf/hooks/use-pdf-pin-anchors";
import { usePdfReadingMode } from "@/components/viewer/pdf/hooks/use-pdf-reading-mode";
import { usePdfRegionFraming } from "@/components/viewer/pdf/hooks/use-pdf-region-framing";
import { usePdfScrollSync } from "@/components/viewer/pdf/hooks/use-pdf-scroll-sync";
import { usePdfSelectionActions } from "@/components/viewer/pdf/hooks/use-pdf-selection-actions";
import { usePdfSelectionTranslate } from "@/components/viewer/pdf/hooks/use-pdf-selection-translate";
import { useSentenceGlyphRects } from "@/components/viewer/pdf/hooks/use-pdf-sentence-glyph-rects";
import { usePdfSidebarPanels } from "@/components/viewer/pdf/hooks/use-pdf-sidebar-panels";
import { usePdfTextSelection } from "@/components/viewer/pdf/hooks/use-pdf-text-selection";
import { usePdfTranslationSelection } from "@/components/viewer/pdf/hooks/use-pdf-translation-selection";
import { usePdfViewerHandle } from "@/components/viewer/pdf/hooks/use-pdf-viewer-handle";
import { usePdfVisualMarks } from "@/components/viewer/pdf/hooks/use-pdf-visual-marks";
import { usePdfZoomControls } from "@/components/viewer/pdf/hooks/use-pdf-zoom-controls";
import { useStableDerived } from "@/components/viewer/pdf/hooks/use-stable-derived";
import { excludeOverlappingPdfTextLinks } from "@/components/viewer/pdf/layers/citation-links";
import { COMMENT_RAIL_WIDTH_PX } from "@/components/viewer/pdf/layers/comment-cards-layer";
import { PDF_LINK_ANNOTATION_CONFIG } from "@/components/viewer/pdf/layers/link-annotation";
import {
	type PdfPageHandlers,
	PdfPageLayers,
	type PdfPageLayoutSlice,
	type PdfPageMarksSlice,
	type PdfPageModeSlice,
} from "@/components/viewer/pdf/layers/page-layers";
import { buildMarksIndex } from "@/components/viewer/pdf/marks-index";
import { PdfTranslationViewerInner } from "@/components/viewer/pdf/pdf-translation-viewer-inner";
import type {
	PageAnnotationComment,
	PdfViewerInnerProps,
	PdfViewerProps,
	RailEditState,
	ScreenPoint,
	SelectionCommentDraft,
	SelectionMenuState,
} from "@/components/viewer/pdf/types";
import { ActiveCardScrollSync } from "@/components/viewer/pdf/viewport/active-card-scroll-sync";
import { DockviewViewport } from "@/components/viewer/pdf/viewport/dockview-viewport";
import { PanDragHandler } from "@/components/viewer/pdf/viewport/pan-handler";
import { WheelZoomHandler } from "@/components/viewer/pdf/viewport/wheel-zoom-handler";
import { useLibraryStore, useSettings } from "@/hooks/use-app-stores";
import { commands, events, type SuggestedHighlight } from "@/lib/core/bindings";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import { isPdfViewerSource } from "@/lib/paper";
import { arxivUrls } from "@/lib/paper/arxiv";
import { lookupSubmit } from "@/lib/paper/import-actions";
import {
	annotationWikilinkMarkdown,
	wikiTargetForPaper,
} from "@/lib/pdf/annotation-ref";
import { embedPdfDocumentId } from "@/lib/pdf/document-id";
import {
	HIGHLIGHT_HEX_LIST,
	normalizeHighlightColor,
} from "@/lib/pdf/highlight/palette";
import { partitionHighlightPaint } from "@/lib/pdf/highlight/translated-geometry";
import {
	getPdfAiRuntime,
	layoutAnalysisStore,
	layoutDocumentKey,
	type PdfLayoutRegion,
	setFocusedLayoutRegion,
} from "@/lib/pdf/layout";
import { selectionAnchorFromVisible } from "@/lib/pdf/layout/visible-selection-rects";
import {
	type ActiveSelectionCard,
	selectionAnchorKey,
} from "@/lib/pdf/selection";
import {
	translateHighlightsByPage as translateHighlightsByPageOf,
	translateHighlightsFingerprint,
} from "@/lib/pdf/translate/highlights";
import { PDF_ZOOM_MAX, PDF_ZOOM_MIN } from "@/lib/pdf/zoom";
import { loadSettings } from "@/lib/settings";
import { basenameOf } from "@/lib/vault/path";
import { openLatexTranslationTab } from "@/lib/workspace/actions-latex-translation";

export type {
	PdfViewerHandle,
	PdfViewerProps,
} from "@/components/viewer/pdf/types";

/**
 * PDF viewer built on EmbedPDF (headless, PDFium/WASM). The engine is shared
 * app-wide via {@link usePdfEngineContext}; each tab mounts its own
 * `<EmbedPDF>` provider keyed by `docId` so scroll/zoom/selection/annotation
 * state stays isolated across the persistent tab set.
 *
 * Highlights/批注 are EmbedPDF annotations (persisted to
 * `marks/annotations.json`). Ask (AI Q&A) and Translate stay app-specific
 * overlays, re-sourced from the selection plugin and persisted as
 * `marks/<id>.json`.
 */
export const PdfViewer = memo(function PdfViewer(props: PdfViewerProps) {
	const { t } = useTranslation("viewer");
	const {
		engine,
		isLoading: engineLoading,
		error: engineError,
	} = usePdfEngineContext();

	const source = isPdfViewerSource(props.source) ? props.source.trim() : null;
	const sourceBytes = props.sourceBytes ?? null;
	const baseDocId =
		props.docId?.trim() ||
		props.paperRelPath ||
		props.paperAbsPath ||
		source ||
		"pdf";
	// Local buffers get a per-read revision id: the app-wide PDFium engine
	// caches documents by `documentId`, so a reloaded buffer (TeX recompile /
	// external overwrite) must register under a fresh id or the engine re-uses
	// the stale document and drops the new bytes. See `embedPdfDocumentId`.
	const docId = embedPdfDocumentId(baseDocId, sourceBytes);

	// Make a private copy of the PDF bytes for this EmbedPDF mount. The worker
	// engine may structured-clone/transfer the buffer; sharing the same
	// ArrayBuffer with another pane or across a StrictMode remount can leave us
	// with a detached buffer on the second open. The copy is created once per
	// prop identity; if slicing fails (already detached) we fall back to the URL.
	const pdfBuffer = useMemo(() => {
		if (!sourceBytes) return null;
		try {
			return sourceBytes.slice(0);
		} catch {
			return null;
		}
	}, [sourceBytes]);
	const effectiveSourceBytes = pdfBuffer ?? sourceBytes;

	const translationOnly = Boolean(props.translationOnly);
	const plugins = useMemo(() => {
		if (!source && !effectiveSourceBytes) return null;
		// Prefer bytes (no fetch step); fall back to a URL (remote https).
		const initialDocument = effectiveSourceBytes
			? { buffer: effectiveSourceBytes, documentId: docId, name: docId }
			: { url: source as string, documentId: docId, name: docId };
		// Translation pane only needs raster + scroll/zoom. Skipping selection /
		// annotation / search / ONNX layout avoids a second full viewer tax when
		// dual-pane translation opens beside the source.
		//
		// Reading mode is a snapshot at registration so the first layout already
		// matches the stored preference (no vertical→horizontal flash); later
		// changes are applied live by `usePdfReadingMode`.
		const reading = loadSettings();
		const core = [
			createPluginRegistration(DocumentManagerPluginPackage, {
				initialDocuments: [initialDocument],
			}),
			createPluginRegistration(ViewportPluginPackage),
			// Must precede the scroll plugin: its constructor resolves the
			// optional spread plugin to group pages into one/two-page rows.
			createPluginRegistration(SpreadPluginPackage, {
				defaultSpreadMode:
					reading.pdfSpreadMode === "odd"
						? SpreadMode.Odd
						: reading.pdfSpreadMode === "even"
							? SpreadMode.Even
							: SpreadMode.None,
			}),
			createPluginRegistration(ScrollPluginPackage, {
				// Manifest default (4) keeps ~8 off-screen pages mounted, and every
				// mounted page re-renders whenever the scroller layout changes.
				defaultBufferSize: translationOnly ? 1 : 2,
				defaultStrategy:
					reading.pdfScrollStrategy === "horizontal"
						? ScrollStrategy.Horizontal
						: ScrollStrategy.Vertical,
			}),
			createPluginRegistration(RenderPluginPackage),
			createPluginRegistration(TilingPluginPackage, {
				// Pre-render one ring of tiles around the viewport so fast
				// scrolling does not pop tiles in at the edges (rendering is
				// off-main-thread in the worker engine, so the extra tiles are
				// cheap). Translation pane stays lean: no ring prefetch.
				extraRings: translationOnly ? 0 : 1,
				// Larger tiles → fewer render round-trips through the single
				// worker, which matters on long documents.
				tileSize: 1024,
			}),
			createPluginRegistration(ZoomPluginPackage, {
				defaultZoomLevel: ZoomMode.FitWidth,
				minZoom: PDF_ZOOM_MIN,
				maxZoom: PDF_ZOOM_MAX,
			}),
			createPluginRegistration(InteractionManagerPluginPackage),
		];
		if (translationOnly) return core;
		return [
			...core,
			createPluginRegistration(SelectionPluginPackage, {
				// Text selection is enough for the floating menu. EmbedPDF's built-in
				// marquee can be triggered by slight misses around glyphs and paints a
				// large blue rectangle over the page; visual region annotation uses our
				// explicit ScanSearch mode instead.
				marquee: { enabled: false },
			}),
			createPluginRegistration(AnnotationPluginPackage, {
				...PDF_LINK_ANNOTATION_CONFIG,
				annotationAuthor: "Agentero",
				colorPresets: HIGHLIGHT_HEX_LIST,
				selectAfterCreate: false,
				deactivateToolAfterCreate: true,
			}),
			createPluginRegistration(SearchPluginPackage),
			createPluginRegistration(BookmarkPluginPackage),
			// Experimental: on-device layout (image/table/formula) via ONNX.
			// Model lives under XDG cache (startup prefetch: ModelScope → HF).
			createPluginRegistration(AiManagerPluginPackage, {
				runtime: getPdfAiRuntime(),
			}),
			createPluginRegistration(LayoutAnalysisPluginPackage, {
				// Match sidebar default min confidence (30%).
				layoutThreshold: 0.3,
				tableStructure: false,
				autoAnalyze: false,
				renderScale: 2,
			}),
		];
	}, [source, effectiveSourceBytes, docId, translationOnly]);

	const hostClass = cn(
		"relative flex h-full min-h-0 flex-col bg-muted/40",
		props.className,
	);

	if (!source && !sourceBytes) {
		return (
			<div id="agentero-pdf-host" className={hostClass}>
				<p className="p-6 text-center text-muted-foreground text-sm">
					{t("pdf.empty")}
				</p>
			</div>
		);
	}

	if (engineError) {
		return (
			<div id="agentero-pdf-host" className={hostClass}>
				<p className="p-6 text-destructive text-sm">
					{engineError.message || t("pdf.loadError")}
				</p>
			</div>
		);
	}

	if (engineLoading || !engine || !plugins) {
		return (
			<div id="agentero-pdf-host" className={hostClass}>
				<p className="p-6 text-center text-muted-foreground text-sm">
					{t("pdf.loading")}
				</p>
			</div>
		);
	}

	return (
		<div id="agentero-pdf-host" className={hostClass}>
			<EmbedPDF
				key={`${docId}::${source ?? "buffer"}`}
				engine={engine}
				plugins={plugins}
			>
				<DocumentContent documentId={docId}>
					{({ isLoaded, isLoading, isError, documentState }) => {
						if (isError) {
							console.error(
								`[PdfViewer ${docId}] document load error:`,
								documentState.error,
								documentState.errorDetails,
							);
							return (
								<p className="p-6 text-center text-destructive text-sm">
									{t("pdf.loadError")}
									{documentState.error ? `: ${documentState.error}` : null}
								</p>
							);
						}
						if (!isLoaded) {
							return (
								<p className="p-6 text-center text-muted-foreground text-sm">
									{isLoading ? t("pdf.loading") : t("pdf.empty")}
								</p>
							);
						}
						return props.translationOnly ? (
							<PdfTranslationViewerInner
								{...props}
								docId={docId}
								baseDocId={baseDocId}
								sourceBytes={effectiveSourceBytes}
							/>
						) : (
							<PdfViewerInner
								{...props}
								docId={docId}
								baseDocId={baseDocId}
								sourceBytes={effectiveSourceBytes}
							/>
						);
					}}
				</DocumentContent>
			</EmbedPDF>
		</div>
	);
});

/** Identity of the selected text. Screen position is not part of it, so scrolling does not look like a new selection. */
function selectionCommentKey(menu: SelectionMenuState | null): string {
	if (!menu) return "";
	const glyph = menu.pages
		.map((page) => {
			const { origin, size } = page.rect;
			return `${page.pageIndex}:${origin.x}:${origin.y}:${size.width}:${size.height}`;
		})
		.join(";");
	const visible =
		menu.visiblePages
			?.map((page) =>
				page.rects
					.map(
						(rect) =>
							`${page.pageIndex}:${rect.x}:${rect.y}:${rect.w}:${rect.h}`,
					)
					.join(","),
			)
			.join(";") ?? "";
	return `${menu.anchor.quote}\u0000${menu.anchor.page}\u0000${glyph}\u0000${visible}`;
}

function PdfViewerInner({
	docId,
	baseDocId,
	sourceBytes = null,
	paperAbsPath = null,
	paperRelPath = null,
	vaultPath = null,
	paperMeta: paperMetaProp = null,
	isActive = true,
	isRemotePaper = false,
	plainViewer = false,
	translationPane = false,
	translationOnly = false,
	importIdentifier,
	onOpenSettings,
	onHandle,
	onHighlightsChange,
	onAsksChange,
	onVisualTracesChange,
	onOpenTranslationTab,
}: PdfViewerInnerProps) {
	const { t } = useTranslation("viewer");
	const [importBusy, setImportBusy] = useState(false);
	// Parent often passes inline lambdas; keep latest in refs so data effects
	// do not re-fire every parent render (was Maximum update depth exceeded).
	const onAsksChangeRef = useRef(onAsksChange);
	onAsksChangeRef.current = onAsksChange;
	const onVisualTracesChangeRef = useRef(onVisualTracesChange);
	onVisualTracesChangeRef.current = onVisualTracesChange;
	const onHighlightsChangeRef = useRef(onHighlightsChange);
	onHighlightsChangeRef.current = onHighlightsChange;

	const { engine } = usePdfEngineContext();
	const { provides: zoom, state: zoomState } = useZoom(docId);
	const { provides: scroll, state: scrollState } = useScroll(docId);
	usePdfScrollSync(docId);
	usePdfReadingMode(docId);
	const { provides: selectionCap } = useSelectionCapability();
	const { provides: interactionCap } = useInteractionManagerCapability();
	const { provides: annotationCap } = useAnnotationCapability();
	const { provides: docCap } = useDocumentManagerCapability();
	const { state: searchState, provides: search } = useSearch(docId);
	const { provides: bookmarkCap } = useBookmarkCapability();
	const { provides: layoutCap } = useLayoutAnalysisCapability();
	const { provides: layoutAnalysisProvides } = useLayoutAnalysis(docId);

	// EmbedPDF's useScroll calls forDocument() every render and returns a fresh
	// scope object (createScrollScope). Never put `scroll` in useEffect deps —
	// only primitive readiness (scrollReady) or scrollState fields.
	const scrollRef = useRef(scroll);
	scrollRef.current = scroll;
	const scrollReady = Boolean(scroll);
	const layoutCapRef = useRef(layoutCap);
	layoutCapRef.current = layoutCap;

	// Keep EmbedPDF's raw LayoutAnalysisLayer off. Sidecar cache hits never
	// repopulate plugin page layouts, so that layer would stay empty; we paint
	// post-merge store regions instead (same set as Figures / hover targets).
	useEffect(() => {
		layoutAnalysisProvides?.setLayoutOverlayVisible(false);
	}, [layoutAnalysisProvides]);
	const engineRef = useRef(engine);
	engineRef.current = engine;
	const docCapRef = useRef(docCap);
	docCapRef.current = docCap;

	const currentPage = scrollState.currentPage || 1;
	const totalPages = scrollState.totalPages || 0;

	/** Sidebar / citation focus → PDF outline (stable refs only — no fresh objects). */
	const focusedLayoutRegion = useStore(layoutAnalysisStore, (s) => {
		if (s.focused?.documentId !== docId) return null;
		const focused = s.focused;
		if (!focused) return null;
		if (focused.region) return focused.region;
		// byDocument is keyed by the revision-stripped base id.
		const result = s.byDocument[layoutDocumentKey(docId)];
		if (!result) return null;
		return (
			result.regions.find((r) => r.id === focused.regionId) ??
			result.rawRegions.find((r) => r.id === focused.regionId) ??
			null
		);
	});
	const focusedLayoutFlash = useStore(
		layoutAnalysisStore,
		(s) => s.focused?.documentId === docId && Boolean(s.focused.flash),
	);
	const focusedLayoutFlashToken = useStore(layoutAnalysisStore, (s) =>
		s.focused?.documentId === docId ? (s.focused.flashToken ?? 0) : 0,
	);
	const zoomLevel = zoomState.currentZoomLevel || 1;

	const { pdfTone, setPdfTone } = usePdfPaperTone();
	const { zoomRef } = usePdfZoomControls(zoomLevel);

	const paperKey = paperRelPath || paperAbsPath || null;

	// Catalog title + link for the ask card's external "open in chat" query.
	const paperMetaByRelPath = useLibraryStore((s) => s.paperMetaByRelPath);
	const autoTranslateSelection = useSettings(
		(s) => s.translate.autoTranslateSelection,
	);
	const displayMode = useSettings((s) => s.translate.displayMode);
	const dualPaneSource = useSettings((s) => s.translate.dualPaneSource);
	const dualPaneTranslate = displayMode === "dualPane";
	const smartHighlightEnabled = useSettings((s) => s.decision.smartHighlight);
	const paperMeta = useMemo(() => {
		if (paperMetaProp) return paperMetaProp;
		if (!paperRelPath) return undefined;
		const key = paperRelPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		return paperMetaByRelPath.get(key);
	}, [paperMetaProp, paperRelPath, paperMetaByRelPath]);
	const paperTitle = paperMeta?.title;
	/** Default file name for the "export annotated PDF" save dialog. */
	const defaultExportName = useMemo(() => {
		const raw =
			paperTitle?.trim() ||
			paperRelPath
				?.replace(/\\/g, "/")
				.split("/")
				.pop()
				?.replace(/\.pdf$/i, "") ||
			paperAbsPath
				?.replace(/\\/g, "/")
				.split("/")
				.pop()
				?.replace(/\.pdf$/i, "") ||
			"annotated";
		const safe = raw.replace(/[\\/:*?"<>|]+/g, "_").trim();
		return safe.slice(0, 100) || "annotated";
	}, [paperTitle, paperRelPath, paperAbsPath]);
	/** Resolvable wiki target for comment-rail copy-link/copy-embed. */
	const commentWikiTarget = useMemo(() => {
		if (!paperRelPath) return null;
		return wikiTargetForPaper(paperRelPath, paperRelPath);
	}, [paperRelPath]);
	const paperLink = useMemo(() => {
		if (!paperMeta) return undefined;
		if (paperMeta.arxiv_id) return arxivUrls(paperMeta.arxiv_id)?.abs;
		return (
			paperMeta.source_url ??
			paperMeta.html_url ??
			paperMeta.pdf_url ??
			undefined
		);
	}, [paperMeta]);

	const handleImportToLibrary = useCallback(async () => {
		if (!importIdentifier || importBusy) return;
		setImportBusy(true);
		try {
			await lookupSubmit([importIdentifier]);
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			setImportBusy(false);
		}
	}, [importIdentifier, importBusy]);

	const { pageField, setPageField, pageFocusedRef, goToPage, commitPageField } =
		usePdfNavigation({
			paperKey,
			currentPage,
			totalPages,
			scroll,
			scrollRef,
			scrollReady,
		});

	// ---- Highlights (EmbedPDF annotations) ----

	const {
		highlights,
		highlightsRef,
		highlightAnchors,
		citationLinks,
		createHighlights,
		updateHighlightComment,
		updateHighlightColor,
		deleteHighlightAnnotation,
	} = usePdfHighlights({
		annotationCap,
		docCap,
		docId,
		paperAbsPath,
		paperKey,
		totalPages,
		onHighlightsChangeRef,
	});

	// ---- Persisted marks (ask threads / translates / visual traces) ----

	const {
		threads,
		threadsRef,
		setThreads,
		translates,
		translatesRef,
		protectedTranslateIdsRef,
		setTranslates,
		visualTraces,
		visualTracesRef,
		setVisualTraces,
		upsertThread,
		upsertTranslate,
		upsertVisualTrace,
	} = usePdfMarksIo({
		paperAbsPath,
		isActive,
		onAsksChangeRef,
		onVisualTracesChangeRef,
	});
	const translateHighlightsByPage = useStableDerived(
		() => translateHighlightsByPageOf(translates),
		translateHighlightsFingerprint(translates),
	);
	/**
	 * Per-page 0–1 text rects from PDFium `getPageTextRects` — used to decide
	 * whether a gutter pin sits on real glyphs (translucent) vs in a free gutter.
	 */
	const { pageTextMap, pageTextLinkMap, pageTextMapRef } = usePdfPageText({
		engine,
		docCap,
		docId,
		totalPages,
		currentPage,
		translates,
		threads,
		highlights,
		visualTraces,
	});
	const textLinks = useMemo(() => {
		const next = new Map(pageTextLinkMap);
		for (const [pageIndex, links] of pageTextLinkMap) {
			next.set(
				pageIndex,
				excludeOverlappingPdfTextLinks(
					links,
					citationLinks.get(pageIndex) ?? [],
				),
			);
		}
		return next;
	}, [pageTextLinkMap, citationLinks]);

	const hostRef = useRef<HTMLDivElement>(null);
	const selectionCommentEngagedRef = useRef(false);

	// ---- Text selection → floating action menu ----
	// Placed after hostRef/zoomRef: the hook anchors the menu against the page
	// element and needs both refs injected.
	const {
		selectionMenu,
		setSelectionMenu,
		isSelecting,
		closeSelectionMenu,
		rePlaceSelectionMenu,
	} = usePdfTextSelection({
		selectionCap,
		docCap,
		docId,
		hostRef,
		zoomRef,
		isActive,
		paperRelPath,
		paperAbsPath,
		isCommentDraftActive: () => selectionCommentEngagedRef.current,
	});

	/**
	 * Session token of the single in-flight PDF agent run. Shared by ask and
	 * translate (either can cancel the other's run), so it stays in the parent and
	 * is injected into both clusters.
	 */
	const activeSessionRef = useRef<string | null>(null);

	/**
	 * `usePdfCards` must be declared before the ask and translate clusters (both
	 * open and hide cards), but cards also reset per-kind chrome, discard temporary
	 * translations, and cancel a replaced translate. Those edges go through refs
	 * assigned right after each hook, so card lifecycle callbacks stay stable.
	 */
	const stopTranslateSessionRef = useRef<() => void>(() => undefined);
	const discardUnpinnedTranslateOnCloseRef = useRef<(id: string) => void>(
		() => undefined,
	);
	const clearTranslateErrorRef = useRef<() => void>(() => undefined);
	const clearAskErrorRef = useRef<() => void>(() => undefined);
	const closeAskChromeRef = useRef<(threadId: string) => void>(() => undefined);
	const closeEditorRef = useRef<() => void>(() => undefined);
	const stopTranslateSession = useCallback(() => {
		stopTranslateSessionRef.current();
	}, []);

	/** Per-kind chrome reset when a card is opened. */
	const resetChromeForOpenedCard = useCallback((card: ActiveSelectionCard) => {
		if (card.kind === "ask") clearAskErrorRef.current();
		if (card.kind === "translate") clearTranslateErrorRef.current();
	}, []);

	/** Per-kind chrome reset when the open card is dismissed. */
	const resetChromeForClosedCard = useCallback(
		(card: ActiveSelectionCard | null) => {
			if (card?.kind === "ask") closeAskChromeRef.current(card.id);
			if (card?.kind === "translate") {
				clearTranslateErrorRef.current();
				discardUnpinnedTranslateOnCloseRef.current(card.id);
			}
			closeEditorRef.current();
		},
		[],
	);

	const {
		activeCard,
		activeCardRef,
		cardScreen,
		cardScreenRef,
		setActiveCard,
		setCardScreen,
		openCard,
		hideActiveCard,
		placeActiveCard,
		rePlaceActiveCardOnScroll,
		markCardHoverEnter,
		scheduleHoverHide,
	} = usePdfCards({
		hostRef,
		pageTextMapRef,
		threadsRef,
		translatesRef,
		visualTracesRef,
		onCardOpen: resetChromeForOpenedCard,
		onCardClose: resetChromeForClosedCard,
		stopTranslateSession,
	});

	// ---- Selection → 翻译 (ephemeral card + marks/<id>.json) ----

	const {
		translateStreaming,
		translateError,
		translateSelection,
		toggleTranslatePin,
		discardUnpinnedTranslateOnClose,
		openTranslateSettings,
		clearTranslateError,
		stopTranslateSession: stopTranslateSessionImpl,
	} = usePdfSelectionTranslate({
		paperAbsPath,
		paperRelPath,
		vaultPath,
		onOpenSettings,
		translatesRef,
		protectedTranslateIdsRef,
		setTranslates,
		upsertTranslate,
		openCard,
		activeSessionRef,
	});
	stopTranslateSessionRef.current = stopTranslateSessionImpl;
	discardUnpinnedTranslateOnCloseRef.current = discardUnpinnedTranslateOnClose;
	clearTranslateErrorRef.current = clearTranslateError;

	// ---- Ask threads (AI Q&A on a selection, marks/<id>.json) ----

	const {
		streaming,
		askError,
		openThread,
		startFromAnchor,
		sendAskQuestion,
		resendAskQuestion,
		hideAskThread,
		deleteAskThread,
		stopAskStreaming,
		clearAskError,
		closeAskChrome,
	} = usePdfAskThreads({
		paperAbsPath,
		paperRelPath,
		vaultPath,
		threadsRef,
		setThreads,
		upsertThread,
		openCard,
		activeCardRef,
		setActiveCard,
		setCardScreen,
		activeSessionRef,
	});
	clearAskErrorRef.current = clearAskError;
	closeAskChromeRef.current = closeAskChrome;

	const {
		findOpen,
		findQuery,
		setFindQuery,
		findInputRef,
		findTotal,
		findActiveIndex,
		findNext,
		findPrev,
		closeFind,
	} = usePdfFind({ hostRef, search, searchState, scroll });

	const { outline, showOutline, toggleOutline } = usePdfOutline({
		bookmarkCap,
		docId,
		totalPages,
		paperAbsPath,
		paperRelPath,
	});

	const {
		showReferences,
		showFigures,
		hoveredCommentId,
		setHoveredCommentId,
		handleToggleOutline,
		handleToggleReferences,
		handleToggleFigures,
	} = usePdfSidebarPanels({ showOutline, toggleOutline });

	// ---- In-text citation / internal PDF links ----

	// Sibling clear refs so citation ↔ crossref can dismiss each other without
	// a circular hook dependency (Fix #430 overlay exclusivity).
	const clearCrossrefPreviewRef = useRef<() => void>(() => {});
	const clearCitationPreviewRef = useRef<() => void>(() => {});

	// Origin stack behind the "jump back" chip (#505).
	const {
		backTarget: jumpBackTarget,
		captureJumpOrigin,
		commitJumpOrigin,
		goBack: goBackToJumpOrigin,
	} = usePdfJumpBack({ docId });

	// Attention flash at the jump destination: reuse the citation focus flash
	// (amber hold + fade) over the destination line, so the reader sees where
	// the link landed. Destinations are point anchors, so the flash covers the
	// anchored row from the anchor x to the right margin.
	const flashJumpTarget = useCallback(
		(target: { pageIndex: number; pdfX: number | null; pdfY: number }) => {
			const page =
				docCapRef.current?.getDocument(docId)?.pages[target.pageIndex];
			if (!page) return;
			const yTop = 1 - target.pdfY / page.size.height;
			const anchorX =
				target.pdfX != null && Number.isFinite(target.pdfX)
					? Math.min(Math.max(target.pdfX / page.size.width - 0.005, 0.02), 0.9)
					: 0.05;
			// One text row tall; "text" keeps the header preview expansion off.
			const h = 0.022;
			const y = Math.min(Math.max(yTop - h / 2, 0), 1 - h);
			setFocusedLayoutRegion(
				docId,
				`jump:${target.pageIndex}:${target.pdfY.toFixed(1)}`,
				{
					pageIndex: target.pageIndex,
					bbox: { x: anchorX, y, w: Math.max(0.06, 0.95 - anchorX), h },
					kind: "text",
				},
				{ flash: true },
			);
		},
		[docId],
	);

	const {
		citationPreview,
		scheduleCitationHide,
		markCitationHoverEnter,
		clearCitationPreview,
		handleCitationLinkActivate,
		handleCitationLinkHover,
		hasCitationMatch,
		citationImport,
	} = usePdfCitations({
		docId,
		annotationCap,
		hostRef,
		zoomRef,
		vaultPath,
		paperPath: paperRelPath,
		paperAbsPath,
		sourceBytes,
		isRemotePaper,
		importIdentifier,
		onPreviewShow: () => clearCrossrefPreviewRef.current(),
		onBeforeInternalJump: captureJumpOrigin,
		onInternalJump: (target) => {
			// Same as the citation card: the scroll strands a stationary pointer,
			// so dismiss the crossref preview with the jump it caused (#528).
			clearCrossrefPreviewRef.current();
			commitJumpOrigin();
			flashJumpTarget(target);
		},
	});

	// Cross-reference (\ref) hover: preview the figure/table/equation crop,
	// or fallback destination crop for unmapped citations / internal links.
	// When structured metadata exists for a citation, hasCitationMatch suppresses
	// this preview in favor of the rich metadata card.
	const {
		crossrefPreview,
		scheduleCrossrefHide,
		markCrossrefHoverEnter,
		clearCrossrefPreview,
		handleCrossrefLinkHover,
	} = usePdfCrossrefPreview({
		docId,
		hostRef,
		zoomRef,
		paperAbsPath,
		sourceBytes,
		engineRef,
		docCapRef,
		onPreviewShow: () => clearCitationPreviewRef.current(),
		hasCitationMatch,
	});

	clearCitationPreviewRef.current = clearCitationPreview;
	clearCrossrefPreviewRef.current = clearCrossrefPreview;

	const { askPinAnchors } = usePdfPinAnchors({ threads });
	const pinnedTranslates = useStableDerived(
		() => translates.filter((record) => record.pinned),
		JSON.stringify(
			translates
				.filter((record) => record.pinned)
				.map((record) => [
					record.id,
					record.page,
					record.rects,
					record.quote || record.result || "",
				]),
		),
	);

	/**
	 * Gutter pins per page (1-based). Built once per mark/text change: pin
	 * placement walks the page's whole text-rect list, so doing it inside
	 * renderPage cost that walk for every mounted page on every scroll frame.
	 */
	const { pinsByPage, commentsByPage: commentsByPageBase } = useMemo(
		() =>
			buildMarksIndex({
				highlights,
				highlightAnchors,
				askPinAnchors,
				translates: pinnedTranslates,
				visualTraces,
				pageTextMap,
				paperTitle,
			}),
		[
			highlights,
			highlightAnchors,
			askPinAnchors,
			pinnedTranslates,
			visualTraces,
			pageTextMap,
			paperTitle,
		],
	);

	const {
		activeThread,
		activeTranslate,
		activeVisualTrace,
		activeAskAnchor,
		activeTranslateAnchor,
	} = usePdfActiveAnchors({ activeCard, threads, translates, visualTraces });

	// ---- Layout analysis ----
	const {
		layoutOverlayVisible,
		layoutRawRegions,
		hoverableRegionsByPage,
		rawRegionsByPage,
		startLayoutAnalysisRef,
		layoutTaskRef,
		handleAnalyzeLayout,
		handleJumpToLayoutRegion,
		handleRenderLayoutThumb,
		screenPointForRegion,
		layoutTranslateItemsByPage,
		layoutTranslatePageStateByPage,
		layoutTranslateRunning,
		layoutTranslateWaiting,
		layoutTranslateActive,
		layoutTranslateLabel,
		toggleLayoutTranslate,
		togglePageLayoutTranslate,
	} = usePdfLayoutCluster({
		docId,
		translationPane,
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
		isRemotePaper,
		plainViewer,
	});

	usePdfTranslationSelection({
		enabled: layoutTranslateActive && !translationOnly && !plainViewer,
		hostRef,
		zoomRef,
		engineRef,
		docCapRef,
		docId,
		itemsByPage: layoutTranslateItemsByPage,
		selectionMenu,
		setSelectionMenu,
		closeSelectionMenu,
		paperRelPath,
		paperAbsPath,
	});

	const handleToggleLayoutTranslateWithDualPane = useCallback(() => {
		if (plainViewer) return;
		if (displayMode !== "dualPane") {
			toggleLayoutTranslate();
			return;
		}
		// In dual-pane mode the source pane only opens the right-hand
		// translation panel. The translation pane itself owns the single
		// layout-translation job so only one task runs at a time. The receiver
		// resolves this back to a workspace tab, so pass the revision-stripped
		// base id (`docId` carries a `::r<n>` buffer suffix).
		if (dualPaneSource === "pdf") {
			onOpenTranslationTab?.(
				baseDocId,
				paperAbsPath ?? null,
				paperTitle ?? null,
			);
			return;
		}
		if (!paperAbsPath) {
			notifyError(t("pdf.latexTranslation.missingPaperPath"));
			return;
		}
		void openLatexTranslationTab(
			baseDocId,
			paperAbsPath,
			basenameOf(paperAbsPath),
		);
	}, [
		plainViewer,
		displayMode,
		dualPaneSource,
		toggleLayoutTranslate,
		onOpenTranslationTab,
		baseDocId,
		paperAbsPath,
		paperTitle,
		t,
	]);

	const applyJevHighlights = useCallback(
		(highlights: SuggestedHighlight[]) => {
			for (const h of highlights) {
				const width = h.pageWidth ?? 0;
				const height = h.pageHeight ?? 0;
				if (!width || !height || !h.rects.length) continue;
				const segmentRects: Rect[] = h.rects
					.map((r) => {
						const x = r.x ?? 0;
						const y = r.y ?? 0;
						const w = r.w ?? 0;
						const h_ = r.h ?? 0;
						return {
							origin: { x: x * width, y: y * height },
							size: { width: w * width, height: h_ * height },
						};
					})
					.filter((r) => r.size.width > 0 && r.size.height > 0);
				const first = segmentRects[0];
				const rect: Rect = segmentRects.slice(1).reduce(
					(acc, r) => ({
						origin: {
							x: Math.min(acc.origin.x, r.origin.x),
							y: Math.min(acc.origin.y, r.origin.y),
						},
						size: {
							width:
								Math.max(
									acc.origin.x + acc.size.width,
									r.origin.x + r.size.width,
								) - Math.min(acc.origin.x, r.origin.x),
							height:
								Math.max(
									acc.origin.y + acc.size.height,
									r.origin.y + r.size.height,
								) - Math.min(acc.origin.y, r.origin.y),
						},
					}),
					first,
				);
				const selection: FormattedSelection = {
					pageIndex: h.page - 1,
					rect,
					segmentRects,
				};
				createHighlights(
					[selection],
					normalizeHighlightColor(h.color),
					h.quote,
				);
			}
		},
		[createHighlights],
	);

	const [jevJobId, setJevJobId] = useState<string | null>(null);
	const smartHighlightBusy = jevJobId != null;

	useEffect(() => {
		if (!jevJobId) return;
		let active = true;
		const unlistenPromise = events.jobChanged.listen((event) => {
			if (!active) return;
			const job = event.payload.job;
			if (job.id !== jevJobId || job.kind !== "jevSmartHighlights") return;
			if (job.state === "succeeded") {
				const result = (
					job.params as {
						result?: { highlights?: SuggestedHighlight[] };
					} | null
				)?.result;
				const highlights = result?.highlights ?? [];
				applyJevHighlights(highlights);
				setJevJobId(null);
			} else if (job.state === "failed" || job.state === "cancelled") {
				const raw = job.error?.trim();
				const message =
					raw === "jevNoReadableText"
						? t("pdf.jevNoReadableText")
						: raw || t("pdf.smartHighlightFailed");
				notifyError(message);
				setJevJobId(null);
			}
		});
		return () => {
			active = false;
			void unlistenPromise.then((dispose) => dispose());
		};
	}, [jevJobId, applyJevHighlights, t]);

	const handleSmartHighlight = useCallback(async () => {
		if (!vaultPath || !paperRelPath) return;
		try {
			const snapshot = await callApiResult(() =>
				commands.jobJevSmartHighlightsEnqueue({
					vaultPath,
					path: paperRelPath,
				}),
			);
			setJevJobId(snapshot.id);
		} catch (err) {
			notifyError(errorText(err));
		}
	}, [vaultPath, paperRelPath]);

	// Translation pane: wait for the sidecar hydrate in usePdfLayoutTranslate
	// before deciding whether to start a job. Starting immediately races the
	// cache read and can kick off a duplicate full-document translate while the
	// second EmbedPDF instance is still parsing the PDF.
	const translationAutoStartedRef = useRef(false);
	const hadLayoutRegionsRef = useRef(false);
	const layoutTranslateActiveRef = useRef(layoutTranslateActive);
	layoutTranslateActiveRef.current = layoutTranslateActive;
	const layoutTranslateRunningRef = useRef(layoutTranslateRunning);
	layoutTranslateRunningRef.current = layoutTranslateRunning;
	useEffect(() => {
		if (!translationPane) return;
		const hasRegions = (layoutRawRegions?.length ?? 0) > 0;
		if (hasRegions) {
			hadLayoutRegionsRef.current = true;
		} else if (hadLayoutRegionsRef.current) {
			// Layout result was dropped (pane switched documents); allow retry.
			translationAutoStartedRef.current = false;
			hadLayoutRegionsRef.current = false;
		}
		if (!hasRegions) return;
		if (translationAutoStartedRef.current) return;
		// Hydrate already painted cached translations (or a running job).
		if (layoutTranslateActive || layoutTranslateRunning) {
			translationAutoStartedRef.current = true;
			return;
		}
		// Give the sidecar read time to land before starting network work.
		const timer = window.setTimeout(() => {
			if (translationAutoStartedRef.current) return;
			if (
				layoutTranslateActiveRef.current ||
				layoutTranslateRunningRef.current
			) {
				translationAutoStartedRef.current = true;
				return;
			}
			translationAutoStartedRef.current = true;
			toggleLayoutTranslate();
		}, 250);
		return () => window.clearTimeout(timer);
	}, [
		translationPane,
		layoutRawRegions,
		layoutTranslateActive,
		layoutTranslateRunning,
		toggleLayoutTranslate,
	]);

	// Drag-select and pin cards suppress ephemeral link previews so the pointer
	// cannot stack cards while sweeping across citation / crossref hit targets
	// (#430). Keep previews suppressed while the selection action menu remains
	// open so reference cards cannot stack on top of the selection controls.
	const suppressLinkPreviews =
		Boolean(activeCard) || Boolean(selectionMenu) || isSelecting;

	useEffect(() => {
		if (!suppressLinkPreviews) return;
		clearCitationPreview();
		clearCrossrefPreview();
	}, [suppressLinkPreviews, clearCitationPreview, clearCrossrefPreview]);

	const handleLinkHover = useCallback(
		(link: PdfLinkAnnoObject | null, clientPoint?: ScreenPoint | null) => {
			if (suppressLinkPreviews) {
				clearCitationPreview();
				clearCrossrefPreview();
				return;
			}
			handleCitationLinkHover(link, clientPoint);
			handleCrossrefLinkHover(link, clientPoint);
		},
		[
			suppressLinkPreviews,
			clearCitationPreview,
			clearCrossrefPreview,
			handleCitationLinkHover,
			handleCrossrefLinkHover,
		],
	);

	// ---- Visual marks (draft save, agent turns, existing pins) ----

	const beginRailEditRef = useRef<(state: RailEditState) => void>(
		() => undefined,
	);
	const {
		handleVisualDraft,
		updateVisualComment,
		handleVisualAddToChatById,
		deleteVisualTraceById,
	} = usePdfVisualMarks({
		paperAbsPath,
		paperRelPath,
		visualTracesRef,
		setVisualTraces,
		upsertVisualTrace,
		beginRailEditRef,
	});

	const anchorYForHighlight = useCallback(
		(id: string) => highlightAnchors.get(id)?.y ?? 0,
		[highlightAnchors],
	);

	const {
		railEdit,
		beginRailEdit,
		openEditorForAnnotation,
		closeRailEdit,
		saveRailEdit,
		deleteRailComment,
	} = usePdfNoteEditor({
		docId,
		annotationCap,
		anchorYForHighlight,
		rectsForHighlight: useCallback(
			(id: string) => {
				const rect = highlightAnchors.get(id);
				return rect ? [rect] : [];
			},
			[highlightAnchors],
		),
		updateHighlightComment,
		deleteHighlightAnnotation,
		updateVisualComment,
		deleteVisualTraceById,
	});
	closeEditorRef.current = () => {
		closeRailEdit();
	};
	beginRailEditRef.current = beginRailEdit;

	const commentsByPage = useMemo(() => {
		if (!railEdit) return commentsByPageBase;
		const page = railEdit.pageIndex + 1;
		const existing = commentsByPageBase.get(page);
		const alreadyListed = existing?.some((c) => c.id === railEdit.id);
		if (alreadyListed && !railEdit.isNew) return commentsByPageBase;
		if (alreadyListed && existing) {
			const next = new Map(commentsByPageBase);
			next.set(
				page,
				existing.map((comment) =>
					comment.id === railEdit.id ? { ...comment, isNew: true } : comment,
				),
			);
			return next;
		}
		const next = new Map(commentsByPageBase);
		next.set(page, [
			...(existing ?? []),
			{
				id: railEdit.id,
				pageIndex: railEdit.pageIndex,
				anchorY: railEdit.anchorY,
				rects: railEdit.rects,
				quote: railEdit.quote,
				comment: railEdit.comment,
				color: railEdit.color,
				kind: railEdit.kind,
				linkAlias: null,
				isNew: railEdit.isNew,
			},
		]);
		return next;
	}, [commentsByPageBase, railEdit]);

	const {
		handleOpenPin,
		handleEditHighlightAnnotation,
		handleDeleteHighlightAnnotation,
		handleChangeHighlightColor,
	} = usePdfMarkActions({
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
	});

	// ---- Region framing (⌘. marquee → crop) ----

	const {
		regionSelecting,
		visualCropPending,
		visualCropRegion,
		toggleRegionSelect,
		beginVisualAnnotation,
		handleVisualRegionSelect,
	} = usePdfRegionFraming({
		docId,
		engine,
		docCap,
		selectionCap,
		interactionCap,
		setSelectionMenu,
		onVisualDraft: handleVisualDraft,
		screenPointForRegion,
		plainViewer,
	});

	// ---- Selection action menu ----

	const {
		handleHighlight,
		handleCommitSelectionNote,
		handleMenuAsk,
		handleMenuAddToChat,
		handleMenuTranslate,
		handleMenuCopy,
	} = usePdfSelectionActions({
		selectionMenu,
		closeSelectionMenu,
		createHighlights,
		updateHighlightComment,
		docId,
		startFromAnchor,
		translateSelection,
		paperRelPath,
		paperAbsPath,
	});

	const autoTranslatedSelectionRef = useRef<string | null>(null);

	// A new drag-select is a fresh intent even when it covers text that was
	// already auto-translated: the anchor key alone would collide with the last
	// run and silently skip the new selection.
	useEffect(() => {
		if (isSelecting) autoTranslatedSelectionRef.current = null;
	}, [isSelecting]);

	// When enabled, translate as soon as text extraction has produced a usable
	// selection anchor. Keep the toolbar open so the other selection actions stay
	// available while the result card streams beside it.
	//
	// Keyed on the anchor, not on the menu object: re-placing the menu on scroll
	// replaces the object (its `screen` moved) while keeping the anchor, so a
	// menu-identity key re-translated once per wheel tick and stacked a 文A pin
	// per tick.
	useEffect(() => {
		// The translation overlay already has this sentence's translation.
		// Sending the recovered English back would open another translate card.
		if (selectionMenu?.fromTranslation) return;
		const anchorKey = selectionAnchorKey(selectionMenu?.anchor);
		if (
			!selectionMenu ||
			plainViewer ||
			!autoTranslateSelection ||
			!anchorKey
		) {
			autoTranslatedSelectionRef.current = null;
			return;
		}
		if (autoTranslatedSelectionRef.current === anchorKey) return;
		autoTranslatedSelectionRef.current = anchorKey;
		translateSelection(selectionMenu.anchor);
	}, [autoTranslateSelection, plainViewer, selectionMenu, translateSelection]);

	// Right-rail note for the current selection. Focusing the field clears the
	// browser selection, so the draft (and its veil) stay while the field is
	// engaged. A new gesture outside that field drops them.
	const [selectionCommentDraft, setSelectionCommentDraft] =
		useState<SelectionCommentDraft | null>(null);
	const selectionCommentDraftRef = useRef(selectionCommentDraft);
	selectionCommentDraftRef.current = selectionCommentDraft;
	const selectionMenuRef = useRef(selectionMenu);
	selectionMenuRef.current = selectionMenu;
	const selectionCommentKeyValue = selectionCommentKey(selectionMenu);

	useEffect(() => {
		if (isRemotePaper || plainViewer || regionSelecting) {
			selectionCommentEngagedRef.current = false;
			setSelectionCommentDraft(null);
			return;
		}
		const menu = selectionMenuRef.current;
		if (selectionCommentKeyValue && menu) {
			const visible = selectionAnchorFromVisible(menu.visiblePages ?? []);
			setSelectionCommentDraft({
				page: visible?.page ?? menu.anchor.page,
				anchorY: visible?.anchorY ?? menu.anchor.rects[0]?.y ?? 0,
				quote: menu.anchor.quote ?? "",
				pages: menu.pages,
				visiblePages: menu.visiblePages,
			});
			return;
		}
		if (!selectionCommentEngagedRef.current) {
			setSelectionCommentDraft(null);
		}
	}, [isRemotePaper, plainViewer, regionSelecting, selectionCommentKeyValue]);

	const handleSelectionCommentActiveChange = useCallback((active: boolean) => {
		selectionCommentEngagedRef.current = active;
	}, []);

	const handleDismissSelectionComment = useCallback(() => {
		selectionCommentEngagedRef.current = false;
		setSelectionCommentDraft(null);
		closeSelectionMenu();
	}, [closeSelectionMenu]);

	const handleCommitSelectionComment = useCallback(
		(comment: string) => {
			const draft = selectionCommentDraftRef.current;
			selectionCommentEngagedRef.current = false;
			selectionCommentDraftRef.current = null;
			setSelectionCommentDraft(null);
			closeSelectionMenu();
			if (!draft?.pages.length) return;
			handleCommitSelectionNote(
				{
					pages: draft.pages,
					quote: draft.quote,
					visiblePages: draft.visiblePages,
				},
				comment,
			);
		},
		[handleCommitSelectionNote, closeSelectionMenu],
	);

	// ---- In-PDF highlight selection menu ----

	// Scrolling means the reader moved on, so a translate card is dismissed
	// rather than dragged along. Pointer wander alone must never close it,
	// which is why the hover timer holds translate cards open.
	//
	// Gated on the pin actually moving: scroll events also fire when the
	// listener is (re)subscribed and from EmbedPDF's selection/layout churn
	// right after the card opens, and those must not flash the card away.
	const rePlaceFloatingOnScroll = useCallback(() => {
		const pinMoved = rePlaceActiveCardOnScroll();
		if (pinMoved && activeCard?.kind === "translate") {
			hideActiveCard();
		}
		rePlaceSelectionMenu();
	}, [
		activeCard,
		rePlaceActiveCardOnScroll,
		rePlaceSelectionMenu,
		hideActiveCard,
	]);

	// Boolean only — do not depend on selectionMenu.screen or re-place loops.
	const selectionMenuOpen = selectionMenu != null;

	// Re-anchor the active pin modal and the text-selection toolbar on scroll +
	// zoom. zoomLevel forces re-placement after zoom. Use scrollReady (boolean)
	// — not `scroll` — because EmbedPDF returns a new scope object every render;
	// depending on it re-fired this effect → setCardScreen → re-render →
	// Maximum update depth when a modal card was open.
	// Native wheel scroll is handled by ActiveCardScrollSync (viewport element).
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrollReady/zoomLevel are intentional re-place triggers
	useEffect(() => {
		if (!activeCard && !selectionMenuOpen) return;
		// Force re-place after zoom / card change even if rounded coords match.
		if (activeCard) {
			cardScreenRef.current = null;
			placeActiveCard(activeCard);
		}
		if (selectionMenuOpen) rePlaceSelectionMenu();
		let raf: number | null = null;
		const rePlace = () => {
			if (raf != null) return;
			raf = requestAnimationFrame(() => {
				raf = null;
				rePlaceFloatingOnScroll();
			});
		};
		const scrollScope = scrollRef.current;
		const offPlugin = scrollScope?.onScroll(rePlace) ?? (() => undefined);
		return () => {
			if (raf != null) cancelAnimationFrame(raf);
			offPlugin();
		};
	}, [
		activeCard,
		selectionMenuOpen,
		scrollReady,
		placeActiveCard,
		zoomLevel,
		rePlaceFloatingOnScroll,
		rePlaceSelectionMenu,
	]);

	usePdfViewerHandle({
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
		openCard,
		deleteVisualTraceById,
		toggleRegionSelect,
		// Dual-pane aware — ⌥A and the toolbar Languages button share this path.
		toggleLayoutTranslate: handleToggleLayoutTranslateWithDualPane,
	});

	const {
		quotesByPage: highlightQuotesByPage,
		translatedByPage: translatedHighlightsByPage,
	} = useMemo(() => partitionHighlightPaint(highlights), [highlights]);

	const sentenceRectsByItemId = useSentenceGlyphRects({
		engine,
		docCapRef,
		docId,
		itemsByPage: layoutTranslateItemsByPage,
		highlightQuotesByPage,
	});

	const pageMarks = useMemo<PdfPageMarksSlice>(
		() => ({
			activeAskAnchor,
			activeTranslateAnchor,
			activeVisualTrace,
			visualDraftRegion: null,
			visualCropRegion,
			focusedLayoutRegion,
			focusedLayoutFlash,
			focusedLayoutFlashToken,
			pinsByPage,
			commentsByPage,
			editingCommentId: railEdit?.id ?? null,
			commentWikiTarget,
			citationLinks,
			textLinks,
			activeCardId: activeCard?.id ?? null,
			hoveredCommentId,
			selectionCommentDraft,
			translateHighlightsByPage,
			highlightQuotesByPage,
			translatedHighlightsByPage,
		}),
		[
			activeAskAnchor,
			activeTranslateAnchor,
			activeVisualTrace,
			visualCropRegion,
			focusedLayoutRegion,
			focusedLayoutFlash,
			focusedLayoutFlashToken,
			pinsByPage,
			commentsByPage,
			railEdit?.id,
			commentWikiTarget,
			citationLinks,
			textLinks,
			activeCard?.id,
			hoveredCommentId,
			selectionCommentDraft,
			translateHighlightsByPage,
			highlightQuotesByPage,
			translatedHighlightsByPage,
		],
	);

	const pageLayout = useMemo<PdfPageLayoutSlice>(
		() => ({
			hoverableRegionsByPage,
			rawRegionsByPage,
			layoutOverlayVisible,
			layoutTranslateItemsByPage:
				translationPane || !dualPaneTranslate
					? layoutTranslateItemsByPage
					: new Map(),
			layoutTranslatePageStateByPage:
				translationPane || !dualPaneTranslate
					? layoutTranslatePageStateByPage
					: new Map(),
			sentenceRectsByItemId,
		}),
		[
			hoverableRegionsByPage,
			rawRegionsByPage,
			layoutOverlayVisible,
			layoutTranslateItemsByPage,
			layoutTranslatePageStateByPage,
			translationPane,
			dualPaneTranslate,
			sentenceRectsByItemId,
		],
	);

	const pageMode = useMemo<PdfPageModeSlice>(
		() => ({
			regionSelecting,
			visualCropPending,
			visualDraftOpen: false,
			translationOnly,
			plainViewer,
		}),
		[regionSelecting, visualCropPending, translationOnly, plainViewer],
	);

	const handleLayoutRegionClick = useCallback(
		(region: PdfLayoutRegion) => {
			void beginVisualAnnotation(region.pageIndex + 1, region.bbox);
		},
		[beginVisualAnnotation],
	);

	const handleCopyCommentLink = useCallback(
		(comment: PageAnnotationComment) => {
			if (!commentWikiTarget) return;
			void copyTextToClipboard(
				annotationWikilinkMarkdown({
					target: commentWikiTarget,
					id: comment.id,
					...(comment.linkAlias ? { alias: comment.linkAlias } : {}),
				}),
				{ successMessage: t("annotations.linkCopied") },
			);
		},
		[commentWikiTarget, t],
	);

	const handleCopyCommentEmbed = useCallback(
		(comment: PageAnnotationComment) => {
			if (!commentWikiTarget) return;
			void copyTextToClipboard(
				annotationWikilinkMarkdown({
					target: commentWikiTarget,
					id: comment.id,
					embed: true,
					...(comment.linkAlias ? { alias: comment.linkAlias } : {}),
				}),
				{ successMessage: t("annotations.embedCopied") },
			);
		},
		[commentWikiTarget, t],
	);

	const handleAddCommentToChat = useCallback(
		(comment: PageAnnotationComment) => {
			if (comment.kind !== "visual") return;
			handleVisualAddToChatById(comment.id);
		},
		[handleVisualAddToChatById],
	);

	const pageHandlers = useMemo<PdfPageHandlers>(
		() => ({
			onOpenPin: handleOpenPin,
			onCardHoverEnter: markCardHoverEnter,
			onCardHoverLeave: scheduleHoverHide,
			onCitationActivate: handleCitationLinkActivate,
			onTextLinkActivate: openExternalUrl,
			onCitationHover: handleLinkHover,
			onRegionSelect: handleVisualRegionSelect,
			onLayoutRegionClick: handleLayoutRegionClick,
			onTogglePageLayoutTranslate: togglePageLayoutTranslate,
			onDeleteHighlightAnnotation: handleDeleteHighlightAnnotation,
			onEditHighlightAnnotation: handleEditHighlightAnnotation,
			onChangeHighlightColor: handleChangeHighlightColor,
			onOpenComment: (comment) => beginRailEdit(railEditFromComment(comment)),
			onSaveComment: saveRailEdit,
			onCancelComment: closeRailEdit,
			onDeleteComment: deleteRailComment,
			onCopyCommentLink: handleCopyCommentLink,
			onCopyCommentEmbed: handleCopyCommentEmbed,
			onAddCommentToChat: handleAddCommentToChat,
			onHoverComment: (comment) => setHoveredCommentId(comment.id),
			onLeaveComment: () => setHoveredCommentId(null),
			onCommitSelectionComment: handleCommitSelectionComment,
			onSelectionCommentActiveChange: handleSelectionCommentActiveChange,
			onDismissSelectionComment: handleDismissSelectionComment,
		}),
		[
			handleOpenPin,
			markCardHoverEnter,
			scheduleHoverHide,
			handleCitationLinkActivate,
			handleLinkHover,
			handleVisualRegionSelect,
			handleLayoutRegionClick,
			togglePageLayoutTranslate,
			handleDeleteHighlightAnnotation,
			handleEditHighlightAnnotation,
			handleChangeHighlightColor,
			beginRailEdit,
			saveRailEdit,
			closeRailEdit,
			deleteRailComment,
			handleCopyCommentLink,
			handleCopyCommentEmbed,
			handleAddCommentToChat,
			setHoveredCommentId,
			handleCommitSelectionComment,
			handleSelectionCommentActiveChange,
			handleDismissSelectionComment,
		],
	);

	/**
	 * Page renderer for the Scroller. The layer stack is a memo component so a
	 * scroller-layout-only re-render (which calls this for every mounted page)
	 * can bail out instead of rebuilding ten page subtrees.
	 */
	const renderPage = useCallback(
		({ pageIndex, width, height, rotatedWidth, rotatedHeight }: PageLayout) => (
			<PdfPageLayers
				annotationSource={paperRelPath ?? paperAbsPath ?? undefined}
				docId={docId}
				pageIndex={pageIndex}
				width={rotatedWidth || width}
				height={rotatedHeight || height}
				tone={pdfTone}
				zoomRef={zoomRef}
				annotationCap={annotationCap}
				marks={pageMarks}
				layout={pageLayout}
				mode={pageMode}
				handlers={pageHandlers}
			/>
		),
		[
			docId,
			paperRelPath,
			paperAbsPath,
			pdfTone,
			zoomRef,
			annotationCap,
			pageMarks,
			pageLayout,
			pageMode,
			pageHandlers,
		],
	);

	// ---- Left toolbar auto show/hide (#400); right toolbar stays pinned ----
	const leftChromeVisible = usePdfChromeVisibility({
		hostRef,
		scrollRef,
		scrollReady,
		sticky: showOutline || showReferences || showFigures || findOpen,
	});

	return (
		<div
			ref={hostRef}
			className="relative flex h-full min-h-0 w-full select-none flex-col"
		>
			{!translationOnly && (
				<PdfLeftToolbar
					outline={outline}
					showOutline={showOutline}
					onToggleOutline={handleToggleOutline}
					paperPath={paperRelPath}
					showReferences={showReferences}
					onToggleReferences={handleToggleReferences}
					showFigures={showFigures}
					onToggleFigures={handleToggleFigures}
					visible={leftChromeVisible}
					isRemotePaper={isRemotePaper}
					plainViewer={plainViewer}
				/>
			)}
			{!translationOnly && jumpBackTarget && (
				<PdfJumpBackChip onGoBack={goBackToJumpOrigin} />
			)}
			{!translationOnly && (
				<PdfOutlinePanel
					outline={outline}
					showOutline={showOutline}
					onGoToPage={goToPage}
				/>
			)}
			{!translationOnly && (
				<PdfReferencesPanel
					vaultPath={vaultPath}
					paperPath={paperRelPath}
					showReferences={showReferences}
				/>
			)}
			{!translationOnly && !plainViewer && (
				<PdfFiguresPanel
					documentId={docId}
					paperAbsPath={paperAbsPath}
					paperRelPath={paperRelPath}
					showFigures={showFigures}
					isRemotePaper={isRemotePaper}
					onAnalyze={handleAnalyzeLayout}
					onJump={handleJumpToLayoutRegion}
					onRenderThumb={handleRenderLayoutThumb}
				/>
			)}
			{!translationOnly && (
				<PdfFindBar
					open={findOpen}
					inputRef={findInputRef}
					query={findQuery}
					onQueryChange={setFindQuery}
					total={findTotal}
					activeResultIndex={findActiveIndex}
					onFindNext={findNext}
					onFindPrev={findPrev}
					onClose={closeFind}
				/>
			)}
			{!translationOnly && !plainViewer && (
				<PdfToolbar
					regionSelecting={regionSelecting}
					visualCropPending={visualCropPending}
					engine={engine}
					onToggleRegionSelect={toggleRegionSelect}
					layoutTranslateRunning={layoutTranslateRunning}
					layoutTranslateWaiting={layoutTranslateWaiting}
					layoutTranslateActive={layoutTranslateActive}
					layoutTranslateLabel={layoutTranslateLabel}
					onToggleLayoutTranslate={handleToggleLayoutTranslateWithDualPane}
					isRemotePaper={isRemotePaper}
					onImportToLibrary={handleImportToLibrary}
					importBusy={importBusy}
					smartHighlightBusy={smartHighlightBusy}
					onSmartHighlight={
						smartHighlightEnabled ? handleSmartHighlight : undefined
					}
				/>
			)}

			<DockviewViewport
				documentId={docId}
				hostRef={hostRef}
				rightGutter={translationOnly || plainViewer ? 0 : COMMENT_RAIL_WIDTH_PX}
				className="agentero-scroll-both min-h-0 min-w-0 flex-1"
			>
				<WheelZoomHandler docId={docId} />
				<PanDragHandler
					active={isActive}
					hostRef={hostRef}
					allowLeftDrag={!translationOnly && !regionSelecting}
				/>
				<ActiveCardScrollSync
					active={Boolean(activeCard) || Boolean(selectionMenu)}
					onScroll={rePlaceFloatingOnScroll}
				/>
				{/* Ctrl+wheel and trackpad pinch are handled by WheelZoomHandler (WebKit
				    pinch arrives as GestureEvents, not ctrl+wheel); EmbedPDF's built-in
				    wheel zoom is disabled because its per-tick scale factor collapses
				    the zoom on a single mouse notch, and its enablePinch only covers
				    touch devices. */}
				<ZoomGestureWrapper documentId={docId} enableWheel={false}>
					<GlobalPointerProvider documentId={docId}>
						<Scroller documentId={docId} renderPage={renderPage} />
					</GlobalPointerProvider>
				</ZoomGestureWrapper>
			</DockviewViewport>

			{!translationOnly && (
				<PdfCardStack
					selectionMenu={{
						state: plainViewer ? null : selectionMenu,
						onHighlight: handleHighlight,
						onAsk: handleMenuAsk,
						onAddToChat: handleMenuAddToChat,
						onTranslate: handleMenuTranslate,
						onCopy: handleMenuCopy,
						showHighlight: !isRemotePaper && !plainViewer,
						showTranslate:
							!selectionMenu?.fromTranslation && !isRemotePaper && !plainViewer,
					}}
					citationPreview={{
						state: citationPreview,
						importMenu: citationImport
							? {
									folders: citationImport.folders,
									lastImportParentDir: citationImport.lastImportParentDir,
									importingId: citationImport.importingId,
									onImport: citationImport.importCitation,
									onOpenChange: (open) =>
										open ? markCitationHoverEnter() : scheduleCitationHide(),
									remotePaper: isRemotePaper,
								}
							: undefined,
						onHoverEnter: markCitationHoverEnter,
						onHoverLeave: scheduleCitationHide,
					}}
					crossrefPreview={{
						state: crossrefPreview,
						onHoverEnter: markCrossrefHoverEnter,
						onHoverLeave: scheduleCrossrefHide,
					}}
					cardScreen={cardScreen}
					onCardHoverEnter={markCardHoverEnter}
					onCardHoverLeave={scheduleHoverHide}
					ask={{
						thread: activeThread,
						paperTitle,
						paperLink,
						streaming,
						error: askError,
						onSend: sendAskQuestion,
						onResend: resendAskQuestion,
						onHide: hideAskThread,
						onDelete: deleteAskThread,
						onStop: stopAskStreaming,
					}}
					translate={{
						record: activeTranslate,
						streaming: translateStreaming,
						error: translateError,
						onOpenSettings: openTranslateSettings,
						onTogglePin:
							paperAbsPath && activeTranslate?.rects.length
								? () => {
										if (activeTranslate) toggleTranslatePin(activeTranslate);
									}
								: undefined,
						onHide: hideActiveCard,
					}}
					visual={{
						trace: activeVisualTrace,
						onHide: hideActiveCard,
						onDelete: () => {
							if (activeVisualTrace)
								deleteVisualTraceById(activeVisualTrace.id);
						},
					}}
				/>
			)}

			{!translationOnly && (
				<PdfBottomBar
					totalPages={totalPages}
					pageField={pageField}
					onPageFieldChange={setPageField}
					pageFocusedRef={pageFocusedRef}
					onCommitPageField={commitPageField}
					pdfTone={pdfTone}
					onSetPdfTone={setPdfTone}
					zoomLevel={zoomLevel}
					onZoomChange={(next) => zoom?.requestZoom(next)}
					isRemotePaper={isRemotePaper}
				/>
			)}
		</div>
	);
}
