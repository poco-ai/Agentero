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
import { PdfLeftToolbar } from "@/components/viewer/pdf/chrome/pdf-left-toolbar";
import { PdfOutlinePanel } from "@/components/viewer/pdf/chrome/pdf-outline-panel";
import { PdfReferencesPanel } from "@/components/viewer/pdf/chrome/pdf-references-panel";
import { PdfToolbar } from "@/components/viewer/pdf/chrome/pdf-toolbar";

import { usePdfEngineContext } from "@/components/viewer/pdf/engine-provider";
import { usePdfAskThreads } from "@/components/viewer/pdf/hooks/use-pdf-ask-threads";
import { usePdfCards } from "@/components/viewer/pdf/hooks/use-pdf-cards";
import { usePdfChromeVisibility } from "@/components/viewer/pdf/hooks/use-pdf-chrome-visibility";
import { usePdfCitations } from "@/components/viewer/pdf/hooks/use-pdf-citations";
import { usePdfColorScheme } from "@/components/viewer/pdf/hooks/use-pdf-color-scheme";
import { usePdfCrossrefPreview } from "@/components/viewer/pdf/hooks/use-pdf-crossref-preview";
import { usePdfFind } from "@/components/viewer/pdf/hooks/use-pdf-find";
import { usePdfHighlights } from "@/components/viewer/pdf/hooks/use-pdf-highlights";
import { usePdfLayoutRegions } from "@/components/viewer/pdf/hooks/use-pdf-layout-regions";
import { usePdfLayoutRun } from "@/components/viewer/pdf/hooks/use-pdf-layout-run";
import { usePdfLayoutTranslate } from "@/components/viewer/pdf/hooks/use-pdf-layout-translate";
import { usePdfMarksIo } from "@/components/viewer/pdf/hooks/use-pdf-marks-io";
import { usePdfNavigation } from "@/components/viewer/pdf/hooks/use-pdf-navigation";
import {
	railEditFromComment,
	usePdfNoteEditor,
} from "@/components/viewer/pdf/hooks/use-pdf-note-editor";
import { usePdfOutline } from "@/components/viewer/pdf/hooks/use-pdf-outline";
import { usePdfPageText } from "@/components/viewer/pdf/hooks/use-pdf-page-text";
import { usePdfRegionFraming } from "@/components/viewer/pdf/hooks/use-pdf-region-framing";
import { usePdfSelectionTranslate } from "@/components/viewer/pdf/hooks/use-pdf-selection-translate";
import { usePdfTextSelection } from "@/components/viewer/pdf/hooks/use-pdf-text-selection";
import { usePdfViewerHandle } from "@/components/viewer/pdf/hooks/use-pdf-viewer-handle";
import { usePdfVisualDraft } from "@/components/viewer/pdf/hooks/use-pdf-visual-draft";
import { usePdfVisualMarks } from "@/components/viewer/pdf/hooks/use-pdf-visual-marks";
import { usePdfZoomControls } from "@/components/viewer/pdf/hooks/use-pdf-zoom-controls";
import { useStableDerived } from "@/components/viewer/pdf/hooks/use-stable-derived";
import { excludeOverlappingPdfTextLinks } from "@/components/viewer/pdf/layers/citation-links";
import { COMMENT_RAIL_WIDTH_PX } from "@/components/viewer/pdf/layers/comment-cards-layer";
import {
	type PdfPageHandlers,
	PdfPageLayers,
	type PdfPageLayoutSlice,
	type PdfPageMarksSlice,
	type PdfPageModeSlice,
} from "@/components/viewer/pdf/layers/page-layers";
import { renderPdfRegionPromptImage } from "@/components/viewer/pdf/region-crop";
import type {
	PageAnnotationComment,
	PdfViewerInnerProps,
	PdfViewerProps,
} from "@/components/viewer/pdf/types";
import { ActiveCardScrollSync } from "@/components/viewer/pdf/viewport/active-card-scroll-sync";
import { DockviewViewport } from "@/components/viewer/pdf/viewport/dockview-viewport";
import { WheelZoomHandler } from "@/components/viewer/pdf/viewport/wheel-zoom-handler";
import { useLibraryStore } from "@/hooks/use-app-stores";
import {
	pinActiveSelection,
	publishSelection,
} from "@/lib/agent/selection-store";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import { isPdfViewerSource } from "@/lib/paper";
import { arxivUrls } from "@/lib/paper/arxiv";
import { isVisualMarkKind, tracePreview } from "@/lib/pdf/agent-trace";
import {
	annotationSnippet,
	annotationWikilinkAlias,
	annotationWikilinkMarkdown,
	wikiTargetForPaper,
} from "@/lib/pdf/annotation-ref";
import { threadHasUserQuestion, threadPreview } from "@/lib/pdf/ask/schema";
import type { PdfAskNormalizedRect, PdfAskThread } from "@/lib/pdf/ask/types";
import {
	DEFAULT_HIGHLIGHT_COLOR,
	HIGHLIGHT_HEX_LIST,
	type HighlightColor,
	normalizeHighlightColor,
} from "@/lib/pdf/highlight/palette";
import {
	getPdfAiRuntime,
	layoutAnalysisStore,
	type PdfLayoutRegion,
	setFocusedLayoutRegion,
} from "@/lib/pdf/layout";
import {
	type ActiveSelectionCard,
	pinFromRects,
	pinObscuresBodyText,
	type SelectionPin,
} from "@/lib/pdf/selection";
import type { PdfTranslateRect } from "@/lib/pdf/translate/types";
import { PDF_ZOOM_MAX, PDF_ZOOM_MIN } from "@/lib/pdf/zoom";
import { openRightTab } from "@/lib/shell/ui-store";

