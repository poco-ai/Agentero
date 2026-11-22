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
} from "@embedpdf/plugin-interaction-manager/react";
import {
	LayoutAnalysisPluginPackage,
	useLayoutAnalysisCapability,
} from "@embedpdf/plugin-layout-analysis/react";
import { RenderPluginPackage } from "@embedpdf/plugin-render/react";
import {
	type PageLayout,
	ScrollPluginPackage,
	ScrollStrategy,
	useScroll,
} from "@embedpdf/plugin-scroll/react";
import { SearchPluginPackage, useSearch } from "@embedpdf/plugin-search/react";
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
import { PageSkeleton } from "@/components/ui/skeleton";
import { PdfBottomBar } from "@/components/viewer/pdf/chrome/pdf-bottom-bar";
import { PdfCardStack } from "@/components/viewer/pdf/chrome/pdf-card-stack";
import { PdfFiguresPanel } from "@/components/viewer/pdf/chrome/pdf-figures-panel";
import { PdfFindBar } from "@/components/viewer/pdf/chrome/pdf-find-bar";
import { PdfJumpBackChip } from "@/components/viewer/pdf/chrome/pdf-jump-back-chip";
import { PdfLeftToolbar } from "@/components/viewer/pdf/chrome/pdf-left-toolbar";
import { PdfOutlinePanel } from "@/components/viewer/pdf/chrome/pdf-outline-panel";
import { PdfReferencesPanel } from "@/components/viewer/pdf/chrome/pdf-references-panel";
import { PdfToolbar } from "@/components/viewer/pdf/chrome/pdf-toolbar";
import {
	anchorFromEmbedSelection,
	formattedSelectionPage,
	pageElByIndex,
	selectionBoundsOnScreen,
} from "@/components/viewer/pdf/coords";
import { usePdfEngineContext } from "@/components/viewer/pdf/engine-provider";
import { EPHEMERAL_PREVIEW_OPEN_MS } from "@/components/viewer/pdf/floating-hover";
import { useHoverIntent } from "@/components/viewer/pdf/hooks/use-hover-intent";
import { usePdfActiveAnchors } from "@/components/viewer/pdf/hooks/use-pdf-active-anchors";
import { usePdfAskThreads } from "@/components/viewer/pdf/hooks/use-pdf-ask-threads";
import { usePdfBookmarkEditor } from "@/components/viewer/pdf/hooks/use-pdf-bookmark-editor";
import { usePdfCards } from "@/components/viewer/pdf/hooks/use-pdf-cards";
import { usePdfChromeVisibility } from "@/components/viewer/pdf/hooks/use-pdf-chrome-visibility";
import { usePdfCitations } from "@/components/viewer/pdf/hooks/use-pdf-citations";
import { usePdfCrossrefPreview } from "@/components/viewer/pdf/hooks/use-pdf-crossref-preview";
import { usePdfFind } from "@/components/viewer/pdf/hooks/use-pdf-find";
import { usePdfHighlights } from "@/components/viewer/pdf/hooks/use-pdf-highlights";
import { usePdfImmersivePosition } from "@/components/viewer/pdf/hooks/use-pdf-immersive-position";
import { usePdfJumpBack } from "@/components/viewer/pdf/hooks/use-pdf-jump-back";
import { usePdfLayoutCluster } from "@/components/viewer/pdf/hooks/use-pdf-layout-cluster";
import { usePdfLeftPanels } from "@/components/viewer/pdf/hooks/use-pdf-left-panels";
import { usePdfLinkInk } from "@/components/viewer/pdf/hooks/use-pdf-link-ink";
import { usePdfLinkUrlTip } from "@/components/viewer/pdf/hooks/use-pdf-link-url-tip";
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
import { usePdfScrollSync } from "@/components/viewer/pdf/hooks/use-pdf-scroll-sync";
import { usePdfSelectionActions } from "@/components/viewer/pdf/hooks/use-pdf-selection-actions";
import { usePdfSelectionTranslate } from "@/components/viewer/pdf/hooks/use-pdf-selection-translate";
import { useSentenceGlyphRects } from "@/components/viewer/pdf/hooks/use-pdf-sentence-glyph-rects";
import { usePdfSmartHighlights } from "@/components/viewer/pdf/hooks/use-pdf-smart-highlights";
import { usePdfSyncTex } from "@/components/viewer/pdf/hooks/use-pdf-synctex";
import { usePdfTextSelection } from "@/components/viewer/pdf/hooks/use-pdf-text-selection";
import { usePdfTranslationSelection } from "@/components/viewer/pdf/hooks/use-pdf-translation-selection";
import { usePdfViewerHandle } from "@/components/viewer/pdf/hooks/use-pdf-viewer-handle";
import { usePdfVisualMarks } from "@/components/viewer/pdf/hooks/use-pdf-visual-marks";
import { usePdfZoomControls } from "@/components/viewer/pdf/hooks/use-pdf-zoom-controls";
import { useReflowDisplayDocument } from "@/components/viewer/pdf/hooks/use-reflow-display-document";
import { useStableDerived } from "@/components/viewer/pdf/hooks/use-stable-derived";
import { PdfPageBitmapCacheLifecycle } from "@/components/viewer/pdf/layers/agentero-render-layer";
import {
	excludeOverlappingPdfTextLinks,
	type PdfTextLink,
} from "@/components/viewer/pdf/layers/citation-links";
import { COMMENT_RAIL_WIDTH_PX } from "@/components/viewer/pdf/layers/comment-cards-layer";
import { LayoutElementActions } from "@/components/viewer/pdf/layers/layout-element-actions";
import { PDF_LINK_ANNOTATION_CONFIG } from "@/components/viewer/pdf/layers/link-annotation";
import {
	type PdfPageHandlers,
	PdfPageLayers,
	type PdfPageLayoutSlice,
	type PdfPageMarksSlice,
	type PdfPageModeSlice,
} from "@/components/viewer/pdf/layers/page-layers";
import {
	layoutElementActionStore,
	setLayoutElementSelection,
} from "@/components/viewer/pdf/layout-element-action-store";
import {
	bindLayoutSentenceGlyphs,
	holdLayoutSentenceHover,
	publishLayoutSentenceCatalog,
	publishLayoutSentencePageAnalysis,
	suppressLayoutSentenceHover,
} from "@/components/viewer/pdf/layout-sentence-hover";
import { usePdfSentenceInteraction } from "@/components/viewer/pdf/layout-sentence-pairing";
import { buildMarksIndex } from "@/components/viewer/pdf/marks-index";
import { PdfTranslationViewerInner } from "@/components/viewer/pdf/pdf-translation-viewer-inner";
import { renderPdfRegionPromptImage } from "@/components/viewer/pdf/region-crop";
import type {
	PageAnnotationComment,
	PdfViewerInnerProps,
	PdfViewerProps,
	ScreenPoint,
	SelectionCommentDraft,
	SelectionMenuState,
} from "@/components/viewer/pdf/types";
import { ActiveCardScrollSync } from "@/components/viewer/pdf/viewport/active-card-scroll-sync";
import { DockviewViewport } from "@/components/viewer/pdf/viewport/dockview-viewport";
import { KeyboardScrollHandler } from "@/components/viewer/pdf/viewport/keyboard-scroll-handler";
import { PanDragHandler } from "@/components/viewer/pdf/viewport/pan-handler";
import { PdfHistoryKeyHandler } from "@/components/viewer/pdf/viewport/pdf-history-key-handler";
import { PdfScroller } from "@/components/viewer/pdf/viewport/pdf-scroller";
import { PdfVimKeyHandler } from "@/components/viewer/pdf/viewport/pdf-vim-key-handler";
import { RailPeek } from "@/components/viewer/pdf/viewport/rail-peek";
import { WheelZoomHandler } from "@/components/viewer/pdf/viewport/wheel-zoom-handler";
import {
	useLibraryStore,
	useSettings,
	useUiStore,
} from "@/hooks/use-app-stores";
import { presentAgentComposer } from "@/lib/agent/composer-focus";
import {
	createSelectionContext,
	pinSelection,
} from "@/lib/agent/selection-store";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { markOnce } from "@/lib/core/perf";
import { cn } from "@/lib/core/utils";
import { isPdfViewerSource } from "@/lib/paper";
import { arxivUrls } from "@/lib/paper/arxiv";
import { lookupSubmit } from "@/lib/paper/import-actions";
import {
	annotationWikilinkMarkdown,
	wikiTargetForPaper,
} from "@/lib/pdf/annotation-ref";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import { bookmarkPageIndex } from "@/lib/pdf/bookmark";
import {
	type EditableBookmark,
	removePageBookmark,
} from "@/lib/pdf/bookmark-edit";
import { embedPdfDocumentId } from "@/lib/pdf/document-id";
import { PdfHistoryPluginPackage } from "@/lib/pdf/highlight/history";
import { HIGHLIGHT_HEX_LIST } from "@/lib/pdf/highlight/palette";
import { partitionHighlightPaint } from "@/lib/pdf/highlight/translated-geometry";
import type { PdfTextMarkupKind } from "@/lib/pdf/highlight/types";
import {
	getPdfAiRuntime,
	layoutAnalysisStore,
	layoutDocumentKey,
	layoutSentenceScope,
	type PdfLayoutRegion,
	setFocusedLayoutRegion,
} from "@/lib/pdf/layout";
import {
	splitLayoutSentences,
	withHoverSentences,
} from "@/lib/pdf/layout/layout-sentences";
import {
	isInsideVisualLayoutRegion,
	sentenceHoverTextRegions,
} from "@/lib/pdf/layout/translatable";
import {
	clearTranslatedLinkSource,
	publishTranslatedLinkSource,
} from "@/lib/pdf/layout/translated-link-source";
import { selectionAnchorFromVisible } from "@/lib/pdf/layout/visible-selection-rects";
import {
	linkPreviewDragActive,
	subscribeLinkPreviewDrag,
} from "@/lib/pdf/link-preview-drag";
import type { PdfReloadPosition } from "@/lib/pdf/reload-position";
import { pickPdfSearchDocumentId } from "@/lib/pdf/search-target";
import {
	type ActiveSelectionCard,
	selectionAnchorKey,
} from "@/lib/pdf/selection";
import { isSelectionInsertionRegion } from "@/lib/pdf/selection-appearance";
import {
	tintedTranslateRecords,
	translateHighlightsByPage as translateHighlightsByPageOf,
	translateHighlightsFingerprint,
} from "@/lib/pdf/translate/highlights";
import {
	type PdfViewMode,
	readPdfViewMode,
	writePdfViewMode,
} from "@/lib/pdf/view-mode";
import { PDF_ZOOM_MAX, PDF_ZOOM_MIN } from "@/lib/pdf/zoom";
import { loadSettings } from "@/lib/settings";
import type { MenuContext } from "@/lib/shell/commands/menu-contributions";
import { layout } from "@/lib/shell/ui-store";
import { normalizePathKey, vaultRelativePath } from "@/lib/vault/path";
import { workspaceStore } from "@/lib/workspace/store";

