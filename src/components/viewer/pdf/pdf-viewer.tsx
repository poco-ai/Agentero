import { createPluginRegistration } from "@embedpdf/core";
import { EmbedPDF } from "@embedpdf/core/react";
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
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { PdfBottomBar } from "@/components/viewer/pdf/chrome/pdf-bottom-bar";
import { PdfCardStack } from "@/components/viewer/pdf/chrome/pdf-card-stack";
import { PdfFindBar } from "@/components/viewer/pdf/chrome/pdf-find-bar";
import { PdfOutlinePanel } from "@/components/viewer/pdf/chrome/pdf-outline-panel";
import { PdfToolbar } from "@/components/viewer/pdf/chrome/pdf-toolbar";
import { pageElByIndex, rectRightScreen } from "@/components/viewer/pdf/coords";
import { usePdfEngineContext } from "@/components/viewer/pdf/engine-provider";
import { usePdfAskThreads } from "@/components/viewer/pdf/hooks/use-pdf-ask-threads";
import { usePdfCards } from "@/components/viewer/pdf/hooks/use-pdf-cards";
import { usePdfCitations } from "@/components/viewer/pdf/hooks/use-pdf-citations";
import { usePdfColorScheme } from "@/components/viewer/pdf/hooks/use-pdf-color-scheme";
import { usePdfFind } from "@/components/viewer/pdf/hooks/use-pdf-find";
import { usePdfHighlights } from "@/components/viewer/pdf/hooks/use-pdf-highlights";
import { usePdfLayoutHover } from "@/components/viewer/pdf/hooks/use-pdf-layout-hover";
import { usePdfLayoutRegions } from "@/components/viewer/pdf/hooks/use-pdf-layout-regions";
import { usePdfLayoutRun } from "@/components/viewer/pdf/hooks/use-pdf-layout-run";
import { usePdfLayoutTranslate } from "@/components/viewer/pdf/hooks/use-pdf-layout-translate";
import { usePdfMarksIo } from "@/components/viewer/pdf/hooks/use-pdf-marks-io";
import { usePdfNavigation } from "@/components/viewer/pdf/hooks/use-pdf-navigation";
import { usePdfNoteEditor } from "@/components/viewer/pdf/hooks/use-pdf-note-editor";
import { usePdfOutline } from "@/components/viewer/pdf/hooks/use-pdf-outline";
import { usePdfPageText } from "@/components/viewer/pdf/hooks/use-pdf-page-text";
import { usePdfRegionFraming } from "@/components/viewer/pdf/hooks/use-pdf-region-framing";
import { usePdfSelectionTranslate } from "@/components/viewer/pdf/hooks/use-pdf-selection-translate";
import { usePdfTextSelection } from "@/components/viewer/pdf/hooks/use-pdf-text-selection";
import { usePdfViewerHandle } from "@/components/viewer/pdf/hooks/use-pdf-viewer-handle";
import { usePdfVisualMarks } from "@/components/viewer/pdf/hooks/use-pdf-visual-marks";
import { usePdfZoomControls } from "@/components/viewer/pdf/hooks/use-pdf-zoom-controls";
import { useStableDerived } from "@/components/viewer/pdf/hooks/use-stable-derived";
import {
	type PdfPageHandlers,
	PdfPageLayers,
	type PdfPageLayoutSlice,
	type PdfPageMarksSlice,
	type PdfPageModeSlice,
} from "@/components/viewer/pdf/layers/page-layers";
import type {
	PdfViewerInnerProps,
	PdfViewerProps,
} from "@/components/viewer/pdf/types";
import { ActiveCardScrollSync } from "@/components/viewer/pdf/viewport/active-card-scroll-sync";
import { DockviewViewport } from "@/components/viewer/pdf/viewport/dockview-viewport";
import { WheelZoomHandler } from "@/components/viewer/pdf/viewport/wheel-zoom-handler";
import {
	pinActiveSelection,
	publishSelection,
} from "@/lib/agent/selection-store";
import { cn } from "@/lib/core/utils";
import { isPdfViewerSource } from "@/lib/paper";
import { isVisualMarkKind, tracePreview } from "@/lib/pdf/agent-trace";
import { threadHasUserQuestion, threadPreview } from "@/lib/pdf/ask/schema";
import type { PdfAskNormalizedRect, PdfAskThread } from "@/lib/pdf/ask/types";
import { equationAnnotationPath } from "@/lib/pdf/equation-annotation";
import {
	DEFAULT_HIGHLIGHT_COLOR,
	HIGHLIGHT_HEX_LIST,
	type HighlightColor,
} from "@/lib/pdf/highlight/palette";
import { getPdfAiRuntime, layoutAnalysisStore } from "@/lib/pdf/layout";
import {
	type ActiveSelectionCard,
	pinFromRects,
	pinObscuresBodyText,
	type SelectionPin,
} from "@/lib/pdf/selection";
import type { PdfTranslateRect } from "@/lib/pdf/translate/types";
import { PDF_ZOOM_MAX, PDF_ZOOM_MIN } from "@/lib/pdf/zoom";
import { openRightTab } from "@/lib/shell/ui-store";
import { openPath } from "@/lib/workspace/actions";

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
export function PdfViewer(props: PdfViewerProps) {
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
}