export type {
	PdfViewerHandle,
	PdfViewerProps,
} from "@/components/viewer/pdf/types";

/**
 * Geometry-only projection of a mark for gutter pins. Extracted from the ask /
 * translate arrays with a stable identity (see {@link useStableDerived}) so the
 * per-chunk streaming message bodies cannot invalidate `pinsByPage` (and with it
 * every mounted page).
 */
type AskPinAnchor = {
	id: string;
	/** 1-based page number */
	page: number;
	rects: PdfAskNormalizedRect[];
	preview: string;
	ended: boolean;
};

type TranslatePinAnchor = {
	id: string;
	/** 1-based page number */
	page: number;
	rects: PdfTranslateRect[];
	preview: string;
	hasError: boolean;
};

/** Compact value fingerprint of normalized rects (pin geometry input). */
function rectsKey(
	rects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
): string {
	return rects.map((r) => `${r.x},${r.y},${r.w},${r.h}`).join("~");
}

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

	const plugins = useMemo(() => {
		if (!source && !sourceBytes) return null;
		// Prefer bytes (no fetch step); fall back to a URL (remote https).
		const initialDocument = sourceBytes
			? { buffer: sourceBytes, documentId: docId, name: docId }
			: { url: source as string, documentId: docId, name: docId };
		return [
			createPluginRegistration(DocumentManagerPluginPackage, {
				initialDocuments: [initialDocument],
			}),
			createPluginRegistration(ViewportPluginPackage),
			createPluginRegistration(ScrollPluginPackage, {
				// Manifest default (4) keeps ~8 off-screen pages mounted, and every
				// mounted page re-renders whenever the scroller layout changes.
				defaultBufferSize: 2,
			}),
			createPluginRegistration(RenderPluginPackage),
			createPluginRegistration(TilingPluginPackage, {
				// Pre-render one ring of tiles around the viewport so fast
				// scrolling does not pop tiles in at the edges (rendering is
				// off-main-thread in the worker engine, so the extra tiles are
				// cheap).
				extraRings: 1,
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
	}, [source, sourceBytes, docId]);

	const hostClass = cn(
		"relative flex h-full min-h-0 flex-col bg-muted/20",
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
					{({ isLoaded, isLoading }) => {
						if (!isLoaded) {
							return (
								<p className="p-6 text-center text-muted-foreground text-sm">
									{isLoading ? t("pdf.loading") : t("pdf.empty")}
								</p>
							);
						}
						return <PdfViewerInner {...props} docId={docId} />;
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
	isActive = true,
	onOpenSettings,
	onHandle,
	onHighlightsChange,
	onAsksChange,
	onVisualTracesChange,
}: PdfViewerInnerProps) {
	const { t } = useTranslation("viewer");
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

	/** Sidebar-selected layout region → PDF focus outline. */
	const focusedLayoutRegion = useStore(layoutAnalysisStore, (s) => {
		if (s.focused?.documentId !== docId) return null;
		const result = s.byDocument[docId];
		if (!result || !s.focused) return null;
		return result.regions.find((r) => r.id === s.focused?.regionId) ?? null;
	});
	const zoomLevel = zoomState.currentZoomLevel || 1;

	const { pdfDark, togglePdfColorScheme } = usePdfColorScheme();
	const {
		zoomField,
		setZoomField,
		zoomFieldFocusedRef,
		zoomFieldCancelRef,
		zoomRef,
		commitZoomField,
	} = usePdfZoomControls(zoom, zoomLevel);

	const paperKey = paperRelPath || paperAbsPath || null;

	// Catalog title + link for the ask card's external "open in chat" query.
	const paperMetaByRelPath = useLibraryStore((s) => s.paperMetaByRelPath);
	const paperMeta = useMemo(() => {
		if (!paperRelPath) return undefined;
		const key = paperRelPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		return paperMetaByRelPath.get(key);
	}, [paperRelPath, paperMetaByRelPath]);
	const paperTitle = paperMeta?.title;
	/** Resolvable wiki target for comment-rail copy-link/copy-embed. */
	const commentWikiTarget = useMemo(() => {
		if (!paperRelPath) return null;
		return wikiTargetForPaper(paperRelPath, paperRelPath);
	}, [paperRelPath]);
	const paperLink = useMemo(() => {
		if (!paperMeta) return undefined;
		if (paperMeta.arxiv_id) return arxivUrls(paperMeta.arxiv_id)?.abs;
		return paperMeta.source_url ?? paperMeta.html_url ?? paperMeta.pdf_url;
	}, [paperMeta]);

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
	const { selectionMenu, setSelectionMenu, closeSelectionMenu } =
		usePdfTextSelection({
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
	const resetVisualCardChromeRef = useRef<() => void>(() => undefined);
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
			if (isVisualMarkKind(card?.kind)) resetVisualCardChromeRef.current();
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
		resolvePdfAskAgent,
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

	const [showReferences, setShowReferences] = useState(false);
	const [showFigures, setShowFigures] = useState(false);
	const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);

	const handleToggleOutline = useCallback(() => {
		if (showReferences) setShowReferences(false);
		if (showFigures) setShowFigures(false);
		toggleOutline();
	}, [showReferences, showFigures, toggleOutline]);
	const handleToggleReferences = useCallback(() => {
		if (showOutline) toggleOutline();
		if (showFigures) setShowFigures(false);
		setShowReferences((v) => !v);
	}, [showOutline, showFigures, toggleOutline]);
	const handleToggleFigures = useCallback(() => {
		if (showOutline) toggleOutline();
		if (showReferences) setShowReferences(false);
		setShowFigures((v) => !v);
	}, [showOutline, showReferences, toggleOutline]);

	// ---- In-text citation / internal PDF links ----

	const {
		citationPreview,
		cancelCitationHide,
		scheduleCitationHide,
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
	});

	// Cross-reference (\ref) hover: preview the figure/table/equation crop.
	// Reuses the same dest-map parse (cached per PDF); a link coordinate is
	// either a cite.* or a cross-ref destination, so both hover handlers run
	// on every link and at most one card shows.
	const {
		crossrefPreview,
		cancelCrossrefHide,
		scheduleCrossrefHide,
		handleCrossrefLinkHover,
	} = usePdfCrossrefPreview({
		docId,
		hostRef,
		zoomRef,
		paperAbsPath,
		sourceBytes,
		engineRef,
		docCapRef,
	});

	const handleLinkHover = useCallback(
		(link: PdfLinkAnnoObject | null) => {
			handleCitationLinkHover(link);
			handleCrossrefLinkHover(link);
		},
		[handleCitationLinkHover, handleCrossrefLinkHover],
	);

	/**
	 * Pin geometry is anchor data only. While an answer / translation streams,
	 * every chunk replaces the whole threads / translates array, but none of the
	 * fields fingerprinted below change — so these projections keep their
	 * identity and `pinsByPage` (and thus every mounted page) skips re-rendering
	 * per chunk. The translate pin preview therefore uses the source quote, not
	 * the streamed result (the open card shows the live text).
	 */
	const askPinAnchors = useStableDerived<AskPinAnchor[]>(
		() =>
			threads.filter(threadHasUserQuestion).map((th) => ({
				id: th.id,
				page: th.anchor.page,
				rects: th.anchor.rects,
				preview: threadPreview(th),
				ended: th.status === "ended",
			})),
		threads
			.map(
				(th) =>
					`${th.id}|${threadHasUserQuestion(th) ? 1 : 0}|${th.anchor.page}|${th.status}|${threadPreview(th)}|${rectsKey(th.anchor.rects)}`,
			)
			.join(";"),
	);
	const translatePinAnchors = useStableDerived<TranslatePinAnchor[]>(
		() =>
			translates.map((tr) => ({
				id: tr.id,
				page: tr.page,
				rects: tr.rects,
				preview: tr.quote?.trim() || tr.id,
				hasError: Boolean(tr.error),
			})),
		translates
			.map(
				(tr) =>
					`${tr.id}|${tr.page}|${tr.error ? 1 : 0}|${tr.quote ?? ""}|${rectsKey(tr.rects)}`,
			)
			.join(";"),
	);

	/**
	 * Gutter pins per page (1-based). Built once per mark/text change: pin
	 * placement walks the page's whole text-rect list, so doing it inside
	 * renderPage cost that walk for every mounted page on every scroll frame.
	 */
	const { pinsByPage, commentsByPage: commentsByPageBase } = useMemo(() => {
		const pins = new Map<number, SelectionPin[]>();
		const comments = new Map<number, PageAnnotationComment[]>();
		const add = (page: number, pin: SelectionPin) => {
			const list = pins.get(page);
			if (list) list.push(pin);
			else pins.set(page, [pin]);
		};
		for (const highlight of highlights) {
			const comment = highlight.comment?.trim();
			if (!comment) continue;
			const anchor = highlightAnchors.get(highlight.id);
			if (!anchor) continue;
			// Highlight notes always live in the right-edge comment rail.
			const entry: PageAnnotationComment = {
				id: highlight.id,
				pageIndex: highlight.page - 1,
				anchorY: anchor.y,
				rects: highlight.rects,
				quote: highlight.quote,
				comment,
				color: normalizeHighlightColor(highlight.color),
				kind: "highlight",
				linkAlias:
					annotationWikilinkAlias(
						paperTitle,
						annotationSnippet({ comment, quote: highlight.quote }),
					) ?? null,
			};
			const list = comments.get(highlight.page);
			if (list) list.push(entry);
			else comments.set(highlight.page, [entry]);
		}
		for (const anchor of askPinAnchors) {
			const pageText = pageTextMap.get(anchor.page - 1);
			const pin = pinFromRects(anchor.rects, pageText);
			add(anchor.page, {
				id: anchor.id,
				kind: "ask",
				x: pin.x,
				y: pin.y,
				preview: anchor.preview,
				ended: anchor.ended,
				overText: pinObscuresBodyText(pin, pageText),
				side: pin.side,
			});
		}
		for (const anchor of translatePinAnchors) {
			if (anchor.hasError) continue;
			const pageText = pageTextMap.get(anchor.page - 1);
			const pin = pinFromRects(anchor.rects, pageText);
			add(anchor.page, {
				id: anchor.id,
				kind: "translate",
				x: pin.x,
				y: pin.y,
				preview: anchor.preview,
				overText: pinObscuresBodyText(pin, pageText),
				side: pin.side,
			});
		}
		for (const trace of visualTraces) {
			const hasAgent = Boolean(trace.agent);
			const note = trace.comment.trim();
			// Note-only visual marks (and visual marks that already have a
			// comment) live in the comment rail.
			if (!hasAgent || note) {
				const entry: PageAnnotationComment = {
					id: trace.id,
					pageIndex: trace.page - 1,
					anchorY: trace.rects[0]?.y ?? 0,
					rects: trace.rects,
					quote: "",
					comment: trace.comment,
					color: DEFAULT_HIGHLIGHT_COLOR,
					kind: "visual",
					linkAlias:
						annotationWikilinkAlias(
							paperTitle,
							annotationSnippet({ comment: trace.comment }),
						) ?? null,
				};
				const list = comments.get(trace.page);
				if (list) list.push(entry);
				else comments.set(trace.page, [entry]);
				if (!hasAgent) continue;
			}
			const pageText = pageTextMap.get(trace.page - 1);
			const pin = pinFromRects(trace.rects, pageText);
			add(trace.page, {
				id: trace.id,
				kind: "visual",
				x: pin.x,
				y: pin.y,
				preview: tracePreview(trace),
				ended: trace.agent?.status !== "running",
				traceId: trace.id,
				overText: pinObscuresBodyText(pin, pageText),
				side: pin.side,
			});
		}
		return { pinsByPage: pins, commentsByPage: comments };
	}, [
		highlights,
		highlightAnchors,
		askPinAnchors,
		translatePinAnchors,
		visualTraces,
		pageTextMap,
		paperTitle,
	]);

	const activeThread = useMemo(() => {
		if (activeCard?.kind !== "ask") return null;
		return threads.find((th) => th.id === activeCard.id) ?? null;
	}, [threads, activeCard]);
	const activeTranslate = useMemo(() => {
		if (activeCard?.kind !== "translate") return null;
		return translates.find((tr) => tr.id === activeCard.id) ?? null;
	}, [translates, activeCard]);
	const activeVisualTrace = useMemo(() => {
		if (!isVisualMarkKind(activeCard?.kind)) return null;
		return visualTraces.find((tr) => tr.id === activeCard.id) ?? null;
	}, [visualTraces, activeCard]);
	/**
	 * On-page source frame of the active ask / translate card: anchor geometry
	 * only. The page layers never read the streaming body, and the rects
	 * reference survives chunk updates (updaters spread the record and replace
	 * `messages` / `result` only), so these keep their identity while streaming
	 * — unlike the full records the card stack consumes.
	 */
	const activeAskId = activeThread?.id ?? null;
	const activeAskPage = activeThread?.anchor.page ?? null;
	const activeAskRects = activeThread?.anchor.rects ?? null;
	const activeAskAnchor = useMemo(
		() =>
			activeAskId !== null && activeAskPage !== null && activeAskRects !== null
				? { id: activeAskId, page: activeAskPage, rects: activeAskRects }
				: null,
		[activeAskId, activeAskPage, activeAskRects],
	);
	const activeTranslateId = activeTranslate?.id ?? null;
	const activeTranslatePage = activeTranslate?.page ?? null;
	const activeTranslateRects = activeTranslate?.rects ?? null;
	const activeTranslateAnchor = useMemo(
		() =>
			activeTranslateId !== null &&
			activeTranslatePage !== null &&
			activeTranslateRects !== null
				? {
						id: activeTranslateId,
						page: activeTranslatePage,
						rects: activeTranslateRects,
					}
				: null,
		[activeTranslateId, activeTranslatePage, activeTranslateRects],
	);
	// ---- Layout analysis ----
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
		openVisualDraftEditor,
		closeVisualDraftEditor,
		screenPointForRegion,
	});

	// ---- Visual marks (draft save, agent turns, existing pins) ----

	const {
		visualError,
		visualCardExpanded,
		handleVisualDraftSave,
		handleVisualAddToChat,
		handleVisualSendNow,
		handleVisualSaveComment,
		updateVisualComment,
		handleVisualAddToChatFromMark,
		handleVisualContinue,
		handleDeleteVisualTrace,
		handleOpenActiveVisualSession,
		handleStopVisualSession,
		deleteVisualTraceById,
		resetVisualCardChrome,
	} = usePdfVisualMarks({
		paperAbsPath,
		paperRelPath,
		visualTracesRef,
		setVisualTraces,
		upsertVisualTrace,
		openCard,
		hideActiveCard,
		activeCardRef,
		cardScreenRef,
		setCardScreen,
		resolvePdfAskAgent,
		visualDraftEditor,
		closeVisualDraftEditor,
	});
	resetVisualCardChromeRef.current = resetVisualCardChrome;

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
			},
		]);
		return next;
	}, [commentsByPageBase, railEdit]);

	const focusedVisualRegion = useMemo(() => {
		if (railEdit?.kind !== "visual") return null;
		const tr = visualTraces.find((item) => item.id === railEdit.id);
		if (!tr) return null;
		return { page: tr.page, rects: tr.rects };
	}, [railEdit, visualTraces]);

	const handleOpenPin = useCallback(
		(pin: SelectionPin) => {
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
				// Pin hover: page is already on-screen; openCard places beside the mark.
				openCard({ kind: "visual", id: tr.id });
			}
		},
		[
			upsertThread,
			openThread,
			openCard,
			openEditorForAnnotation,
			threadsRef,
			visualTracesRef,
		],
	);

	// ---- Selection action menu ----

	const handleHighlight = useCallback(
		(color: HighlightColor) => {
			if (!selectionMenu) return;
			createHighlights(
				selectionMenu.pages,
				color,
				selectionMenu.anchor.quote ?? "",
			);
			closeSelectionMenu();
		},
		[selectionMenu, createHighlights, closeSelectionMenu],
	);

	const handleNote = useCallback(() => {
		if (!selectionMenu) return;
		const quote = selectionMenu.anchor.quote ?? "";
		const anchorPage = selectionMenu.pages[0];
		const created = createHighlights(
			selectionMenu.pages,
			DEFAULT_HIGHLIGHT_COLOR,
			quote,
		);
		const first = created[0];
		setSelectionMenu(null);
		selectionCap?.clear(docId);
		if (!first || !anchorPage) return;
		beginRailEdit({
			id: first.id,
			pageIndex: first.pageIndex,
			kind: "highlight",
			comment: "",
			quote,
			color: DEFAULT_HIGHLIGHT_COLOR,
			anchorY: selectionMenu.anchor.rects[0]?.y ?? 0,
			rects: selectionMenu.anchor.rects,
		});
	}, [
		selectionMenu,
		createHighlights,
		selectionCap,
		docId,
		setSelectionMenu,
		beginRailEdit,
	]);

	const handleCopy = useCallback(() => {
		selectionCap?.copyToClipboard(docId);
	}, [selectionCap, docId]);

	const handleMenuAsk = useCallback(() => {
		if (!selectionMenu) return;
		const anchor = selectionMenu.anchor;
		setSelectionMenu(null);
		selectionCap?.clear(docId);
		startFromAnchor(anchor);
	}, [selectionMenu, startFromAnchor, selectionCap, docId, setSelectionMenu]);

	const handleMenuAddToChat = useCallback(() => {
		if (!selectionMenu) return;
		const anchor = selectionMenu.anchor;
		const quote = anchor.quote?.trim();
		setSelectionMenu(null);
		selectionCap?.clear(docId);
		if (!quote) return;
		// Re-publish after clear: clearing the PDF selection also drops the live chip.
		// Keep page geometry so the next Agent turn can write a conversation card pin.
		publishSelection({
			text: quote,
			sourcePath: paperRelPath ?? paperAbsPath ?? "PDF",
			origin: "pdf",
			page: anchor.page,
			rects: anchor.rects,
			paperAbsPath: paperAbsPath ?? undefined,
		});
		pinActiveSelection();
		openRightTab("agent");
	}, [
		selectionMenu,
		selectionCap,
		docId,
		paperRelPath,
		paperAbsPath,
		setSelectionMenu,
	]);

	const handleMenuTranslate = useCallback(() => {
		if (!selectionMenu) return;
		const anchor = selectionMenu.anchor;
		setSelectionMenu(null);
		selectionCap?.clear(docId);
		translateSelection(anchor);
	}, [
		selectionMenu,
		selectionCap,
		docId,
		setSelectionMenu,
		translateSelection,
	]);

	// ---- In-PDF highlight selection menu ----

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

	// Re-anchor the active pin modal on scroll + zoom. zoomLevel forces
	// re-placement after zoom. Use scrollReady (boolean) — not `scroll` —
	// because EmbedPDF returns a new scope object every render; depending on
	// it re-fired this effect → setCardScreen → re-render → Maximum update depth
	// when a modal card was open (visual-trace chat + agent panel re-renders).
	// Native wheel scroll is handled by ActiveCardScrollSync (viewport element).
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrollReady/zoomLevel are intentional re-place triggers
	useEffect(() => {
		if (!activeCard) return;
		// Force re-place after zoom / card change even if rounded coords match.
		cardScreenRef.current = null;
		placeActiveCard(activeCard);
		let raf: number | null = null;
		const rePlace = () => {
			if (raf != null) return;
			raf = requestAnimationFrame(() => {
				raf = null;
				rePlaceActiveCardOnScroll();
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
		scrollReady,
		placeActiveCard,
		zoomLevel,
		rePlaceActiveCardOnScroll,
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
	});

	const pageMarks = useMemo<PdfPageMarksSlice>(
		() => ({
			activeAskAnchor,
			activeTranslateAnchor,
			activeVisualTrace,
			visualDraftRegion,
			visualCropRegion,
			focusedLayoutRegion,
			pinsByPage,
			commentsByPage,
			editingCommentId: railEdit?.id ?? null,
			focusedVisualRegion,
			commentWikiTarget,
			citationLinks,
			textLinks,
			activeCardId: activeCard?.id ?? null,
			hoveredCommentId,
		}),
		[
			activeAskAnchor,
			activeTranslateAnchor,
			activeVisualTrace,
			visualDraftRegion,
			visualCropRegion,
			focusedLayoutRegion,
			pinsByPage,
			commentsByPage,
			railEdit?.id,
			focusedVisualRegion,
			commentWikiTarget,
			citationLinks,
			textLinks,
			activeCard?.id,
			hoveredCommentId,
		],
	);

	const pageLayout = useMemo<PdfPageLayoutSlice>(
		() => ({
			hoverableRegionsByPage,
			rawRegionsByPage,
			layoutOverlayVisible,
			layoutTranslateItemsByPage,
			layoutTranslatePageStateByPage,
		}),
		[
			hoverableRegionsByPage,
			rawRegionsByPage,
			layoutOverlayVisible,
			layoutTranslateItemsByPage,
			layoutTranslatePageStateByPage,
		],
	);

	const pageMode = useMemo<PdfPageModeSlice>(
		() => ({
			regionSelecting,
			visualCropPending,
			visualDraftOpen: Boolean(visualDraftEditor),
		}),
		[regionSelecting, visualCropPending, visualDraftEditor],
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
			onHoverComment: (comment) => setHoveredCommentId(comment.id),
			onLeaveComment: () => setHoveredCommentId(null),
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
				pdfDark={pdfDark}
				zoomRef={zoomRef}
				marks={pageMarks}
				layout={pageLayout}
				mode={pageMode}
				handlers={pageHandlers}
			/>
		),
		[docId, pdfDark, zoomRef, pageMarks, pageLayout, pageMode, pageHandlers],
	);

	// ---- Top toolbar auto show/hide (#400) ----
	const topChromeVisible = usePdfChromeVisibility({
		hostRef,
		scrollRef,
		scrollReady,
		sticky:
			showOutline ||
			showReferences ||
			showFigures ||
			findOpen ||
			regionSelecting ||
			visualCropPending,
		held: () => zoomFieldFocusedRef.current,
	});

	return (
		<div ref={hostRef} className="relative flex h-full min-h-0 w-full flex-col">
			<PdfLeftToolbar
				outline={outline}
				showOutline={showOutline}
				onToggleOutline={handleToggleOutline}
				paperPath={paperRelPath}
				showReferences={showReferences}
				onToggleReferences={handleToggleReferences}
				showFigures={showFigures}
				onToggleFigures={handleToggleFigures}
				visible={topChromeVisible}
			/>
			<PdfOutlinePanel
				outline={outline}
				showOutline={showOutline}
				onGoToPage={goToPage}
			/>
			<PdfReferencesPanel
				vaultPath={vaultPath}
				paperPath={paperRelPath}
				showReferences={showReferences}
			/>
			<PdfFiguresPanel
				documentId={docId}
				showFigures={showFigures}
				onAnalyze={handleAnalyzeLayout}
				onJump={handleJumpToLayoutRegion}
				onRenderThumb={handleRenderLayoutThumb}
			/>
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
			<PdfToolbar
				zoomLevel={zoomLevel}
				onZoomIn={() => zoom?.zoomIn()}
				onZoomOut={() => zoom?.zoomOut()}
				zoomField={zoomField}
				onZoomFieldChange={setZoomField}
				zoomFieldFocusedRef={zoomFieldFocusedRef}
				zoomFieldCancelRef={zoomFieldCancelRef}
				onCommitZoomField={commitZoomField}
				regionSelecting={regionSelecting}
				visualCropPending={visualCropPending}
				engine={engine}
				onToggleRegionSelect={toggleRegionSelect}
				layoutTranslateRunning={layoutTranslateRunning}
				layoutTranslateActive={layoutTranslateActive}
				layoutTranslateLabel={layoutTranslateLabel}
				onToggleLayoutTranslate={toggleLayoutTranslate}
				visible={topChromeVisible}
			/>

			<DockviewViewport
				documentId={docId}
				hostRef={hostRef}
				rightGutter={COMMENT_RAIL_WIDTH_PX}
				className="agentero-scroll-both min-h-0 min-w-0 flex-1"
			>
				<WheelZoomHandler docId={docId} />
				<ActiveCardScrollSync
					active={Boolean(activeCard)}
					onScroll={rePlaceActiveCardOnScroll}
				/>
				{/* Ctrl+wheel and trackpad pinch are handled by WheelZoomHandler (WebKit
				    pinch arrives as GestureEvents, not ctrl+wheel); EmbedPDF's built-in
				    wheel zoom is disabled so steps match the toolbar +/- buttons, and
				    its enablePinch only covers touch devices. */}
				<ZoomGestureWrapper documentId={docId} enableWheel={false}>
					<GlobalPointerProvider documentId={docId}>
						<Scroller documentId={docId} renderPage={renderPage} />
					</GlobalPointerProvider>
				</ZoomGestureWrapper>
			</DockviewViewport>

			<PdfCardStack
				selectionMenu={{
					state: selectionMenu,
					onHighlight: handleHighlight,
					onCopy: handleCopy,
					onNote: handleNote,
					onAsk: handleMenuAsk,
					onAddToChat: handleMenuAddToChat,
					onTranslate: handleMenuTranslate,
					onClose: closeSelectionMenu,
				}}
				visualDraft={{
					state: visualDraftEditor,
					onSave: handleVisualDraftSave,
					onAddToChat: handleVisualAddToChat,
					onSendNow: handleVisualSendNow,
					onDelete: closeVisualDraftEditor,
					onClose: closeVisualDraftEditor,
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
									open ? cancelCitationHide() : scheduleCitationHide(),
							}
						: undefined,
					onHoverEnter: cancelCitationHide,
					onHoverLeave: scheduleCitationHide,
				}}
				crossrefPreview={{
					state: crossrefPreview,
					onHoverEnter: cancelCrossrefHide,
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
				visualTrace={{
					trace: activeVisualTrace,
					error: visualError,
					initialExpanded: visualCardExpanded,
					onOpenSession: handleOpenActiveVisualSession,
					onAddToChat: handleVisualAddToChatFromMark,
					onSaveComment: handleVisualSaveComment,
					onSend: handleVisualContinue,
					onDelete: handleDeleteVisualTrace,
					onHide: hideActiveCard,
					onStop: handleStopVisualSession,
				}}
				translate={{
					record: activeTranslate,
					streaming: translateStreaming,
					error: translateError,
					onOpenSettings: openTranslateSettings,
					onHide: hideActiveCard,
					onDelete: deleteTranslateCard,
				}}
			/>

			<PdfBottomBar
				totalPages={totalPages}
				pageField={pageField}
				onPageFieldChange={setPageField}
				pageFocusedRef={pageFocusedRef}
				onCommitPageField={commitPageField}
				pdfDark={pdfDark}
				onTogglePdfColorScheme={togglePdfColorScheme}
				onFitWidth={() => zoom?.requestZoom(ZoomMode.FitWidth)}
				onFitPage={() => zoom?.requestZoom(ZoomMode.FitPage)}
			/>
		</div>
	);
}
