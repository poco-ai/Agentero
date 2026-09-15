import { createPluginRegistration } from "@embedpdf/core";
import { EmbedPDF } from "@embedpdf/core/react";
import type { PdfLinkAnnoObject } from "@embedpdf/models";
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
	Scroller,
	ScrollPluginPackage,
	useScroll,
} from "@embedpdf/plugin-scroll/react";
import { SearchPluginPackage, useSearch } from "@embedpdf/plugin-search/react";
import {
	SelectionPluginPackage,
	useSelectionCapability,
} from "@embedpdf/plugin-selection/react";
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
import { usePdfPrivacy } from "@/components/viewer/pdf/hooks/use-pdf-privacy";
import { usePdfRegionFraming } from "@/components/viewer/pdf/hooks/use-pdf-region-framing";
import { usePdfScrollSync } from "@/components/viewer/pdf/hooks/use-pdf-scroll-sync";
import { usePdfSelectionActions } from "@/components/viewer/pdf/hooks/use-pdf-selection-actions";
import { usePdfSelectionTranslate } from "@/components/viewer/pdf/hooks/use-pdf-selection-translate";
import { usePdfSidebarPanels } from "@/components/viewer/pdf/hooks/use-pdf-sidebar-panels";
import { usePdfTextSelection } from "@/components/viewer/pdf/hooks/use-pdf-text-selection";
import { usePdfViewerHandle } from "@/components/viewer/pdf/hooks/use-pdf-viewer-handle";
import { usePdfVisualMarks } from "@/components/viewer/pdf/hooks/use-pdf-visual-marks";
import { usePdfZoomControls } from "@/components/viewer/pdf/hooks/use-pdf-zoom-controls";
import { excludeOverlappingPdfTextLinks } from "@/components/viewer/pdf/layers/citation-links";
import { COMMENT_RAIL_WIDTH_PX } from "@/components/viewer/pdf/layers/comment-cards-layer";
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
	SelectionCommentDraft,
} from "@/components/viewer/pdf/types";
import { ActiveCardScrollSync } from "@/components/viewer/pdf/viewport/active-card-scroll-sync";
import { DockviewViewport } from "@/components/viewer/pdf/viewport/dockview-viewport";
import { PanDragHandler } from "@/components/viewer/pdf/viewport/pan-handler";
import { WheelZoomHandler } from "@/components/viewer/pdf/viewport/wheel-zoom-handler";
import { useLibraryStore, useSettings } from "@/hooks/use-app-stores";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { errorText } from "@/lib/core/error";
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
import { HIGHLIGHT_HEX_LIST } from "@/lib/pdf/highlight/palette";
import {
	getPdfAiRuntime,
	layoutAnalysisStore,
	type PdfLayoutRegion,
	setFocusedLayoutRegion,
} from "@/lib/pdf/layout";
import type { ActiveSelectionCard } from "@/lib/pdf/selection";
import { PDF_ZOOM_MAX, PDF_ZOOM_MIN } from "@/lib/pdf/zoom";

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
	const docId =
		props.docId?.trim() ||
		props.paperRelPath ||
		props.paperAbsPath ||
		source ||
		"pdf";

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
		const core = [
			createPluginRegistration(DocumentManagerPluginPackage, {
				initialDocuments: [initialDocument],
			}),
			createPluginRegistration(ViewportPluginPackage),
			createPluginRegistration(ScrollPluginPackage, {
				// Manifest default (4) keeps ~8 off-screen pages mounted, and every
				// mounted page re-renders whenever the scroller layout changes.
				defaultBufferSize: translationOnly ? 1 : 2,
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
								sourceBytes={effectiveSourceBytes}
							/>
						) : (
							<PdfViewerInner
								{...props}
								docId={docId}
								sourceBytes={effectiveSourceBytes}
							/>
						);
					}}
				</DocumentContent>
			</EmbedPDF>
		</div>
	);
});