function PdfViewerInner({
	docId,
	paperAbsPath = null,
	paperRelPath = null,
	vaultPath = null,
	isActive = true,
	onOpenAnnotations,
	onOpenSettings,
	onHandle,
	onHighlightsChange,
	onAsksChange,
	onVisualTracesChange,
}: PdfViewerInnerProps) {
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
	const { pageTextMap, pageTextMapRef } = usePdfPageText({
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
	/**
	 * Mirror of the translate cluster's `translateStreaming`. Created here (not in
	 * {@link usePdfSelectionTranslate}) because `usePdfCards` is declared first and
	 * needs the same ref object to keep a streaming translate card alive.
	 */
	const translateStreamingRef = useRef(false);

	const hostRef = useRef<HTMLDivElement>(null);
	/**
	 * Mirrors of the visual-mark cluster's `regionSelecting` / `visualCropPending`.
	 * Created here (not in {@link usePdfVisualMarks}) because the layout-hover
	 * guard is declared first and must read the same ref objects.
	 */
	const regionSelectingRef = useRef(false);
	const visualCropPendingRef = useRef(false);

	// ---- Text selection → floating action menu ----
	// Placed after hostRef/zoomRef: the hook anchors the menu against the page
	// element and needs both refs injected.
	const {
		selectionMenu,
		selectionMenuRef,
		setSelectionMenu,
		closeSelectionMenu,
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
	 * Latest `beginVisualAnnotation`. The layout-hover dwell timer opens a crop,
	 * but the visual-mark cluster is declared after the layout cluster (it consumes
	 * the draft-card owner), so this edge goes through a ref assigned right after
	 * that hook — the dwell callback keeps its identity.
	 */
	const beginVisualAnnotationRef = useRef<
		(
			page: number,
			region: PdfAskNormalizedRect,
			opts?: { seq?: number; ephemeral?: boolean },
		) => void
	>(() => undefined);
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
		cancelHoverHide,
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

	// ---- In-text citation / internal PDF links ----

	const {
		citationPreview,
		cancelCitationHide,
		scheduleCitationHide,
		handleCitationLinkActivate,
		handleCitationLinkHover,
	} = usePdfCitations({ docId, annotationCap, hostRef, zoomRef });

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
	const pinsByPage = useMemo(() => {
		const byPage = new Map<number, SelectionPin[]>();
		const add = (page: number, pin: SelectionPin) => {
			const list = byPage.get(page);
			if (list) list.push(pin);
			else byPage.set(page, [pin]);
		};
		for (const highlight of highlights) {
			const comment = highlight.comment?.trim();
			if (!comment) continue;
			const anchor = highlightAnchors.get(highlight.id);
			if (!anchor) continue;
			const pageText = pageTextMap.get(highlight.page - 1);
			const pin = pinFromRects([anchor], pageText);
			add(highlight.page, {
				id: highlight.id,
				kind: "annotate",
				x: pin.x,
				y: pin.y,
				preview: comment,
				overText: pinObscuresBodyText(pin, pageText),
				side: pin.side,
			});
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
		return byPage;
	}, [
		highlights,
		highlightAnchors,
		askPinAnchors,
		translatePinAnchors,
		visualTraces,
		pageTextMap,
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
	});

	const {
		equationSymbols,
		visualDraftEditor,
		formulaAnnotationPreview,
		openVisualDraftEditor,
		closeVisualDraftEditor,
		closeFormulaAnnotationPreview,
		screenPointForRegion,
		layoutHoverSeqRef,
		scheduleLayoutHoverOpen,
		handleLayoutHoverLeave,
		markLayoutDraftHoverEnter,
		scheduleLayoutDraftHide,
		markFormulaHoverEnter,
		scheduleFormulaHide,
		rePlaceFormulaAnnotationOnScroll,
	} = usePdfLayoutHover({
		docId,
		paperAbsPath,
		hostRef,
		zoomLevel,
		selectionMenuRef,
		regionSelectingRef,
		visualCropPendingRef,
		beginVisualAnnotationRef,
	});

	const {
		layoutTranslateItemsByPage,
		layoutTranslateRunning,
		layoutTranslateActive,
		layoutTranslateLabel,
		toggleLayoutTranslate,
	} = usePdfLayoutTranslate({ docId, layoutRawRegions });

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
	/** Formula legend keeps the same on-page visual frame as visual-ask hover. */
	const formulaAnnotationRegion = useMemo(
		() =>
			formulaAnnotationPreview
				? {
						page: formulaAnnotationPreview.page,
						region: formulaAnnotationPreview.region,
					}
				: null,
		[formulaAnnotationPreview],
	);

	// ---- Region framing (⌘. marquee → crop) ----

	const {
		regionSelecting,
		visualCropPending,
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
		closeFormulaAnnotationPreview,
		screenPointForRegion,
		layoutHoverSeqRef,
		regionSelectingRef,
		visualCropPendingRef,
	});

	// ---- Visual marks (draft save, agent turns, existing pins) ----

	const {
		visualError,
		visualCardExpanded,
		handleVisualDraftSave,
		handleVisualAddToChat,
		handleVisualSendNow,
		handleVisualSaveComment,
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
	beginVisualAnnotationRef.current = beginVisualAnnotation;
	resetVisualCardChromeRef.current = resetVisualCardChrome;

	const {
		editor,
		setEditor,
		openEditorForAnnotation,
		closeEditor,
		saveEditor,
		deleteEditorAnnotation,
	} = usePdfNoteEditor({
		docId,
		annotationCap,
		hostRef,
		zoomRef,
		cancelHoverHide,
		cardHoverSurfaceRef,
		updateHighlightComment,
		deleteHighlightAnnotation,
	});
	closeEditorRef.current = closeEditor;

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
		if (first && anchorPage) {
			const pageEl = pageElByIndex(hostRef.current, anchorPage.pageIndex);
			if (pageEl) {
				setEditor({
					screen: rectRightScreen(pageEl, anchorPage.rect, zoomRef.current),
					pageIndex: first.pageIndex,
					id: first.id,
					comment: "",
				});
			}
		}
	}, [
		selectionMenu,
		createHighlights,
		selectionCap,
		docId,
		setSelectionMenu,
		setEditor,
		zoomRef,
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
			formulaAnnotationRegion,
			focusedLayoutRegion,
			pinsByPage,
			citationLinks,
			activeCardId: activeCard?.id ?? null,
		}),
		[
			activeAskAnchor,
			activeTranslateAnchor,
			activeVisualTrace,
			visualDraftRegion,
			formulaAnnotationRegion,
			focusedLayoutRegion,
			pinsByPage,
			citationLinks,
			activeCard?.id,
		],
	);

	const pageLayout = useMemo<PdfPageLayoutSlice>(
		() => ({
			hoverableRegionsByPage,
			rawRegionsByPage,
			layoutOverlayVisible,
			layoutTranslateItemsByPage,
			equationSymbolCount: equationSymbols.length,
			visualDraftEphemeral: Boolean(visualDraftEditor?.ephemeral),
		}),
		[
			hoverableRegionsByPage,
			rawRegionsByPage,
			layoutOverlayVisible,
			layoutTranslateItemsByPage,
			equationSymbols.length,
			visualDraftEditor?.ephemeral,
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

	const pageHandlers = useMemo<PdfPageHandlers>(
		() => ({
			onOpenPin: handleOpenPin,
			onCardHoverEnter: markCardHoverEnter,
			onCardHoverLeave: scheduleHoverHide,
			onCitationActivate: handleCitationLinkActivate,
			onCitationHover: handleCitationLinkHover,
			onRegionSelect: handleVisualRegionSelect,
			onLayoutHoverEnter: scheduleLayoutHoverOpen,
			onLayoutHoverLeave: handleLayoutHoverLeave,
			onDraftHoverEnter: markLayoutDraftHoverEnter,
			onDraftHoverLeave: scheduleLayoutDraftHide,
		}),
		[
			handleOpenPin,
			markCardHoverEnter,
			scheduleHoverHide,
			handleCitationLinkActivate,
			handleCitationLinkHover,
			handleVisualRegionSelect,
			scheduleLayoutHoverOpen,
			handleLayoutHoverLeave,
			markLayoutDraftHoverEnter,
			scheduleLayoutDraftHide,
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

	return (
		<div ref={hostRef} className="relative flex h-full min-h-0 w-full flex-col">
			<PdfOutlinePanel
				outline={outline}
				showOutline={showOutline}
				onToggleOutline={toggleOutline}
				onGoToPage={goToPage}
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
				onOpenAnnotations={onOpenAnnotations}
			/>

			<DockviewViewport
				documentId={docId}
				hostRef={hostRef}
				className="agentero-scroll-both min-h-0 min-w-0 flex-1"
			>
				<WheelZoomHandler docId={docId} />
				<ActiveCardScrollSync
					active={Boolean(activeCard || formulaAnnotationPreview)}
					onScroll={() => {
						rePlaceActiveCardOnScroll();
						rePlaceFormulaAnnotationOnScroll();
					}}
				/>
				{/* Pinch zoom still handled by EmbedPDF; wheel zoom is replaced above so
				    the step size matches the toolbar +/- buttons. */}
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
					onHoverEnter: markLayoutDraftHoverEnter,
					onHoverLeave: scheduleLayoutDraftHide,
				}}
				formulaAnnotation={{
					state: formulaAnnotationPreview,
					onOpenFile: paperAbsPath
						? () => {
								closeFormulaAnnotationPreview();
								openPath(equationAnnotationPath(paperAbsPath));
							}
						: undefined,
					onClose: closeFormulaAnnotationPreview,
					onHoverEnter: markFormulaHoverEnter,
					onHoverLeave: scheduleFormulaHide,
				}}
				citationPreview={{
					state: citationPreview,
					onHoverEnter: cancelCitationHide,
					onHoverLeave: scheduleCitationHide,
				}}
				cardScreen={cardScreen}
				onCardHoverEnter={markCardHoverEnter}
				onCardHoverLeave={scheduleHoverHide}
				ask={{
					thread: activeThread,
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
				editor={{
					state: editor,
					onSave: saveEditor,
					onClose: closeEditor,
					onDelete: deleteEditorAnnotation,
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
