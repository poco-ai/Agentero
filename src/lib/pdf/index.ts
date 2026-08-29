export {
	bindVisualTracesForTurn,
	buildVisualAnnotationsPrompt,
	buildVisualTraceHistoryItem,
	completeTrace,
	createNoteTrace,
	createRunningTraces,
	deletePdfVisualTrace,
	failTrace,
	isVisualMarkKind,
	isVisualTraceHistoryId,
	listPdfVisualTraces,
	loadPdfVisualTraceImage,
	type PdfVisualSessionTrace,
	readPdfVisualTrace,
	takePendingVisualTraces,
	traceMessages,
	tracePreview,
	visualTraceHistoryId,
	visualTraceImageAssetRelPath,
	writePdfVisualTrace,
} from "@/lib/pdf/agent-trace";
export {
	loadPdfVisualTraceThumbnails,
	type PdfVisualTraceThumbnail,
} from "@/lib/pdf/agent-trace/thumbnail";
export {
	type AnnotationRef,
	type AnnotationRefKind,
	annotationAnchorY,
	annotationSnippet,
	annotationWikilinkAlias,
	annotationWikilinkMarkdown,
	listPaperAnnotationSummaries,
	lookupAnnotationRef,
	type PaperAnnotationSummary,
	paperAbsFromSourceFile,
	paperAbsFromWikiTarget,
	paperAbsFromWorkspaceTab,
	pdfTabIdForPaper,
	truncateAnnotationPreview,
	wikiTargetForPaper,
} from "@/lib/pdf/annotation-ref";
export {
	annotationsStore,
	clearAnnotationsVaultState,
	remapTabAnnotations,
	removeTabAnnotations,
	setTabAsks,
	setTabHighlights,
	setTabVisualTraces,
} from "@/lib/pdf/annotations-store";
export {
	appendAskAssistantMessage,
	bindAskThreadsForTurn,
	buildPdfAskPrompt,
	createEmptyThread,
	deletePdfAskThread,
	listPdfAskThreads,
	newMessageId,
	type PdfAskAnchor,
	type PdfAskNormalizedRect,
	type PdfAskThread,
	type PdfAskTrigger,
	popoverScreenPoint,
	readPdfAskThread,
	takePendingAskThreads,
	threadHasUserQuestion,
	threadPreview,
	threadTitle,
	writePdfAskThread,
} from "@/lib/pdf/ask";
export { bookmarkPageIndex } from "@/lib/pdf/bookmark";
export {
	type CitationDestKeyMap,
	type CitationLinkKeyList,
	type CrossrefDestLabelMap,
	type CrossrefDestMap,
	type CrossrefKind,
	type CrossrefKindMap,
	type CrossrefLinkLabelList,
	citationDestKey,
	citationSidecarKeysForDest,
	expandCitationLinkCluster,
	matchCitationLinkKey,
	matchCrossrefLinkLabel,
} from "@/lib/pdf/citation-dest-keys";
export { loadPdfDestMaps } from "@/lib/pdf/citation-dest-map";
export {
	extractCrossrefLabel,
	pickCrossrefRegion,
	pickCrossrefRegionByLabel,
} from "@/lib/pdf/crossref-resolve";
export { createPdfViewportResizeGate } from "@/lib/pdf/dockview-resize";
export {
	ANNOTATIONS_FILE,
	type HighlightCustom,
	hasAnnotationsFile,
	highlightColorOf,
	highlightQuoteOf,
	highlightViewFromObject,
	isHighlightObject,
	loadAnnotationItems,
	saveAnnotationItems,
} from "@/lib/pdf/highlight/annotation-store";
export { migrateHighlightMarks } from "@/lib/pdf/highlight/migrate-marks";
export {
	DEFAULT_HIGHLIGHT_COLOR,
	HIGHLIGHT_COLORS,
	HIGHLIGHT_HEX,
	HIGHLIGHT_HEX_LIST,
	HIGHLIGHT_OPACITY,
	type HighlightColor,
	highlightHoverOverlayColor,
	normalizeHighlightColor,
	swatchBorderClass,
	swatchColorClass,
} from "@/lib/pdf/highlight/palette";
export type { PdfHighlight } from "@/lib/pdf/highlight/types";
export {
	applyLayoutTranslateSidecar,
	attachLayoutModelTaskListener,
	compareLayoutReadingOrder,
	currentLayoutTranslateCacheKey,
	dedupeLayoutRegions,
	enqueuePaperLayoutAnalysis,
	formulaSortAnchor,
	getLayoutDocumentResult,
	getPdfAiRuntime,
	groupLayoutTranslateItemsByPage,
	hasPendingLayoutTranslateItems,
	hoverableLayoutRegionsByPage,
	isAlgorithmLayoutKind,
	isFigureLayoutKind,
	isFormulaLayoutKind,
	isLayoutRegionActivation,
	isLayoutTranslateHeadingKind,
	isSidebarLayoutKind,
	isTableLayoutKind,
	LAYOUT_HINT_MIN_REGION_H_PX,
	LAYOUT_HINT_MIN_REGION_W_PX,
	LAYOUT_SIDEBAR_MIN_SCORE,
	type LayoutTranslateItem,
	type LayoutTranslateJobStatus,
	layoutAnalysisStore,
	layoutKindBorder,
	layoutKindFill,
	layoutKindHex,
	layoutKindI18nKey,
	layoutSidecarPath,
	listTranslatableLayoutRegions,
	type PdfLayoutKind,
	type PdfLayoutRegion,
	type PointerOrigin,
	persistLayoutTranslateSidecarBestEffort,
	prefetchLayoutModel,
	rawLayoutRegionsByPage,
	readLayoutSidecar,
	readLayoutTranslateSidecar,
	runDocumentLayoutAnalysis,
	runLayoutRegionTranslate,
	setFocusedLayoutRegion,
	setLayoutOverlayVisible,
	toggleLayoutOverlayVisible,
	toLayoutTranslateItems,
} from "@/lib/pdf/layout";
export { initJobCenterExecutors } from "@/lib/pdf/layout/enqueue-paper-layout";
export {
	persistLayoutProviderConfig,
	probeLayoutProvider,
} from "@/lib/pdf/layout/provider-config";
export {
	isRemoteLayoutProvider,
	LAYOUT_PROVIDERS,
	layoutProviderCard,
	mergeProviderCards,
	PARSER_PROVIDERS,
	type ProviderCardDescriptor,
} from "@/lib/pdf/layout/providers";
export {
	DEFAULT_LAYOUT_SETTINGS,
	DEFAULT_MINERU_LANGUAGE,
	isLayoutBackend,
	isLayoutProviderId,
	isMineruLanguage,
	isParserBackend,
	LAYOUT_PROVIDER_DEFAULT_BASE_URLS,
	LAYOUT_PROVIDER_DOCS_URLS,
	type LayoutProviderConfig,
	type LayoutProviderId,
	type LayoutSettings,
	MINERU_LANGUAGES,
	PARSER_BACKENDS,
	PROVIDER_MODEL_PRESETS,
} from "@/lib/pdf/layout/settings";
export { clearLayoutVaultState } from "@/lib/pdf/layout/store";
export {
	getPaperOutline,
	outlineLocationLabelForPaper,
	setPaperOutline,
	subscribePaperOutline,
} from "@/lib/pdf/outline-location";
export { getPdfPageCount } from "@/lib/pdf/page-count";
export { PDF_PAGE_RASTER_DARK_CLASS } from "@/lib/pdf/page-theme";
export { readReadingPage, writeReadingPage } from "@/lib/pdf/reading-position";
export {
	normalizedRegionFromPoints,
	normalizedRegionToPdfRect,
} from "@/lib/pdf/region";
export {
	type ActiveSelectionCard,
	marksDir,
	type NormalizedRect,
	normalizePageTextRects,
	pinFromRects,
	pinObscuresBodyText,
	type SelectionPin,
} from "@/lib/pdf/selection";
export {
	ANNOTATIONS_JSON,
	isRecentSelfWrite,
	MARKS_FOLDER,
} from "@/lib/pdf/selection/marks-io";
export {
	createTranslateRecord,
	deletePdfTranslate,
	listPdfTranslates,
	writePdfTranslate,
} from "@/lib/pdf/translate";
export {
	evictAgentTranslateSessionId,
	getAgentTranslateSessionId,
	setAgentTranslateSessionId,
} from "@/lib/pdf/translate/agent-session-cache";
export type {
	PdfTranslateRecord,
	PdfTranslateRect,
} from "@/lib/pdf/translate/types";
export {
	bindWheelZoomGesture,
	createWheelZoomCoalescer,
} from "@/lib/pdf/wheel-zoom";
export {
	formatPdfZoomPercentage,
	PDF_ZOOM_MAX,
	PDF_ZOOM_MIN,
	parsePdfZoomPercentage,
} from "@/lib/pdf/zoom";
// citation-dest-keys.worker.ts (web worker entry) and marks/* (internal mark
// store schema/io) are intentionally not re-exported from this barrel.