export type {
	PdfViewerHandle,
	PdfViewerProps,
} from "@/components/viewer/pdf/types";

/** First document load or terminal error. No-op unless a perf trace is on. */
function PdfReadyMark({ ok }: { ok: boolean }) {
	useEffect(() => {
		markOnce("pdf_first_page", { anchor: "open", ok });
	}, [ok]);
	return null;
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
	const reloadPositionRef = useRef<PdfReloadPosition | null>(null);
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
		// Translation pane only needs raster + scroll/zoom + search. Skipping
		// selection, annotation, and ONNX layout avoids a second full viewer tax
		// when dual-pane translation opens beside the source.
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
					reading.pdfScrollStrategy === "paginated"
						? SpreadMode.None
						: reading.pdfSpreadMode === "odd"
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
			createPluginRegistration(RenderPluginPackage, {
				// Skip PNG encoding for opaque page rasters; crops explicitly use PNG.
				defaultImageType: "image/bmp",
			}),
			// Smaller tiles bound non-preemptible PDFium renders on heavy pages
			// without lowering pixel density.
			createPluginRegistration(TilingPluginPackage, { tileSize: 512 }),
			createPluginRegistration(ZoomPluginPackage, {
				defaultZoomLevel: ZoomMode.FitWidth,
				minZoom: PDF_ZOOM_MIN,
				maxZoom: PDF_ZOOM_MAX,
			}),
			createPluginRegistration(InteractionManagerPluginPackage),
			createPluginRegistration(SearchPluginPackage),
		];
		const interactive = [
			...core,
			createPluginRegistration(SelectionPluginPackage, {
				// Text selection is enough for the floating menu. EmbedPDF's built-in
				// marquee can be triggered by slight misses around glyphs and paints a
				// large blue rectangle over the page; visual region annotation uses our
				// explicit ScanSearch mode instead.
				marquee: { enabled: false },
			}),
			createPluginRegistration(PdfHistoryPluginPackage),
			createPluginRegistration(AnnotationPluginPackage, {
				...PDF_LINK_ANNOTATION_CONFIG,
				annotationAuthor: "Agentero",
				colorPresets: HIGHLIGHT_HEX_LIST,
				selectAfterCreate: false,
				deactivateToolAfterCreate: true,
			}),
		];
		// Native translated selection uses annotation/history without a PDF text layer.
		if (translationOnly) return interactive;
		return [
			...interactive,
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
				<PdfReadyMark ok={false} />
				<p className="p-6 text-destructive text-sm">
					{engineError.message || t("pdf.loadError")}
				</p>
			</div>
		);
	}

	if (engineLoading || !engine || !plugins) {
		return (
			<div id="agentero-pdf-host" className={hostClass}>
				<PageSkeleton label={t("pdf.loading")} />
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
				<PdfPageBitmapCacheLifecycle />
				<DocumentContent documentId={docId}>
					{({ isLoaded, isLoading, isError, documentState }) => {
						if (isError) {
							console.error(
								`[PdfViewer ${docId}] document load error:`,
								documentState.error,
								documentState.errorDetails,
							);
							return (
								<>
									<PdfReadyMark ok={false} />
									<p className="p-6 text-center text-destructive text-sm">
										{t("pdf.loadError")}
										{documentState.error ? `: ${documentState.error}` : null}
									</p>
								</>
							);
						}
						if (!isLoaded) {
							return isLoading ? (
								<PageSkeleton label={t("pdf.loading")} />
							) : (
								<p className="p-6 text-center text-muted-foreground text-sm">
									{t("pdf.empty")}
								</p>
							);
						}
						return (
							<>
								<PdfReadyMark ok />
								{props.translationOnly ? (
									<PdfTranslationViewerInner
										{...props}
										docId={docId}
										baseDocId={baseDocId}
										sourceBytes={effectiveSourceBytes}
										pdfCacheBytes={props.sourceBytes ?? null}
									/>
								) : (
									<PdfViewerInner
										{...props}
										docId={docId}
										baseDocId={baseDocId}
										sourceBytes={effectiveSourceBytes}
										pdfCacheBytes={props.sourceBytes ?? null}
										reloadPositionRef={reloadPositionRef}
									/>
								)}
							</>
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

/** Context for `pdf.selection`. Paper id only when this viewer already has one. */
function pdfSelectionMenuContext(input: {
	vaultPath: string | null;
	paperRelPath: string | null;
	paperAbsPath: string | null;
	paperId: string | undefined;
	selectionMenu: SelectionMenuState | null;
}): MenuContext {
	const direct = input.paperRelPath?.trim();
	let relPath = direct || undefined;
	if (!relPath && input.vaultPath && input.paperAbsPath) {
		relPath =
			vaultRelativePath(input.vaultPath, input.paperAbsPath) || undefined;
	}
	const selectionText =
		(
			input.selectionMenu?.copyText ?? input.selectionMenu?.anchor.quote
		)?.trim() || undefined;
	return {
		vaultPath: input.vaultPath,
		...(relPath ? { relPath } : {}),
		...(input.paperId ? { paperId: input.paperId } : {}),
		...(selectionText ? { selectionText } : {}),
	};
}

function PdfViewerInner({
	docId,
	baseDocId,
	embeddedTarget,
	embeddedTargetRequest,
	insetCommentCards = false,
	rememberReadingPosition = true,
	sourceBytes = null,
	paperAbsPath = null,
	paperRelPath = null,
	vaultPath = null,
	pdfCacheBytes = null,
	paperMeta: paperMetaProp = null,
	isActive = true,
	isRemotePaper = false,
	plainViewer = false,
	showBottomBar = false,
	translationPane = false,
	translationOnly = false,
	texRootPath = null,
	pdfPath = null,
	syncTexScope,
	cloudSyncBackward,
	reloadPositionRef,
	importIdentifier,
	onOpenSettings,
	onHandle,
	onHighlightsChange,
	onAsksChange,
	onVisualTracesChange,
	onOpenTranslationTab,
	onCloseTranslationTab,
}: PdfViewerInnerProps) {
	const { t } = useTranslation("viewer");
	// Writing previews own the hover affordance via SyncTeX; the reader's
	// sentence wash (and its whole-page text fallback) stays off there.
	const sentenceHover = syncTexScope !== "writing";
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
	const { provides: annotationCap } = useAnnotationCapability();
	const { provides: docCap } = useDocumentManagerCapability();
	const { provides: bookmarkCap } = useBookmarkCapability();
	const { provides: layoutCap } = useLayoutAnalysisCapability();

	// EmbedPDF's useScroll calls forDocument() every render and returns a fresh
	// scope object (createScrollScope). Never put `scroll` in useEffect deps —
	// only primitive readiness (scrollReady) or scrollState fields.
	const scrollRef = useRef(scroll);
	scrollRef.current = scroll;
	const scrollReady = Boolean(scroll);
	const layoutCapRef = useRef(layoutCap);
	layoutCapRef.current = layoutCap;
	// Zoom capability behind a ref for stable chrome callbacks (the scope
	// object, like scroll, is re-created per render).
	const zoomCapRef = useRef(zoom);
	zoomCapRef.current = zoom;

	// Keep EmbedPDF's raw LayoutAnalysisLayer off. Sidecar cache hits never
	// repopulate plugin page layouts, so that layer would stay empty; we paint
	// post-merge store regions instead (same set as Figures / hover targets).
	// Uses the capability (registry lookup, no plugin-state subscription):
	// the useLayoutAnalysis hook subscribes to per-page analysis state, so
	// each ONNX page result re-rendered the whole viewer.
	useEffect(() => {
		layoutCap?.setLayoutOverlayVisible(false);
	}, [layoutCap]);
	const engineRef = useRef(engine);
	engineRef.current = engine;
	const docCapRef = useRef(docCap);
	docCapRef.current = docCap;
	const captureRegion = useCallback(
		async (pageIndex: number, region: PdfAskNormalizedRect) => {
			const engine = engineRef.current;
			const document = docCapRef.current?.getDocument(docId);
			if (!engine || !document) throw new Error(t("pdfExplain.cropFailed"));
			return renderPdfRegionPromptImage({
				engine,
				document,
				pageIndex,
				region,
			});
		},
		[docId, t],
	);

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
	const pdfScrollStrategy = useSettings((s) => s.pdfScrollStrategy);
	const autoTranslateSelection = useSettings(
		(s) => s.translate.autoTranslateSelection,
	);
	// Reading view: 原文 / 译文 / 对照. Only the two single-pane choices persist;
	// 对照 is derived from the translation tab being open. While it is open the
	// single-pane underlay is pinned to 原文, so closing the tab falls back to
	// 原文 — never to a stale 译文.
	const [singleViewMode, setSingleViewMode] = useState<
		"original" | "translated"
	>(() => readPdfViewMode(paperKey));
	const translationEnsureAtRef = useRef(0);
	const restoredEnsureDoneRef = useRef(false);
	/** 对照 → 译文 closes the pane but keeps the running translation. */
	const paneCloseKeepsJobRef = useRef(false);
	const paneWasOpenRef = useRef(false);
	const isWorkspaceDoc = useStore(workspaceStore, (s) =>
		s.tabs.some((tab) => tab.id === baseDocId),
	);
	// Tab paths are absolute paper directories; paperRelPath is vault-relative,
	// so the pane lookup must use paperAbsPath when it is available.
	const translationPaneKey = paperAbsPath
		? normalizePathKey(paperAbsPath)
		: paperKey
			? normalizePathKey(paperKey)
			: null;
	const translationPaneOpen = useStore(workspaceStore, (s) => {
		if (!translationPaneKey || !isWorkspaceDoc) return false;
		return s.tabs.some(
			(tab) =>
				tab.pane === "translation" &&
				normalizePathKey(tab.path) === translationPaneKey,
		);
	});
	const viewMode: PdfViewMode = translationPaneOpen ? "dual" : singleViewMode;
	const showTranslatedPages = translationPane || viewMode === "translated";
	// 对照 is a comparison view: the left pane is the original, not 译文. Keep the
	// stored single-pane view at 原文 while the pane is open so closing the pane
	// (tab ×, ⇧⌘T cleanup, etc.) lands back on 原文 rather than a stale 译文.
	useEffect(() => {
		if (!isWorkspaceDoc || !translationPaneOpen) return;
		if (singleViewMode === "original") return;
		setSingleViewMode("original");
		writePdfViewMode(paperKey, "original");
	}, [isWorkspaceDoc, translationPaneOpen, singleViewMode, paperKey]);
	// Re-seed the persisted view and the ensure guards when this mounted viewer
	// is reused for another paper, and re-arm the one-shot restore when the PDF
	// is reloaded in place (same paper, new docId / wiped translation job).
	const viewModePaperRef = useRef<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: docId is not read here; it re-arms the guards when the same PDF reloads in place.
	useEffect(() => {
		if (viewModePaperRef.current !== paperKey) {
			viewModePaperRef.current = paperKey;
			setSingleViewMode(readPdfViewMode(paperKey));
		}
		translationEnsureAtRef.current = 0;
		restoredEnsureDoneRef.current = false;
	}, [paperKey, docId]);
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
	/**
	 * eLife figure supplements live on the web, not in the PDF. Their link text
	 * still names the main figure ("Figure 5—figure supplement 1"), so resolve
	 * the supplement to the publisher's direct image instead of cropping the
	 * main Figure 5.
	 */
	const supplementFigureUrl = useMemo(() => {
		if (!paperMeta) return undefined;
		const articleId =
			paperMeta.doi?.match(/^10\.7554\/e?life\.(\d+)/i)?.[1] ??
			(paperMeta.source_url ?? paperMeta.html_url ?? "").match(
				/elifesciences\.org\/articles\/(\d+)/i,
			)?.[1];
		if (!articleId) return undefined;
		return (figure: number, supplement: number) =>
			`https://elifesciences.org/articles/${articleId}/figures#fig${figure}s${supplement}`;
	}, [paperMeta]);
	/**
	 * The supplement URL is shown through the shared external-link preview card;
	 * its hook is created below the cross-reference preview, so route through a
	 * ref (same pattern as the sibling `clear*Ref` callbacks).
	 */
	const showSupplementUrlRef = useRef<
		(url: string, clientPoint?: ScreenPoint | null) => void
	>(() => {});
	const showSupplementUrl = useCallback(
		(url: string, clientPoint?: ScreenPoint | null) => {
			showSupplementUrlRef.current(url, clientPoint ?? null);
		},
		[],
	);

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

	const {
		pageField,
		setPageField,
		pageFocusedRef,
		goToPage,
		goToRegion,
		commitPageField,
	} = usePdfNavigation({
		docId,
		baseDocId,
		embeddedTarget,
		embeddedTargetRequest,
		docCapRef,
		paperKey: rememberReadingPosition ? paperKey : null,
		currentPage,
		totalPages,
		scroll,
		scrollRef,
		zoomRef: zoomCapRef,
		reloadPositionRef,
	});

	// Latest-ref wrappers: the hook's helpers close over the fresh-per-render
	// scroll scope, but the chrome consumers (outline panel, bottom bar) only
	// need a stable identity so their memo holds across page turns.
	const goToPageRef = useRef(goToPage);
	goToPageRef.current = goToPage;
	const handleGoToPage = useCallback((page: number) => {
		goToPageRef.current(page);
	}, []);
	const commitPageFieldRef = useRef(commitPageField);
	commitPageFieldRef.current = commitPageField;
	const handleCommitPageField = useCallback(() => {
		commitPageFieldRef.current();
	}, []);

	// ---- Highlights (EmbedPDF annotations) ----

	const {
		highlights,
		highlightsRef,
		highlightAnchors,
		citationLinks: nativeCitationLinks,
		createHighlights,
		updateHighlightComment,
		updateHighlightColor,
		deleteHighlightAnnotation,
		runAnnotationBatch,
		replayAnnotationHistory,
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
	// Only pinned results keep a source tint once their card is gone; an
	// unpinned record is discarded with its card, and any leftover (crashed
	// session, card that never got placed) would paint a highlight with no
	// translation behind it.
	const tintedTranslates = useStableDerived(
		() => tintedTranslateRecords(translates),
		translateHighlightsFingerprint(tintedTranslateRecords(translates)),
	);
	const translateHighlightsByPage = useStableDerived(
		() => translateHighlightsByPageOf(tintedTranslates),
		translateHighlightsFingerprint(tintedTranslates),
	);
	/**
	 * Per-page 0–1 text rects from PDFium `getPageTextRects` — used to decide
	 * whether a gutter pin sits on real glyphs (translucent) vs in a free gutter.
	 */
	const {
		pageTextMap,
		pageTextRects,
		pageTextLinkMap,
		pageTextMapRef,
		selectionTextExclusionsByPage,
		ensureSelectionTextExclusions,
	} = usePdfPageText({
		engine,
		docCap,
		docId,
		totalPages,
		currentPage,
		paperTitle,
		translates,
		threads,
		highlights,
		visualTraces,
	});
	/**
	 * Text links per page with native-link overlap excluded. Array identities
	 * are reused per page when that page's set did not change (the source maps
	 * churn as a whole whenever any single page loads its text geometry), so
	 * only affected pages' memoized layers re-render.
	 */
	const textLinksRef = useRef<Map<number, PdfTextLink[]> | null>(null);
	const textLinks = useMemo(() => {
		const prev = textLinksRef.current;
		const next = new Map<number, PdfTextLink[]>();
		let changed = !prev || prev.size !== pageTextLinkMap.size;
		for (const [pageIndex, links] of pageTextLinkMap) {
			const filtered = excludeOverlappingPdfTextLinks(
				links,
				nativeCitationLinks.get(pageIndex) ?? [],
			);
			const prevLinks = prev?.get(pageIndex);
			if (
				prevLinks &&
				prevLinks.length === filtered.length &&
				prevLinks.every((link, i) => link === filtered[i])
			) {
				next.set(pageIndex, prevLinks);
			} else {
				next.set(pageIndex, filtered);
				changed = true;
			}
		}
		if (!changed && prev) return prev;
		textLinksRef.current = next;
		return next;
	}, [pageTextLinkMap, nativeCitationLinks]);

	const hostRef = useRef<HTMLDivElement>(null);
	const immersiveReading = useUiStore((s) => s.immersiveReading);
	const [immersiveChrome, setImmersiveChrome] = useState(true);
	usePdfImmersivePosition(docId, hostRef, zoomCapRef);

	useEffect(() => {
		if (!immersiveReading) {
			setImmersiveChrome(true);
			return;
		}
		const root = hostRef.current;
		if (!root) return;
		setImmersiveChrome(true);
		const hide = () => {
			if (
				!root.querySelector(
					"[data-pdf-chrome]:hover, [data-pdf-chrome]:focus-within",
				)
			)
				setImmersiveChrome(false);
		};
		let timer = window.setTimeout(hide, 1800);
		const show = () => {
			setImmersiveChrome(true);
			window.clearTimeout(timer);
			timer = window.setTimeout(hide, 1800);
		};
		root.addEventListener("pointermove", show);
		root.addEventListener("pointerdown", show);
		root.addEventListener("focusin", show);
		root.addEventListener("focusout", show);
		return () => {
			window.clearTimeout(timer);
			root.removeEventListener("pointermove", show);
			root.removeEventListener("pointerdown", show);
			root.removeEventListener("focusin", show);
			root.removeEventListener("focusout", show);
		};
	}, [immersiveReading]);
	usePdfSyncTex({
		docId,
		tabId: baseDocId,
		rootPath: texRootPath,
		pdfPath,
		scope: syncTexScope,
		cloudSyncBackward,
		isActive,
		hostRef,
		navigate: goToRegion,
		docCapRef,
	});
	const selectionCommentEngagedRef = useRef(false);

	// ---- Text selection → floating action menu ----
	// Placed after hostRef/zoomRef: the hook anchors the menu against the page
	// element and needs both refs injected.
	const {
		selectionMenu,
		setSelectionMenu,
		isSelecting,
		selectionStartPageIndex,
		closeSelectionMenu,
		rePlaceSelectionMenu,
	} = usePdfTextSelection({
		ensureSelectionTextExclusions,
		engine,
		selectionTextExclusionsByPage,
		selectionCap,
		docCap,
		docId,
		hostRef,
		zoomRef,
		isActive,
		sideBySide: viewMode === "dual" && !translationPane,
		paperRelPath,
		paperAbsPath,
		isCommentDraftActive: () => selectionCommentEngagedRef.current,
		// A double-click in element selection opens the element action card; the
		// instant word/line selection of that same gesture must not open a second
		// toolbar underneath it (#1175).
		suppressSelectionMenu: () => {
			const action = layoutElementActionStore.getState().action;
			return (
				action != null &&
				layoutSentenceScope(action.docId) === layoutSentenceScope(docId)
			);
		},
	});

	useEffect(() => {
		// Read the capability through the ref. The provides object is replaced
		// as the document opens; closing over one render left glyph lookup on a
		// capability that did not yet know the PDF.
		if (!engine) return;
		return bindLayoutSentenceGlyphs({
			docId,
			engine,
			getDocument: () => docCapRef.current?.getDocument(docId) ?? null,
		});
	}, [docId, engine]);

	useEffect(() => {
		const root = hostRef.current;
		if (!root) return;
		root.toggleAttribute("data-pdf-selecting", isSelecting);
		if (isSelecting) suppressLayoutSentenceHover();
	}, [isSelecting]);

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
		setActiveCard,
		setCardScreen,
		openCard,
		hideActiveCard,
		syncActiveCardPosition,
		markCardHoverEnter,
		scheduleHoverHide,
	} = usePdfCards({
		isActive,
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
		docId,
		isActive,
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
		captureRegion,
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

	const { outline, outlineReady } = usePdfOutline({
		bookmarkCap,
		docId,
		totalPages,
		paperAbsPath,
		paperRelPath,
	});

	const bookmarkEditor = usePdfBookmarkEditor({
		path: isRemotePaper ? null : pdfPath,
		bytes: sourceBytes,
		outline,
		ready: outlineReady,
	});

	// Outline / references / figures own one left rail. The slot key is the PDF
	// path (embed id for loose PDFs), so the viewer remount caused by a bookmark
	// write keeps the panel the reader had open.
	const { activePanel, openPanel, togglePanel, closePanel } = usePdfLeftPanels(
		pdfPath ?? docId,
	);
	const showOutline = activePanel === "outline";
	const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);

	const bookmarkedPages = useMemo(() => {
		const pages = new Set<number>();
		const visit = (nodes: EditableBookmark[]) => {
			for (const node of nodes) {
				const page =
					"pageIndex" in node && typeof node.pageIndex === "number"
						? node.pageIndex
						: bookmarkPageIndex(node);
				if (node.pageBookmark && page !== null) pages.add(page);
				visit(node.children ?? []);
			}
		};
		visit(bookmarkEditor.nodes);
		return pages;
	}, [bookmarkEditor.nodes]);
	const handleBookmarkPage = useCallback(
		(pageIndex: number) => {
			if (bookmarkEditor.draft?.saving) return;
			bookmarkEditor.begin();
			if (bookmarkedPages.has(pageIndex)) {
				bookmarkEditor.change(
					removePageBookmark(bookmarkEditor.nodes, pageIndex),
				);
			} else {
				bookmarkEditor.change([
					...bookmarkEditor.nodes,
					{
						id: crypto.randomUUID(),
						origin: null,
						title: t("pdf.bookmarks.defaultTitle", { page: pageIndex + 1 }),
						pageBookmark: true,
						pageIndex,
						children: [],
					},
				]);
			}
		},
		[
			bookmarkEditor.begin,
			bookmarkEditor.change,
			bookmarkEditor.draft,
			bookmarkedPages,
			bookmarkEditor.nodes,
			t,
		],
	);

	// ---- In-text citation / internal PDF links ----

	// Sibling clear refs so citation ↔ crossref can dismiss each other without
	// a circular hook dependency (Fix #430 overlay exclusivity).
	const clearCrossrefPreviewRef = useRef<() => void>(() => {});
	const clearCitationPreviewRef = useRef<() => void>(() => {});
	const clearLinkUrlTipRef = useRef<() => void>(() => {});

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
		citationLinks,
		scheduleCitationHide,
		markCitationHoverEnter,
		clearCitationPreview,
		handleCitationLinkActivate,
		handleCitationLinkHover,
		hasCitationMatch,
		citationImport,
		pageOrigins,
	} = usePdfCitations({
		pageTextRects,
		nativeCitationLinks,
		engineRef,
		docCapRef,
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
		onPreviewShow: () => {
			clearCrossrefPreviewRef.current();
			clearLinkUrlTipRef.current();
		},
		onBeforeInternalJump: captureJumpOrigin,
		onInternalJump: (target) => {
			// Same as the citation card: the scroll strands a stationary pointer,
			// so dismiss the crossref preview with the jump it caused (#528).
			clearCrossrefPreviewRef.current();
			clearLinkUrlTipRef.current();
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
		onPreviewShow: () => {
			clearCitationPreviewRef.current();
			clearLinkUrlTipRef.current();
		},
		hasCitationMatch,
		supplementImageUrl: supplementFigureUrl,
		onSupplementPreview: showSupplementUrl,
	});

	const {
		linkUrlTip,
		scheduleLinkUrlHide,
		markLinkUrlHoverEnter,
		clearLinkUrlTip,
		handleLinkUrlHover: hoverLinkUrl,
	} = usePdfLinkUrlTip();

	clearCitationPreviewRef.current = clearCitationPreview;
	clearCrossrefPreviewRef.current = clearCrossrefPreview;
	clearLinkUrlTipRef.current = clearLinkUrlTip;
	showSupplementUrlRef.current = hoverLinkUrl;

	// Hover intent (#1213): a card opens only after the pointer has rested on a
	// link. Crossing dense citation / figure links on the way somewhere else
	// must not flash a card or start the async crop behind it; leaving cancels
	// the pending open. Hiding stays with the cards' sticky-hover timers.
	const showLinkPreview = useCallback(
		(payload: {
			link: PdfLinkAnnoObject;
			clientPoint?: ScreenPoint | null;
		}) => {
			handleCitationLinkHover(payload.link, payload.clientPoint);
			handleCrossrefLinkHover(payload.link, payload.clientPoint);
		},
		[handleCitationLinkHover, handleCrossrefLinkHover],
	);
	const hideLinkPreview = useCallback(() => {
		handleCitationLinkHover(null);
		handleCrossrefLinkHover(null);
	}, [handleCitationLinkHover, handleCrossrefLinkHover]);
	const linkHoverIntent = useHoverIntent({
		delayMs: EPHEMERAL_PREVIEW_OPEN_MS,
		onOpen: showLinkPreview,
		onLeave: hideLinkPreview,
	});
	const showUrlTip = useCallback(
		(payload: { url: string; clientPoint: ScreenPoint }) => {
			hoverLinkUrl(payload.url, payload.clientPoint);
		},
		[hoverLinkUrl],
	);
	const hideUrlTip = useCallback(() => {
		hoverLinkUrl(null);
	}, [hoverLinkUrl]);
	const urlHoverIntent = useHoverIntent({
		delayMs: EPHEMERAL_PREVIEW_OPEN_MS,
		onOpen: showUrlTip,
		onLeave: hideUrlTip,
	});
	// A pending open belongs to the document it was started on.
	// biome-ignore lint/correctness/useExhaustiveDependencies: docId is the effect trigger.
	useEffect(() => {
		linkHoverIntent.cancel();
		urlHoverIntent.cancel();
	}, [docId]);

	const { askPinAnchors } = usePdfPinAnchors({ threads });
	// Fingerprint computed only when `translates` changes identity: streamed
	// chunks replace the array, but hover / page turns re-render the viewer
	// without touching it, so the eager stringify ran for nothing.
	const pinnedTranslatesFingerprint = useMemo(
		() =>
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
		[translates],
	);
	const pinnedTranslates = useStableDerived(
		() => translates.filter((record) => record.pinned),
		pinnedTranslatesFingerprint,
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
		layoutDocRegions,
		selectableRegionsByPage,
		rawRegionsByPage,
		startLayoutAnalysisRef,
		layoutTaskRef,
		handleAnalyzeLayout,
		handleJumpToLayoutRegion,
		handleRenderLayoutThumb,
		reflowReady,
		reflowOutput,
		exportTranslatedPdf,
		layoutTranslateItemsByPage,
		layoutTranslatePageStateByPage,
		layoutTranslateRunning,
		layoutTranslatePreparing,
		layoutTranslateWaiting,
		layoutTranslateQueued,
		layoutTranslateActive,
		layoutTranslatePartial,
		layoutTranslateProgress,
		layoutTranslatePageCounts,
		toggleLayoutTranslate,
		ensureLayoutTranslate,
		showLayoutTranslate,
		cancelLayoutTranslate,
		togglePageLayoutTranslate,
		retryPageLayoutTranslate,
	} = usePdfLayoutCluster({
		docId,
		translationPane,
		totalPages,
		isActive,
		paperAbsPath,
		paperRelPath,
		paperKey,
		vaultPath,
		pdfBytes: pdfCacheBytes ?? sourceBytes,
		layoutCap,
		layoutCapRef,
		docCap,
		docCapRef,
		engineRef,
		scrollRef,
		isRemotePaper,
		plainViewer,
	});

	useEffect(() => {
		if (!sentenceHover) {
			publishLayoutSentenceCatalog(docId, []);
			publishLayoutSentencePageAnalysis(docId, []);
			return;
		}
		const rawRegions = layoutRawRegions ?? [];
		const allTranslated = [...layoutTranslateItemsByPage.values()].flat();
		const translatedIds = new Set(allTranslated.map((item) => item.id));
		// The model also detects the text inside vector figures / tables as prose
		// blocks. Those runs are part of the graphic, so they never hover as
		// sentences; the whole element is the hover target instead.
		const translated = allTranslated
			.filter((item) => !isInsideVisualLayoutRegion(item, rawRegions))
			.map((item) => withHoverSentences(item));
		const source = sentenceHoverTextRegions(rawRegions)
			.filter((region) => !translatedIds.has(region.id))
			.map((region) => ({
				id: region.id,
				pageIndex: region.pageIndex,
				bbox: region.bbox,
				source: region.text ?? "",
				sentences: splitLayoutSentences(region.text ?? "").map((quote) => ({
					quote,
					translated: "",
				})),
			}));
		// Analysed pages keep sentence hover on their text regions only; the
		// whole-page text fallback is reserved for pages without analysis.
		publishLayoutSentencePageAnalysis(docId, [
			...rawRegions.map((region) => region.pageIndex),
			...(layoutDocRegions ?? []).map((region) => region.pageIndex),
		]);
		publishLayoutSentenceCatalog(docId, [...source, ...translated]);
	}, [
		docId,
		layoutTranslateItemsByPage,
		layoutRawRegions,
		layoutDocRegions,
		sentenceHover,
	]);
	// Clear only when the document changes. Declared after the publish effect so
	// its cleanup runs first and the next publish restores the new document's
	// pairs. An items-only update must not flash an empty catalog.
	useEffect(() => {
		return () => {
			publishLayoutSentenceCatalog(docId, []);
			publishLayoutSentencePageAnalysis(docId, []);
		};
	}, [docId]);

	const reflowDisplayDocument = useReflowDisplayDocument(
		docCap,
		reflowOutput,
		docId,
	);
	const translationShown =
		showTranslatedPages && layoutTranslatePageStateByPage.size > 0;
	const searchDocumentId = pickPdfSearchDocumentId({
		sourceDocumentId: docId,
		translatedDocumentId: reflowDisplayDocument?.id,
		translationVisible: translationShown,
	});
	const { state: searchState, provides: search } = useSearch(searchDocumentId);
	const searchScale = searchDocumentId === docId ? undefined : zoomLevel;

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

	// Same latest-ref pattern as navigation: findNext / findPrev / closeFind
	// are re-created per render but the find bar only needs stable identities.
	const findNextRef = useRef(findNext);
	findNextRef.current = findNext;
	const handleFindNext = useCallback(() => {
		findNextRef.current();
	}, []);
	const findPrevRef = useRef(findPrev);
	findPrevRef.current = findPrev;
	const handleFindPrev = useCallback(() => {
		findPrevRef.current();
	}, []);
	const closeFindRef = useRef(closeFind);
	closeFindRef.current = closeFind;
	const handleCloseFind = useCallback(() => {
		closeFindRef.current();
	}, []);

	usePdfTranslationSelection({
		enabled:
			showTranslatedPages &&
			layoutTranslateActive &&
			!translationOnly &&
			!plainViewer,
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

	// The meter's stop square ends the whole visible run: a live Host job, a
	// queued wait, and — once the job has settled — the local page generation
	// that is still producing the corrected pages.
	const stopLayoutTranslateWithTypeset = useCallback(() => {
		cancelLayoutTranslate({ stopTypeset: true });
	}, [cancelLayoutTranslate]);

	// The view switch owns the single-pane / compare choice. The toolbar's task
	// surface (the expanding meter) only stops or cancels, never toggles views.
	const hasAnyTranslation = useMemo(
		() =>
			[...layoutTranslateItemsByPage.values()].some((items) =>
				items.some((item) => Boolean(item.translated?.trim())),
			),
		[layoutTranslateItemsByPage],
	);
	const ensureLayoutTranslateRef = useRef(ensureLayoutTranslate);
	ensureLayoutTranslateRef.current = ensureLayoutTranslate;

	const ensureTranslationForReading = useCallback(
		(options?: { completePending?: boolean }) => {
			// A live task already owns the paper. Showing the view is enough.
			if (
				layoutTranslateRunning ||
				layoutTranslateWaiting ||
				layoutTranslatePreparing ||
				layoutTranslateQueued
			) {
				return;
			}
			// Entering 译文 from a user gesture fills gaps after the cache paints.
			// The 1000ms window stays on restore only, so a gesture is not dropped.
			if (options?.completePending) {
				ensureLayoutTranslateRef.current({ completePending: true });
				return;
			}
			if (hasAnyTranslation) return;
			// The toolbar click and the mount effect can race within one tick; the
			// short window keeps one start while still allowing a later retry.
			const now = Date.now();
			if (now - translationEnsureAtRef.current < 1000) return;
			translationEnsureAtRef.current = now;
			ensureLayoutTranslateRef.current();
		},
		[
			hasAnyTranslation,
			layoutTranslateRunning,
			layoutTranslateWaiting,
			layoutTranslatePreparing,
			layoutTranslateQueued,
		],
	);

	const handleSelectViewMode = useCallback(
		(next: PdfViewMode) => {
			if (translationOnly || plainViewer || isRemotePaper) return;
			if (next === "dual") {
				if (!onOpenTranslationTab) return;
				if (!translationPaneOpen) {
					if (!paperAbsPath) {
						notifyError(t("pdf.viewMode.paneUnavailable"));
						return;
					}
					// 对照 always sits on the original source pane: leave 译文 first,
					// then split the translation pane out. Closing that pane later
					// falls back to this 原文 state.
					setSingleViewMode("original");
					writePdfViewMode(paperKey, "original");
					onOpenTranslationTab?.(baseDocId, paperAbsPath, paperTitle ?? null);
				}
				// 对照 reads the same translation as 译文: validate the cache / start
				// the shared job from the source pane too, so the split pane always
				// opens onto a live job or completed cache. The pane's own
				// auto-start stays as the fallback when the source cannot start it.
				ensureTranslationForReading();
				return;
			}
			if (next === "original") {
				// 原文 is the "no translation" mode: close the comparison pane and
				// kill the running job so the view and the task state agree.
				paneCloseKeepsJobRef.current = false;
				if (translationPaneOpen) onCloseTranslationTab?.(baseDocId);
				setSingleViewMode("original");
				writePdfViewMode(paperKey, "original");
				cancelLayoutTranslate();
				return;
			}
			// 译文: close the comparison pane but let the translation keep running
			// (cached pages show immediately; a running job keeps streaming).
			if (translationPaneOpen) {
				paneCloseKeepsJobRef.current = true;
				onCloseTranslationTab?.(baseDocId);
			}
			setSingleViewMode("translated");
			writePdfViewMode(paperKey, "translated");
			showLayoutTranslate();
			ensureTranslationForReading({ completePending: true });
		},
		[
			translationOnly,
			plainViewer,
			isRemotePaper,
			translationPaneOpen,
			paperAbsPath,
			onOpenTranslationTab,
			baseDocId,
			paperTitle,
			onCloseTranslationTab,
			paperKey,
			showLayoutTranslate,
			cancelLayoutTranslate,
			ensureTranslationForReading,
			t,
		],
	);

	// Closing the 对照 pane by hand (tab ×, re-open cleanup) means the reader is
	// back on 原文; that mode has no translation task, so cancel it. The one
	// exception is 对照 → 译文, which closes the pane but keeps translating.
	useEffect(() => {
		const wasOpen = paneWasOpenRef.current;
		paneWasOpenRef.current = translationPaneOpen;
		if (!isWorkspaceDoc || !wasOpen || translationPaneOpen) return;
		const keepJob = paneCloseKeepsJobRef.current;
		paneCloseKeepsJobRef.current = false;
		if (keepJob) return;
		setSingleViewMode("original");
		writePdfViewMode(paperKey, "original");
		cancelLayoutTranslate();
	}, [translationPaneOpen, isWorkspaceDoc, paperKey, cancelLayoutTranslate]);

	// ⌥A toggles the reading view: 原文 ↔ 译文 (leaving 对照 closes its pane).
	// Stopping a run stays on the meter.
	const handleToggleTranslationView = useCallback(() => {
		handleSelectViewMode(viewMode === "original" ? "translated" : "original");
	}, [handleSelectViewMode, viewMode]);

	// A paper reopened in 译文 has no in-memory translation blocks yet: attach to
	// the cache-first job once so the switch does not land on a blank layer.
	useEffect(() => {
		if (restoredEnsureDoneRef.current) return;
		if (translationPane || translationOnly || plainViewer || isRemotePaper)
			return;
		// Only the active workspace reader auto-attaches: inline wiki embeds and
		// inactive keep-alive tabs must not start full-document jobs by themselves.
		if (!isWorkspaceDoc || !isActive) return;
		if (viewMode !== "translated") return;
		restoredEnsureDoneRef.current = true;
		ensureTranslationForReading();
	}, [
		translationPane,
		translationOnly,
		plainViewer,
		isRemotePaper,
		isWorkspaceDoc,
		isActive,
		viewMode,
		ensureTranslationForReading,
	]);

	const { smartHighlightBusy, handleSmartHighlight } = usePdfSmartHighlights({
		vaultPath,
		paperRelPath,
		createHighlights,
		t,
	});

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
	// (#430). Translation drags are DOM selections, so EmbedPDF never sets
	// `isSelecting`; handlers also read `linkPreviewDragActive`, which flips
	// synchronously and must not be copied into this render snapshot. Keep
	// previews suppressed while the selection action menu remains open so
	// reference cards cannot stack on top of the selection controls.
	const suppressLinkPreviews =
		Boolean(activeCard) || Boolean(selectionMenu) || isSelecting;

	useEffect(() => {
		return subscribeLinkPreviewDrag(() => {
			linkHoverIntent.cancel();
			urlHoverIntent.cancel();
			clearCitationPreview();
			clearCrossrefPreview();
			clearLinkUrlTip();
		});
	}, [
		linkHoverIntent,
		urlHoverIntent,
		clearCitationPreview,
		clearCrossrefPreview,
		clearLinkUrlTip,
	]);

	useEffect(() => {
		if (!suppressLinkPreviews) return;
		linkHoverIntent.cancel();
		urlHoverIntent.cancel();
		clearCitationPreview();
		clearCrossrefPreview();
		clearLinkUrlTip();
	}, [
		suppressLinkPreviews,
		linkHoverIntent,
		urlHoverIntent,
		clearCitationPreview,
		clearCrossrefPreview,
		clearLinkUrlTip,
	]);

	const handleLinkHover = useCallback(
		(link: PdfLinkAnnoObject | null, clientPoint?: ScreenPoint | null) => {
			if (suppressLinkPreviews || linkPreviewDragActive()) {
				linkHoverIntent.cancel();
				urlHoverIntent.cancel();
				clearCitationPreview();
				clearCrossrefPreview();
				clearLinkUrlTip();
				return;
			}
			if (!link) {
				linkHoverIntent.leave();
				return;
			}
			linkHoverIntent.enter({ link, clientPoint });
		},
		[
			suppressLinkPreviews,
			linkHoverIntent,
			urlHoverIntent,
			clearCitationPreview,
			clearCrossrefPreview,
			clearLinkUrlTip,
		],
	);

	const handleLinkUrlHover = useCallback(
		(url: string | null, clientPoint?: ScreenPoint | null) => {
			if (suppressLinkPreviews || linkPreviewDragActive()) {
				urlHoverIntent.cancel();
				clearLinkUrlTip();
				return;
			}
			const trimmed = url?.trim() ?? "";
			if (!trimmed || !clientPoint) {
				urlHoverIntent.leave();
				return;
			}
			urlHoverIntent.enter({ url: trimmed, clientPoint });
		},
		[suppressLinkPreviews, urlHoverIntent, clearLinkUrlTip],
	);

	// ---- Visual marks ----

	const {
		saveVisualNote,
		updateVisualComment,
		handleVisualAddToChatById,
		deleteVisualTraceById,
	} = usePdfVisualMarks({
		paperAbsPath,
		paperRelPath,
		visualTracesRef,
		setVisualTraces,
		upsertVisualTrace,
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

	/**
	 * Owning page (1-based) of each rail comment. Used to gate
	 * `hoveredCommentId` per page: only the page that owns the hovered
	 * comment needs to re-render on hover, instead of every mounted page
	 * through the shared marks bundle.
	 */
	const commentPageById = useMemo(() => {
		const map = new Map<string, number>();
		for (const [page, comments] of commentsByPage) {
			for (const comment of comments) map.set(comment.id, page);
		}
		return map;
	}, [commentsByPage]);
	const hoveredCommentPage = hoveredCommentId
		? (commentPageById.get(hoveredCommentId) ?? 0)
		: 0;
	/** Drives the right-edge peek: only pan when this page has cards to show. */
	const hasCommentsOnPage = useCallback(
		(pageNumber: number) => (commentsByPage.get(pageNumber)?.length ?? 0) > 0,
		[commentsByPage],
	);

	const {
		handleOpenPin,
		handleEditHighlightAnnotation,
		handleDeleteHighlightAnnotation,
		handleChangeHighlightColor,
	} = usePdfMarkActions({
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
	});

	// ---- Layout element selection ----

	const elementSelectionEnabled = useStore(
		layoutElementActionStore,
		(state) => state.selectionDocumentId === layoutSentenceScope(docId),
	);
	const elementSelecting =
		elementSelectionEnabled && !plainViewer && !isRemotePaper;
	const toggleElementSelection = useCallback(() => {
		if (
			plainViewer ||
			isRemotePaper ||
			!engine ||
			(!elementSelectionEnabled && selectableRegionsByPage.size === 0)
		)
			return;
		closeSelectionMenu();
		selectionCap?.clear(docId);
		setLayoutElementSelection(docId, !elementSelectionEnabled);
	}, [
		docId,
		elementSelectionEnabled,
		plainViewer,
		isRemotePaper,
		engine,
		selectableRegionsByPage,
		closeSelectionMenu,
		selectionCap,
	]);

	useEffect(() => {
		return () => setLayoutElementSelection(docId, false);
	}, [docId]);

	useEffect(() => {
		if (!elementSelecting) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			// The first Escape dismisses an open element menu; the next leaves inspection.
			if (layoutElementActionStore.getState().action) return;
			event.preventDefault();
			closeSelectionMenu();
			setLayoutElementSelection(docId, false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [docId, elementSelecting, closeSelectionMenu]);

	usePdfSentenceInteraction(
		docId,
		hostRef,
		(sentence, event) => {
			const doc = docCapRef.current?.getDocument(docId);
			// The document manager can still be opening. Fall back to the rendered
			// page box so the source pane's double-click is not a no-op.
			const zoom = zoomRef.current > 0 ? zoomRef.current : 1;
			const sizeFor = (pageIndex: number) => {
				const size = doc?.pages[pageIndex]?.size;
				if (size) return size;
				const box = pageElByIndex(
					hostRef.current,
					pageIndex,
				)?.getBoundingClientRect();
				return box && box.width > 0 && box.height > 0
					? { width: box.width / zoom, height: box.height / zoom }
					: null;
			};
			const pages = [
				...new Set(sentence.members.map((member) => member.pageIndex)),
			].flatMap((pageIndex) => {
				const size = sizeFor(pageIndex);
				if (!size) return [];
				return formattedSelectionPage(
					pageIndex,
					sentence.members
						.filter((member) => member.pageIndex === pageIndex)
						.flatMap((member) => member.rects),
					size,
				);
			});
			const rects = sentence.members
				.filter((member) => member.pageIndex === sentence.pageIndex)
				.flatMap((member) => member.rects);
			// Page-fraction rects are enough for the toolbar anchor, so a missing
			// document size only disables highlight creation, not the menu.
			const anchor =
				anchorFromEmbedSelection(
					pages,
					sentence.quote,
					sizeFor,
					"selection",
					sentence.pageIndex,
				) ??
				(rects.length
					? {
							page: sentence.pageIndex + 1,
							rects,
							quote: sentence.quote,
							trigger: "selection" as const,
						}
					: null);
			const bounds = selectionBoundsOnScreen(
				pageElByIndex(hostRef.current, sentence.pageIndex),
				rects,
			);
			if (!anchor || !bounds) return;
			selectionCap?.clear(docId);
			holdLayoutSentenceHover(docId);
			setSelectionMenu({
				anchor,
				pages,
				screen: {
					x: (bounds.left + bounds.right) / 2,
					y: bounds.top,
					top: bounds.top,
					bottom: bounds.bottom,
					cursorX: event.clientX,
				},
			});
		},
		{ enabled: sentenceHover },
	);

	// ---- Selection action menu ----

	const {
		handleHighlight,
		handleCommitSelectionNote,
		handleMenuAsk,
		handleMenuAddToChat,
		handleMenuTranslate,
		handleMenuCopy,
	} = usePdfSelectionActions({
		runAnnotationBatch,
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
		const anchorKey = selectionAnchorKey(selectionMenu?.anchor);
		if (!isActive) {
			autoTranslatedSelectionRef.current = anchorKey;
			return;
		}
		// The translation overlay already has this sentence's translation.
		// Sending the recovered English back would open another translate card.
		if (selectionMenu?.fromTranslation) return;
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
	}, [
		autoTranslateSelection,
		isActive,
		plainViewer,
		selectionMenu,
		translateSelection,
	]);

	// Keep the clicked selection while focusing the comment editor clears it.
	const [selectionCommentDraft, setSelectionCommentDraft] =
		useState<SelectionCommentDraft | null>(null);
	const selectionCommentDraftRef = useRef(selectionCommentDraft);
	selectionCommentDraftRef.current = selectionCommentDraft;
	const selectionMenuRef = useRef(selectionMenu);
	selectionMenuRef.current = selectionMenu;
	const selectionCommentKeyValue = selectionCommentKey(selectionMenu);

	useEffect(() => {
		if (isRemotePaper || plainViewer || selectionCommentKeyValue) {
			selectionCommentEngagedRef.current = false;
			setSelectionCommentDraft(null);
		}
	}, [isRemotePaper, plainViewer, selectionCommentKeyValue]);

	const beginSelectionComment = useCallback((draft: SelectionCommentDraft) => {
		selectionCommentEngagedRef.current = true;
		setSelectionCommentDraft(draft);
	}, []);

	const handleMenuNote = useCallback(
		(shape: PdfTextMarkupKind = "highlight") => {
			const menu = selectionMenuRef.current;
			if (!menu?.pages.length || isRemotePaper || plainViewer) return;
			const visible = selectionAnchorFromVisible(menu.visiblePages ?? []);
			beginSelectionComment({
				page: visible?.page ?? menu.anchor.page,
				anchorY: visible?.anchorY ?? menu.anchor.rects[0]?.y ?? 0,
				quote: menu.anchor.quote ?? "",
				shape,
				pages: menu.pages,
				visiblePages: menu.visiblePages,
			});
			closeSelectionMenu();
		},
		[isRemotePaper, plainViewer, beginSelectionComment, closeSelectionMenu],
	);

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
			if (!draft) return;
			if (draft.visualRegion) {
				const region = draft.visualRegion;
				void captureRegion(draft.page - 1, region).then(
					(image) =>
						saveVisualNote(draft.page, region, comment, image).catch((error) =>
							notifyError(errorText(error)),
						),
					() => notifyError(t("pdfExplain.cropFailed")),
				);
				return;
			}
			handleCommitSelectionNote(
				{
					pages: draft.pages,
					quote: draft.quote,
					shape: draft.shape,
					visiblePages: draft.visiblePages,
				},
				comment,
			);
		},
		[
			captureRegion,
			saveVisualNote,
			handleCommitSelectionNote,
			closeSelectionMenu,
			t,
		],
	);

	// ---- In-PDF highlight selection menu ----

	const rePlaceFloatingOnScroll = useCallback(() => {
		syncActiveCardPosition();
		rePlaceSelectionMenu();
	}, [syncActiveCardPosition, rePlaceSelectionMenu]);

	// Boolean only — do not depend on selectionMenu.screen or re-place loops.
	const selectionMenuOpen = selectionMenu != null;

	// Update page-anchored cards and the selection toolbar on scroll and zoom.
	// Use scrollReady (boolean)
	// — not `scroll` — because EmbedPDF returns a new scope object every render;
	// depending on it re-fired this effect → setCardScreen → re-render →
	// Maximum update depth when a modal card was open.
	// Native wheel scroll is handled by ActiveCardScrollSync (viewport element).
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrollReady/zoomLevel are intentional re-place triggers
	useEffect(() => {
		if (!activeCard && !selectionMenuOpen) return;
		rePlaceFloatingOnScroll();
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
		zoomLevel,
		rePlaceFloatingOnScroll,
	]);

	usePdfViewerHandle({
		docId,
		goToRegion,
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
		toggleElementSelection,
		// ⌥A toggles 原文 / 译文; 对照 is entered from the toolbar switch.
		toggleLayoutTranslate: handleToggleTranslationView,
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
	useEffect(() => {
		if (translationPane) return;
		return () => clearTranslatedLinkSource(baseDocId);
	}, [translationPane, baseDocId]);

	const { inkByKey: linkInkByKey, runsByPage: glyphRunsByPage } = usePdfLinkInk(
		{
			engine,
			docCapRef,
			docId,
			itemsByPage: layoutTranslateItemsByPage,
			citationLinks,
			textLinks,
			scrollRef,
			scrollReady,
		},
	);
	useEffect(() => {
		if (translationPane) return;
		publishTranslatedLinkSource(baseDocId, {
			citationLinks,
			textLinks,
			pageOrigins,
			inkByKey: linkInkByKey,
			glyphRunsByPage,
		});
	}, [
		translationPane,
		baseDocId,
		citationLinks,
		textLinks,
		pageOrigins,
		linkInkByKey,
		glyphRunsByPage,
	]);

	// A translate card that was never placed (retry budget exhausted) must not
	// keep painting its source tint: the highlight belongs to a visible card.
	const translateCardPlaced = cardScreen != null;
	const pageMarks = useMemo<PdfPageMarksSlice>(
		() => ({
			activeAskAnchor,
			activeTranslateAnchor: translateCardPlaced ? activeTranslateAnchor : null,
			activeVisualTrace,
			focusedLayoutRegion,
			focusedLayoutFlash,
			focusedLayoutFlashToken,
			persistentRegion: embeddedTarget?.region,
			pinsByPage,
			commentsByPage,
			editingCommentId: railEdit?.id ?? null,
			commentWikiTarget,
			citationLinks,
			textLinks,
			activeCardId: activeCard?.id ?? null,
			// hoveredCommentId deliberately not bundled: it is passed as a
			// per-page gated prop in renderPage so a comment hover re-renders
			// only the owning page, not every page sharing this bundle.
			selectionCommentDraft,
			translateHighlightsByPage,
			highlightQuotesByPage,
			translatedHighlightsByPage,
		}),
		[
			activeAskAnchor,
			activeTranslateAnchor,
			activeVisualTrace,
			focusedLayoutRegion,
			focusedLayoutFlash,
			focusedLayoutFlashToken,
			embeddedTarget,
			pinsByPage,
			commentsByPage,
			railEdit?.id,
			commentWikiTarget,
			citationLinks,
			textLinks,
			activeCard?.id,
			translateCardPlaced,
			selectionCommentDraft,
			translateHighlightsByPage,
			highlightQuotesByPage,
			translatedHighlightsByPage,
		],
	);

	const selectionInsertionRegions = useMemo(
		() =>
			[...(layoutRawRegions ?? []), ...(layoutDocRegions ?? [])].filter(
				isSelectionInsertionRegion,
			),
		[layoutRawRegions, layoutDocRegions],
	);
	const pageLayout = useMemo<PdfPageLayoutSlice>(
		() => ({
			selectionInsertionRegions,
			selectionStartPageIndex,
			selectionTextExclusionsByPage,
			selectableRegionsByPage,
			rawRegionsByPage,
			layoutOverlayVisible,
			layoutTranslateItemsByPage: showTranslatedPages
				? layoutTranslateItemsByPage
				: new Map(),
			layoutTranslatePageStateByPage: showTranslatedPages
				? layoutTranslatePageStateByPage
				: new Map(),
			sentenceRectsByItemId,
			linkInkByKey,
			glyphRunsByPage,
		}),
		[
			selectableRegionsByPage,
			rawRegionsByPage,
			selectionTextExclusionsByPage,
			selectionInsertionRegions,
			layoutOverlayVisible,
			selectionStartPageIndex,
			layoutTranslateItemsByPage,
			layoutTranslatePageStateByPage,
			showTranslatedPages,
			sentenceRectsByItemId,
			linkInkByKey,
			glyphRunsByPage,
		],
	);

	const pageMode = useMemo<PdfPageModeSlice>(
		() => ({
			elementSelecting,
			insetCommentCards,
			translationOnly,
			plainViewer,
			sentencePairing: sentenceHover,
		}),
		[
			elementSelecting,
			translationOnly,
			plainViewer,
			insetCommentCards,
			sentenceHover,
		],
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
			if (comment.kind === "visual") {
				handleVisualAddToChatById(comment.id);
				return;
			}
			const selection = createSelectionContext({
				text: comment.quote,
				sourcePath: paperRelPath ?? paperAbsPath ?? "PDF",
				origin: "pdf",
				page: comment.pageIndex + 1,
				rects: comment.rects,
				paperAbsPath: paperAbsPath ?? undefined,
				comment: comment.comment,
			});
			if (!selection) return;
			// Stable id: adding the same saved note again refreshes that block.
			pinSelection({ ...selection, id: `ann-${comment.id}` });
			presentAgentComposer({ preserveCaret: true });
		},
		[handleVisualAddToChatById, paperAbsPath, paperRelPath],
	);

	// Page tags stay available in every view, but they must not toggle a hidden
	// overlay that is not painted. 原文 first reveals 译文; 对照's source pane has
	// no overlay at all, so its tags defer to the translation pane.
	const handleTogglePageTranslate = useCallback(
		(pageIndex: number) => {
			if (viewMode === "dual") return;
			if (viewMode === "original") {
				setSingleViewMode("translated");
				writePdfViewMode(paperKey, "translated");
				showLayoutTranslate();
				const pageHasTranslation = (
					layoutTranslateItemsByPage.get(pageIndex) ?? []
				).some((item) => Boolean(item.translated?.trim()));
				// The tag is entering 译文. A page that already has text reveals
				// the view and fills the other missing blocks; an untranslated
				// page still starts that page only.
				if (pageHasTranslation) {
					ensureTranslationForReading({ completePending: true });
					return;
				}
			}
			togglePageLayoutTranslate(pageIndex);
		},
		[
			viewMode,
			paperKey,
			showLayoutTranslate,
			layoutTranslateItemsByPage,
			ensureTranslationForReading,
			togglePageLayoutTranslate,
		],
	);

	const pageHandlers = useMemo<PdfPageHandlers>(
		() => ({
			onOpenPin: handleOpenPin,
			onCardHoverEnter: markCardHoverEnter,
			onCardHoverLeave: scheduleHoverHide,
			onCitationActivate: handleCitationLinkActivate,
			onTextLinkActivate: openExternalUrl,
			onCitationHover: handleLinkHover,
			onLinkUrlHover: handleLinkUrlHover,
			onTogglePageLayoutTranslate: handleTogglePageTranslate,
			onRetryPageLayoutTranslate: retryPageLayoutTranslate,
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
			handleLinkUrlHover,
			handleTogglePageTranslate,
			retryPageLayoutTranslate,
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
				bookmarkSaving={Boolean(bookmarkEditor.draft?.saving)}
				onBookmarkPage={bookmarkEditor.canEdit ? handleBookmarkPage : undefined}
				pageBookmarked={bookmarkedPages.has(pageIndex)}
				annotationSource={paperRelPath ?? paperAbsPath ?? undefined}
				docId={docId}
				pageIndex={pageIndex}
				reflowDocumentId={reflowDisplayDocument?.id}
				reflowDocumentVersion={reflowDisplayDocument?.version}
				searchDocumentId={searchDocumentId}
				searchScale={searchScale}
				width={rotatedWidth || width}
				height={rotatedHeight || height}
				tone={pdfTone}
				zoomRef={zoomRef}
				annotationCap={annotationCap}
				marks={pageMarks}
				// Gated to the page owning the hovered comment: other pages
				// keep null and their memo holds on hover.
				hoveredCommentId={
					hoveredCommentPage === pageIndex + 1 ? hoveredCommentId : null
				}
				layout={pageLayout}
				mode={pageMode}
				handlers={pageHandlers}
			/>
		),
		[
			docId,
			paperRelPath,
			paperAbsPath,
			searchDocumentId,
			searchScale,
			pdfTone,
			zoomRef,
			annotationCap,
			pageMarks,
			hoveredCommentPage,
			hoveredCommentId,
			pageLayout,
			pageMode,
			pageHandlers,
			bookmarkEditor.canEdit,
			bookmarkEditor.draft?.saving,
			handleBookmarkPage,
			bookmarkedPages,
			reflowDisplayDocument,
		],
	);

	// ---- Left toolbar auto show/hide (#400); right toolbar stays pinned ----
	const leftChromeVisible = usePdfChromeVisibility({
		hostRef,
		scrollRef,
		scrollReady,
		sticky: activePanel !== null || findOpen,
	});

	// ---- Floating card stack props ----
	// Memoized so PdfCardStack (the heaviest chrome subtree) bails out on page
	// turns and unrelated mark churn. Objects rebuild only when the state they
	// carry actually changes; every callback below is identity-stable.

	const handleCitationImportOpenChange = useCallback(
		(open: boolean) => {
			if (open) markCitationHoverEnter();
			else scheduleCitationHide();
		},
		[markCitationHoverEnter, scheduleCitationHide],
	);
	const citationImportMenu = useMemo(
		() =>
			citationImport
				? {
						folders: citationImport.folders,
						lastImportParentDir: citationImport.lastImportParentDir,
						importingId: citationImport.importingId,
						onImport: citationImport.importCitation,
						onOpenChange: handleCitationImportOpenChange,
						remotePaper: isRemotePaper,
					}
				: undefined,
		[citationImport, handleCitationImportOpenChange, isRemotePaper],
	);
	const canBookmark = bookmarkEditor.canEdit && !bookmarkEditor.draft?.saving;
	const bookmarkSelection = useCallback(
		(page: number, quote: string) => {
			if (!canBookmark) return;
			const title = quote.replace(/\s+/g, " ").trim();
			bookmarkEditor.begin();
			bookmarkEditor.change([
				...bookmarkEditor.nodes,
				{
					id: crypto.randomUUID(),
					origin: null,
					title: title || t("pdf.bookmarks.defaultTitle", { page }),
					pageIndex: page - 1,
					children: [],
				},
			]);
			if (!showOutline) openPanel("outline");
		},
		[t, canBookmark, bookmarkEditor, showOutline, openPanel],
	);
	const handleBookmarkSelection = useCallback(() => {
		if (!selectionMenu?.pages.length) return;
		bookmarkSelection(
			selectionMenu.anchor.page,
			selectionMenu.anchor.quote ?? selectionMenu.copyText ?? "",
		);
		closeSelectionMenu();
	}, [selectionMenu, bookmarkSelection, closeSelectionMenu]);
	const contributionPaperId = paperMeta?.id?.trim() || undefined;
	const canMarkSelection =
		!isRemotePaper && !plainViewer && Boolean(selectionMenu?.pages.length);
	const cardSelectionMenu = useMemo(
		() => ({
			state: selectionMenu,
			onHighlight: handleHighlight,
			onNote: canMarkSelection ? handleMenuNote : undefined,
			onAsk: handleMenuAsk,
			onAddToChat: handleMenuAddToChat,
			onTranslate: handleMenuTranslate,
			onCopy: handleMenuCopy,
			onBookmark:
				canBookmark && selectionMenu?.pages.length
					? handleBookmarkSelection
					: undefined,
			showHighlight: canMarkSelection,
			showTranslate:
				!selectionMenu?.fromTranslation && !isRemotePaper && !plainViewer,
			contributionContext: pdfSelectionMenuContext({
				vaultPath,
				paperRelPath,
				paperAbsPath,
				paperId: contributionPaperId,
				selectionMenu,
			}),
		}),
		[
			plainViewer,
			selectionMenu,
			canMarkSelection,
			handleHighlight,
			handleMenuNote,
			handleMenuAsk,
			handleMenuAddToChat,
			handleMenuTranslate,
			handleMenuCopy,
			canBookmark,
			handleBookmarkSelection,
			isRemotePaper,
			vaultPath,
			paperRelPath,
			paperAbsPath,
			contributionPaperId,
		],
	);
	const cardCitationPreview = useMemo(
		() => ({
			state: citationPreview,
			importMenu: citationImportMenu,
			onHoverEnter: markCitationHoverEnter,
			onHoverLeave: scheduleCitationHide,
		}),
		[
			citationPreview,
			citationImportMenu,
			markCitationHoverEnter,
			scheduleCitationHide,
		],
	);
	const cardCrossrefPreview = useMemo(
		() => ({
			state: crossrefPreview,
			onHoverEnter: markCrossrefHoverEnter,
			onHoverLeave: scheduleCrossrefHide,
		}),
		[crossrefPreview, markCrossrefHoverEnter, scheduleCrossrefHide],
	);
	const cardLinkUrlTip = useMemo(
		() => ({
			state: linkUrlTip,
			onHoverEnter: markLinkUrlHoverEnter,
			onHoverLeave: scheduleLinkUrlHide,
		}),
		[linkUrlTip, markLinkUrlHoverEnter, scheduleLinkUrlHide],
	);
	const cardAsk = useMemo(
		() => ({
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
		}),
		[
			activeThread,
			paperTitle,
			paperLink,
			streaming,
			askError,
			sendAskQuestion,
			resendAskQuestion,
			hideAskThread,
			deleteAskThread,
			stopAskStreaming,
		],
	);
	const handleToggleTranslatePin = useCallback(() => {
		if (activeTranslate) toggleTranslatePin(activeTranslate);
	}, [activeTranslate, toggleTranslatePin]);

	const handleTranslateModeChange = useCallback(
		(mode: "dictionary" | "translate") => {
			if (activeTranslate?.quote)
				translateSelection(
					{
						page: activeTranslate.page,
						rects: activeTranslate.rects,
						selectionPages: activeTranslate.selectionPages,
						quote: activeTranslate.quote,
						trigger: "selection",
					},
					mode,
					activeTranslate,
				);
		},
		[activeTranslate, translateSelection],
	);

	const cardTranslate = useMemo(
		() => ({
			record: isActive ? activeTranslate : null,
			onModeChange: handleTranslateModeChange,
			streaming: translateStreaming,
			error: translateError,
			onOpenSettings: openTranslateSettings,
			onTogglePin:
				paperAbsPath && activeTranslate?.rects.length
					? handleToggleTranslatePin
					: undefined,
			onHide: hideActiveCard,
		}),
		[
			isActive,
			activeTranslate,
			translateStreaming,
			translateError,
			openTranslateSettings,
			paperAbsPath,
			handleToggleTranslatePin,
			handleTranslateModeChange,
			hideActiveCard,
		],
	);
	const handleDeleteVisualTrace = useCallback(() => {
		if (activeVisualTrace) deleteVisualTraceById(activeVisualTrace.id);
	}, [activeVisualTrace, deleteVisualTraceById]);
	const cardVisual = useMemo(
		() => ({
			trace: activeVisualTrace,
			onHide: hideActiveCard,
			onDelete: handleDeleteVisualTrace,
		}),
		[activeVisualTrace, hideActiveCard, handleDeleteVisualTrace],
	);
	const handleZoomSliderChange = useCallback((next: number) => {
		zoomCapRef.current?.requestZoom(next);
	}, []);
	const exitImmersiveReading = useCallback(() => {
		layout()?.toggleImmersiveReading();
	}, []);
	const handleFitWidth = useCallback(() => {
		const centerReadingSurface = () => {
			// Horizontal paging uses scrollLeft as its page axis, so fitting a page
			// must not recenter it like a vertical spread.
			if (pdfScrollStrategy === "horizontal") return;
			const viewport = hostRef.current?.querySelector<HTMLElement>(
				"[data-pdf-viewport]",
			);
			if (viewport && viewport.scrollLeft !== 0) viewport.scrollLeft = 0;
		};

		const requestFitWidth = (retry = false) => {
			const capability = zoomCapRef.current;
			if (!capability) {
				if (!retry) {
					window.requestAnimationFrame(() => requestFitWidth(true));
				}
				return;
			}

			try {
				capability.requestZoom(ZoomMode.FitWidth);
				// A capability can be available one render before the viewport has
				// non-zero metrics. EmbedPDF treats that as a silent no-op; retry
				// once on the next frame after ResizeObserver has committed them.
				if (!retry) {
					window.requestAnimationFrame(() => requestFitWidth(true));
					return;
				}
				// The zoom plugin derives its scroll from the pre-fit viewport, and
				// off-page comment cards add horizontal room that lets a peeked rail
				// survive the fit. Its scroll request lands next frame; recenter
				// after it so the page fills the whole reading width, centered.
				window.requestAnimationFrame(centerReadingSurface);
			} catch {
				// The document scope can be recreated while a PDF buffer is reloading.
				// Give the next render a chance to expose a fresh capability.
				if (!retry) {
					window.requestAnimationFrame(() => requestFitWidth(true));
				}
			}
		};

		requestFitWidth();
	}, [pdfScrollStrategy]);

	// A thumbnail jumps to its page and closes the rail: the panel overlays the
	// reading surface, so leaving it open would cover the figure just jumped to.
	const handleFiguresJump = useCallback(
		(region: PdfLayoutRegion) => {
			handleJumpToLayoutRegion(region);
			closePanel();
		},
		[handleJumpToLayoutRegion, closePanel],
	);

	return (
		<div
			ref={hostRef}
			data-pdf-root
			className="content-arrive relative flex h-full min-h-0 w-full select-none flex-col"
		>
			{!translationOnly && !immersiveReading && (
				<PdfLeftToolbar
					canEditBookmarks={bookmarkEditor.canEdit}
					outline={outline}
					activePanel={activePanel}
					onTogglePanel={togglePanel}
					paperPath={paperRelPath}
					visible={leftChromeVisible}
					isRemotePaper={isRemotePaper}
					plainViewer={plainViewer}
				/>
			)}
			{!translationOnly && !immersiveReading && jumpBackTarget && (
				<PdfJumpBackChip onGoBack={goBackToJumpOrigin} />
			)}
			{!translationOnly && (
				<PdfFindBar
					open={findOpen}
					inputRef={findInputRef}
					query={findQuery}
					onQueryChange={setFindQuery}
					total={findTotal}
					activeResultIndex={findActiveIndex}
					onFindNext={handleFindNext}
					onFindPrev={handleFindPrev}
					onClose={handleCloseFind}
				/>
			)}
			{!translationOnly && !plainViewer && !immersiveReading && (
				<PdfToolbar
					onExportTranslatedPdf={reflowReady ? exportTranslatedPdf : undefined}
					engine={engine}
					layoutTranslateRunning={layoutTranslateRunning}
					layoutTranslatePreparing={layoutTranslatePreparing}
					layoutTranslateWaiting={layoutTranslateWaiting}
					layoutTranslateQueued={layoutTranslateQueued}
					viewMode={viewMode}
					onSelectViewMode={handleSelectViewMode}
					canCompare={
						Boolean(onOpenTranslationTab) &&
						Boolean(paperAbsPath) &&
						isWorkspaceDoc
					}
					layoutTranslatePartial={layoutTranslatePartial}
					layoutTranslateProgress={layoutTranslateProgress}
					layoutTranslatePageCounts={layoutTranslatePageCounts}
					onToggleLayoutTranslate={stopLayoutTranslateWithTypeset}
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
				className="min-h-0 min-w-0 flex-1"
				onClickCapture={(event) => {
					const target = event.target;
					// Observe the reading surface without swallowing its click. A
					// click on the pages dismisses whichever left rail is open (same
					// for outline / references / figures); portaled menus, cards and
					// page controls keep their own interaction unchanged.
					if (
						activePanel &&
						target instanceof Element &&
						event.currentTarget.contains(target) &&
						!target.closest("[data-pdf-chrome]")
					)
						closePanel();
				}}
			>
				<WheelZoomHandler docId={docId} />
				<KeyboardScrollHandler
					documentId={docId}
					active={isActive}
					hostRef={hostRef}
				/>
				<PdfHistoryKeyHandler
					active={isActive}
					hostRef={hostRef}
					onReplay={replayAnnotationHistory}
				/>
				<PdfVimKeyHandler
					documentId={docId}
					active={isActive}
					hostRef={hostRef}
					totalPages={totalPages}
					onFindNext={handleFindNext}
					onFindPrev={handleFindPrev}
				/>
				<PanDragHandler
					active={isActive}
					hostRef={hostRef}
					allowLeftDrag={!translationOnly}
				/>
				{!translationOnly && !plainViewer && !immersiveReading ? (
					<RailPeek
						hostRef={hostRef}
						railWidth={COMMENT_RAIL_WIDTH_PX}
						hasCommentsOnPage={hasCommentsOnPage}
						hoveredCommentId={hoveredCommentId}
						revealPage={
							selectionCommentDraft?.page ??
							(railEdit ? railEdit.pageIndex + 1 : null)
						}
						holdOpen={Boolean(railEdit || selectionCommentDraft)}
					/>
				) : null}
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
						<PdfScroller documentId={docId} renderPage={renderPage} />
					</GlobalPointerProvider>
				</ZoomGestureWrapper>
			</DockviewViewport>

			{!translationOnly && !immersiveReading && elementSelecting ? (
				<LayoutElementActions
					docId={docId}
					docCap={docCap}
					paperRelPath={paperRelPath}
					paperAbsPath={paperAbsPath}
					captureRegion={captureRegion}
					onHighlight={(pages, color, quote, shape) =>
						createHighlights(pages, color, quote, undefined, shape)
					}
					onNote={beginSelectionComment}
					onAsk={startFromAnchor}
					onBookmark={canBookmark ? bookmarkSelection : undefined}
					translateSelection={translateSelection}
				/>
			) : null}

			{!translationOnly && !immersiveReading && (
				<PdfCardStack
					selectionMenu={cardSelectionMenu}
					citationPreview={cardCitationPreview}
					crossrefPreview={cardCrossrefPreview}
					linkUrlTip={cardLinkUrlTip}
					cardScreen={cardScreen}
					onCardHoverEnter={markCardHoverEnter}
					onCardHoverLeave={scheduleHoverHide}
					ask={cardAsk}
					translate={cardTranslate}
					visual={cardVisual}
				/>
			)}

			{!translationOnly && (!plainViewer || showBottomBar) && (
				<PdfBottomBar
					currentPage={currentPage}
					onGoToPage={handleGoToPage}
					totalPages={totalPages}
					pageField={pageField}
					onPageFieldChange={setPageField}
					pageFocusedRef={pageFocusedRef}
					onCommitPageField={handleCommitPageField}
					pdfTone={pdfTone}
					onSetPdfTone={setPdfTone}
					zoomLevel={zoomLevel}
					onZoomChange={handleZoomSliderChange}
					onFitWidth={handleFitWidth}
					elementSelecting={elementSelecting}
					elementSelectionAvailable={selectableRegionsByPage.size > 0}
					elementSelectionDisabled={!engine}
					onToggleElementSelection={
						plainViewer || immersiveReading || isRemotePaper
							? undefined
							: toggleElementSelection
					}
					isRemotePaper={isRemotePaper}
					presented={!immersiveReading || immersiveChrome}
					onExitImmersive={immersiveReading ? exitImmersiveReading : undefined}
				/>
			)}

			{/* Left rails paint last: they are full-height overlays, so they cover
			    the bottom page / zoom bar and the jump-back chip instead of
			    reserving a lane for them. One slot, so at most one is mounted. */}
			{!translationOnly && !immersiveReading && activePanel === "outline" && (
				<PdfOutlinePanel
					editor={bookmarkEditor}
					currentPage={currentPage}
					outline={outline}
					onGoToPage={handleGoToPage}
				/>
			)}
			{!translationOnly &&
				!immersiveReading &&
				activePanel === "references" && (
					<PdfReferencesPanel vaultPath={vaultPath} paperPath={paperRelPath} />
				)}
			{!translationOnly &&
				!plainViewer &&
				!immersiveReading &&
				activePanel === "figures" && (
					<PdfFiguresPanel
						documentId={docId}
						paperAbsPath={paperAbsPath}
						paperRelPath={paperRelPath}
						isRemotePaper={isRemotePaper}
						onAnalyze={handleAnalyzeLayout}
						onJump={handleFiguresJump}
						onRenderThumb={handleRenderLayoutThumb}
					/>
				)}
		</div>
	);
}