function PdfViewerInner({
	docId,
	sourceBytes = null,
	paperAbsPath = null,
	paperRelPath = null,
	vaultPath = null,
	paperMeta: paperMetaProp = null,
	isActive = true,
	isRemotePaper = false,
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
	const privacyHidden = usePdfPrivacy();
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
		const result = s.byDocument[docId];
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
	const dualPaneTranslate = useSettings((s) => s.translate.dualPaneTranslate);
	const paperMeta = useMemo(() => {
		if (paperMetaProp) return paperMetaProp;
		if (!paperRelPath) return undefined;
		const key = paperRelPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		return paperMetaByRelPath.get(key);
	}, [paperMetaProp, paperRelPath, paperMetaByRelPath]);
	const paperTitle = paperMeta?.title;
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
	/**
	 * Mirror of the translate cluster's `translateStreaming`. Created here (not in
	 * {@link usePdfSelectionTranslate}) because `usePdfCards` is declared first and
	 * needs the same ref object to keep a streaming translate card alive.
	 */
	const translateStreamingRef = useRef(false);

	const hostRef = useRef<HTMLDivElement>(null);

	// ---- Text selection → floating action menu ----
	// Placed after hostRef/zoomRef: the hook anchors the menu against the page
	// element and needs both refs injected.
	const {
		selectionMenu,
		setSelectionMenu,
		isSelecting,
		closeSelectionMenu,
		rePlaceSelectionMenu,
		copiedLabelPos,
	} = usePdfTextSelection({
		selectionCap,
		docCap,
		docId,
		hostRef,
		zoomRef,
		isActive,
		paperRelPath,
		paperAbsPath,
	});

	/**
	 * Session token of the single in-flight PDF agent run. Shared by ask and
	 * translate (either can cancel the other's run), so it stays in the parent and
	 * is injected into both clusters.
	 */
	const activeSessionRef = useRef<string | null>(null);

	/**
	 * `usePdfCards` must be declared before the ask and translate clusters (both
	 * open and hide cards), but cards also reset per-kind card chrome and cancel a
	 * running translate. Those edges go through refs assigned right after each
	 * hook, so `openCard` / `hideActiveCard` keep their identity.
	 */
	const stopTranslateSessionRef = useRef<() => void>(() => undefined);
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
			if (card?.kind === "translate") clearTranslateErrorRef.current();
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
		cardHoverSurfaceRef,
	} = usePdfCards({
		hostRef,
		pageTextMapRef,
		threadsRef,
		translatesRef,
		visualTracesRef,
		translateStreamingRef,
		onCardOpen: resetChromeForOpenedCard,
		onCardClose: resetChromeForClosedCard,
		stopTranslateSession,
	});

	// ---- Selection → 翻译 (ephemeral card + marks/<id>.json) ----

	const {
		translateStreaming,
		translateError,
		translateSelection,
		deleteTranslateCard,
		openTranslateSettings,
		clearTranslateError,
		stopTranslateSession: stopTranslateSessionImpl,
	} = usePdfSelectionTranslate({
		paperAbsPath,
		paperRelPath,
		vaultPath,
		onOpenSettings,
		translatesRef,
		setTranslates,
		upsertTranslate,
		activeCard,
		openCard,
		hideActiveCard,
		scheduleHoverHide,
		cardHoverSurfaceRef,
		activeCardRef,
		activeSessionRef,
		translateStreamingRef,
	});
	stopTranslateSessionRef.current = stopTranslateSessionImpl;
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

	// Cross-reference (\ref) hover: preview the figure/table/equation crop.
	// Reuses the same dest-map parse (cached per PDF); a link coordinate is
	// either a cite.* or a cross-ref destination, so both hover handlers run
	// on every link and at most one card shows.
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
	});

	clearCitationPreviewRef.current = clearCitationPreview;
	clearCrossrefPreviewRef.current = clearCrossrefPreview;

	const { askPinAnchors, translatePinAnchors } = usePdfPinAnchors({
		threads,
		translates,
	});

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
				translatePinAnchors,
				visualTraces,
				pageTextMap,
				paperTitle,
			}),
		[
			highlights,
			highlightAnchors,
			askPinAnchors,
			translatePinAnchors,
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
	});

	const handleToggleLayoutTranslateWithDualPane = useCallback(() => {
		if (!dualPaneTranslate) {
			toggleLayoutTranslate();
			return;
		}
		// In dual-pane mode the source pane only opens the right-hand
		// translation panel. The translation pane itself owns the single
		// layout-translation job so only one task runs at a time.
		onOpenTranslationTab?.(docId, paperAbsPath ?? null, paperTitle ?? null);
	}, [
		dualPaneTranslate,
		toggleLayoutTranslate,
		onOpenTranslationTab,
		docId,
		paperAbsPath,
		paperTitle,
	]);

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
		(link: PdfLinkAnnoObject | null) => {
			if (suppressLinkPreviews) {
				clearCitationPreview();
				clearCrossrefPreview();
				return;
			}
			handleCitationLinkHover(link);
			handleCrossrefLinkHover(link);
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
		if (existing?.some((c) => c.id === railEdit.id)) return commentsByPageBase;
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
	});

	// ---- Selection action menu ----

	const {
		handleHighlight,
		handleCommitSelectionNote,
		handleMenuAsk,
		handleMenuAddToChat,
		handleMenuTranslate,
	} = usePdfSelectionActions({
		selectionMenu,
		setSelectionMenu,
		closeSelectionMenu,
		createHighlights,
		updateHighlightComment,
		selectionCap,
		docId,
		startFromAnchor,
		translateSelection,
		paperRelPath,
		paperAbsPath,
	});

	const autoTranslatedSelectionRef = useRef<typeof selectionMenu>(null);

	// When enabled, translate as soon as text extraction has produced a usable
	// selection anchor. Keep the toolbar open so the other selection actions stay
	// available while the result card streams beside it.
	useEffect(() => {
		const quote = selectionMenu?.anchor.quote?.trim();
		if (!selectionMenu || !autoTranslateSelection || !quote) {
			autoTranslatedSelectionRef.current = null;
			return;
		}
		if (autoTranslatedSelectionRef.current === selectionMenu) return;
		autoTranslatedSelectionRef.current = selectionMenu;
		translateSelection(selectionMenu.anchor);
	}, [autoTranslateSelection, selectionMenu, translateSelection]);

	// Sticky right-rail annotate chip. Hover focuses the field and EmbedPDF may
	// clear the live selection; keep the snapped draft after the chip has been
	// interacted with so leave-empty can collapse back to the icon card.
	const [selectionCommentDraft, setSelectionCommentDraft] =
		useState<SelectionCommentDraft | null>(null);
	const selectionCommentInteractedRef = useRef(false);

	useEffect(() => {
		if (isRemotePaper) {
			selectionCommentInteractedRef.current = false;
			setSelectionCommentDraft(null);
			return;
		}
		if (selectionMenu) {
			selectionCommentInteractedRef.current = false;
			setSelectionCommentDraft({
				page: selectionMenu.anchor.page,
				anchorY: selectionMenu.anchor.rects[0]?.y ?? 0,
				quote: selectionMenu.anchor.quote ?? "",
				pages: selectionMenu.pages,
			});
			return;
		}
		if (!selectionCommentInteractedRef.current) {
			setSelectionCommentDraft(null);
		}
	}, [isRemotePaper, selectionMenu]);

	const handleSelectionCommentActiveChange = useCallback((active: boolean) => {
		if (active) selectionCommentInteractedRef.current = true;
	}, []);

	const handleDismissSelectionComment = useCallback(() => {
		selectionCommentInteractedRef.current = false;
		setSelectionCommentDraft(null);
	}, []);

	const handleCommitSelectionComment = useCallback(
		(comment: string) => {
			const draft = selectionCommentDraft;
			selectionCommentInteractedRef.current = false;
			setSelectionCommentDraft(null);
			if (!draft) return;
			handleCommitSelectionNote(
				{ pages: draft.pages, quote: draft.quote },
				comment,
			);
		},
		[selectionCommentDraft, handleCommitSelectionNote],
	);

	// ---- In-PDF highlight selection menu ----

	const rePlaceFloatingOnScroll = useCallback(() => {
		rePlaceActiveCardOnScroll();
		rePlaceSelectionMenu();
	}, [rePlaceActiveCardOnScroll, rePlaceSelectionMenu]);

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
		}),
		[
			hoverableRegionsByPage,
			rawRegionsByPage,
			layoutOverlayVisible,
			layoutTranslateItemsByPage,
			layoutTranslatePageStateByPage,
			translationPane,
			dualPaneTranslate,
		],
	);

	const pageMode = useMemo<PdfPageModeSlice>(
		() => ({
			regionSelecting,
			visualCropPending,
			visualDraftOpen: false,
			translationOnly,
		}),
		[regionSelecting, visualCropPending, translationOnly],
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
		({
			pageIndex,
			width,
			height,
		}: {
			pageIndex: number;
			width: number;
			height: number;
		}) => (
			<PdfPageLayers
				docId={docId}
				pageIndex={pageIndex}
				width={width}
				height={height}
				tone={pdfTone}
				zoomRef={zoomRef}
				annotationCap={annotationCap}
				marks={pageMarks}
				layout={pageLayout}
				mode={pageMode}
				handlers={pageHandlers}
				hidden={privacyHidden}
			/>
		),
		[
			docId,
			pdfTone,
			zoomRef,
			annotationCap,
			pageMarks,
			pageLayout,
			pageMode,
			pageHandlers,
			privacyHidden,
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
			{!translationOnly && (
				<PdfFiguresPanel
					documentId={docId}
					paperAbsPath={paperAbsPath}
					paperRelPath={paperRelPath}
					showFigures={showFigures}
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
			{!translationOnly && (
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
				/>
			)}

			<DockviewViewport
				documentId={docId}
				hostRef={hostRef}
				rightGutter={translationOnly ? 0 : COMMENT_RAIL_WIDTH_PX}
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
					hidden={privacyHidden}
					selectionMenu={{
						state: selectionMenu,
						onHighlight: handleHighlight,
						onAsk: handleMenuAsk,
						onAddToChat: handleMenuAddToChat,
						onTranslate: handleMenuTranslate,
						showHighlight: !isRemotePaper,
						showTranslate: !isRemotePaper,
					}}
					copiedLabelPos={copiedLabelPos}
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
						onHide: hideActiveCard,
						onDelete: deleteTranslateCard,
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
