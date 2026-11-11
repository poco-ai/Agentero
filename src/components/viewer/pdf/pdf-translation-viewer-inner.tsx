/**
 * Slim dual-pane translation companion. Mounts only scroll / zoom / raster
 * plugins (no selection, annotation, search, or ONNX layout), so capability
 * hooks that throw on missing plugins are never called here.
 */

import type { PdfLinkAnnoObject } from "@embedpdf/models";
import { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import {
	GlobalPointerProvider,
	useInteractionManagerCapability,
} from "@embedpdf/plugin-interaction-manager/react";
import { type PageLayout, useScroll } from "@embedpdf/plugin-scroll/react";
import { useZoom, ZoomGestureWrapper } from "@embedpdf/plugin-zoom/react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { PdfCitationPreview } from "@/components/viewer/pdf/cards/citation-preview";
import { PdfCrossrefPreview } from "@/components/viewer/pdf/cards/crossref-preview";
import { PdfLinkUrlTip } from "@/components/viewer/pdf/cards/link-url-tip";
import { PdfTranslateProgressChip } from "@/components/viewer/pdf/chrome/pdf-translate-progress";
import { EMPTY_LAYOUT_REGIONS_BY_PAGE } from "@/components/viewer/pdf/constants";
import { usePdfEngineContext } from "@/components/viewer/pdf/engine-provider";
import { usePdfCitations } from "@/components/viewer/pdf/hooks/use-pdf-citations";
import { usePdfCrossrefPreview } from "@/components/viewer/pdf/hooks/use-pdf-crossref-preview";
import { usePdfLayoutRegions } from "@/components/viewer/pdf/hooks/use-pdf-layout-regions";
import { usePdfLayoutTranslate } from "@/components/viewer/pdf/hooks/use-pdf-layout-translate";
import { usePdfLinkUrlTip } from "@/components/viewer/pdf/hooks/use-pdf-link-url-tip";
import { usePdfPaperTone } from "@/components/viewer/pdf/hooks/use-pdf-paper-tone";
import { usePdfReadingMode } from "@/components/viewer/pdf/hooks/use-pdf-reading-mode";
import { usePdfScrollSync } from "@/components/viewer/pdf/hooks/use-pdf-scroll-sync";
import { usePdfZoomControls } from "@/components/viewer/pdf/hooks/use-pdf-zoom-controls";
import { useReflowDisplayDocument } from "@/components/viewer/pdf/hooks/use-reflow-display-document";
import { getLinkDestination } from "@/components/viewer/pdf/layers/citation-links";
import {
	type PdfPageHandlers,
	PdfPageLayers,
	type PdfPageLayoutSlice,
	type PdfPageMarksSlice,
	type PdfPageModeSlice,
} from "@/components/viewer/pdf/layers/page-layers";
import type {
	PdfLinkHoverPoint,
	PdfViewerInnerProps,
	ScreenPoint,
} from "@/components/viewer/pdf/types";
import { DockviewViewport } from "@/components/viewer/pdf/viewport/dockview-viewport";
import { KeyboardScrollHandler } from "@/components/viewer/pdf/viewport/keyboard-scroll-handler";
import { PanDragHandler } from "@/components/viewer/pdf/viewport/pan-handler";
import { PdfScroller } from "@/components/viewer/pdf/viewport/pdf-scroller";
import { PdfVimKeyHandler } from "@/components/viewer/pdf/viewport/pdf-vim-key-handler";
import { WheelZoomHandler } from "@/components/viewer/pdf/viewport/wheel-zoom-handler";
import { openExternalUrl } from "@/lib/core/open-external";
import { destinationInPageBox } from "@/lib/pdf/citation-dest-keys";
import {
	mirrorLayoutResultToTranslation,
	translationSourceKey,
} from "@/lib/pdf/layout";
import {
	getTranslatedLinkSource,
	subscribeTranslatedLinkSource,
} from "@/lib/pdf/layout/translated-link-source";
import {
	linkPreviewDragActive,
	subscribeLinkPreviewDrag,
} from "@/lib/pdf/link-preview-drag";
import {
	registerScrollSyncPair,
	unregisterScrollSyncPair,
} from "@/lib/pdf/scroll-sync";

const EMPTY_PAGE_MAP = new Map();

const EMPTY_MARKS: PdfPageMarksSlice = {
	activeAskAnchor: null,
	activeTranslateAnchor: null,
	activeVisualTrace: null,
	visualDraftRegion: null,
	visualCropRegion: null,
	focusedLayoutRegion: null,
	focusedLayoutFlash: false,
	focusedLayoutFlashToken: 0,
	pinsByPage: EMPTY_PAGE_MAP,
	commentsByPage: EMPTY_PAGE_MAP,
	editingCommentId: null,
	commentWikiTarget: null,
	citationLinks: EMPTY_PAGE_MAP,
	textLinks: EMPTY_PAGE_MAP,
	activeCardId: null,
	hoveredCommentId: null,
	selectionCommentDraft: null,
	translateHighlightsByPage: EMPTY_PAGE_MAP,
	highlightQuotesByPage: EMPTY_PAGE_MAP,
	translatedHighlightsByPage: EMPTY_PAGE_MAP,
};

const NOOP = () => undefined;

const EMPTY_HANDLERS: PdfPageHandlers = {
	onOpenPin: NOOP,
	onCardHoverEnter: NOOP,
	onCardHoverLeave: NOOP,
	onCitationActivate: NOOP,
	onTextLinkActivate: NOOP,
	onCitationHover: NOOP,
	onRegionSelect: NOOP,
	onLayoutRegionClick: NOOP,
	onTogglePageLayoutTranslate: NOOP,
	onDeleteHighlightAnnotation: NOOP,
	onEditHighlightAnnotation: NOOP,
	onChangeHighlightColor: NOOP,
	onOpenComment: NOOP,
	onSaveComment: NOOP,
	onCancelComment: NOOP,
	onDeleteComment: NOOP,
	onCopyCommentLink: NOOP,
	onCopyCommentEmbed: NOOP,
	onAddCommentToChat: NOOP,
	onHoverComment: NOOP,
	onLeaveComment: NOOP,
	onCommitSelectionComment: NOOP,
	onSelectionCommentActiveChange: NOOP,
	onDismissSelectionComment: NOOP,
};

const PAGE_MODE: PdfPageModeSlice = {
	regionSelecting: false,
	visualCropPending: false,
	visualDraftOpen: false,
	translationOnly: true,
};

export function PdfTranslationViewerInner({
	docId,
	paperAbsPath = null,
	paperRelPath = null,
	vaultPath = null,
	sourceBytes = null,
	pdfCacheBytes = null,
	isRemotePaper = false,
	importIdentifier,
	isActive = true,
	onHandle,
	translationSourceDocId,
}: PdfViewerInnerProps) {
	const sourceKey = translationSourceDocId ?? translationSourceKey(docId);
	useEffect(() => {
		if (!translationSourceDocId) return;
		const group = registerScrollSyncPair(translationSourceDocId, docId);
		return () => unregisterScrollSyncPair(group);
	}, [translationSourceDocId, docId]);
	usePdfScrollSync(docId);
	usePdfReadingMode(docId);
	const { provides: scroll } = useScroll(docId);
	const scrollRef = useRef(scroll);
	scrollRef.current = scroll;
	const { provides: docCap } = useDocumentManagerCapability();
	const docCapRef = useRef(docCap);
	docCapRef.current = docCap;
	// Interaction manager is registered; keep the capability subscribed so
	// GlobalPointerProvider / pan-zoom gestures stay wired.
	useInteractionManagerCapability();

	const { state: zoomState } = useZoom(docId);
	const zoomLevel = zoomState.currentZoomLevel || 1;
	const { zoomRef } = usePdfZoomControls(zoomLevel);
	const hostRef = useRef<HTMLDivElement>(null);
	const { engine } = usePdfEngineContext();
	const engineRef = useRef(engine);
	engineRef.current = engine;
	const { pdfTone } = usePdfPaperTone();
	const paperKey = paperRelPath || paperAbsPath || null;

	const { layoutRawRegions, rawRegionsByPage } = usePdfLayoutRegions(docId);
	const {
		layoutTranslateItemsByPage,
		layoutTranslatePageStateByPage,
		layoutTranslateActive,
		layoutTranslateRunning,
		layoutTranslatePreparing,
		layoutTranslateWaiting,
		layoutTranslateQueued,
		layoutTranslateProgress,
		layoutTranslatePageCounts,
		layoutTranslatePartial,
		reflowOutput,
		toggleLayoutTranslate,
		togglePageLayoutTranslate,
	} = usePdfLayoutTranslate({
		reflowContext: () => {
			const engine = engineRef.current,
				document = docCapRef.current?.getDocument(docId);
			return engine && document ? { engine, document } : null;
		},
		docId,
		layoutRawRegions,
		translationPane: true,
		cacheOnlyPane: !!translationSourceDocId,
		paperAbsPath,
		paperRelPath,
		paperKey,
		vaultPath,
		pdfBytes: pdfCacheBytes ?? sourceBytes,
	});

	const reflowDisplayDocumentId = useReflowDisplayDocument(
		docCap,
		reflowOutput,
		docId,
	);

	// `openTranslationTab` seeds a snapshot at open time; if layout analysis was
	// still running then, mirror the source result when it lands so the
	// auto-start below can fire.
	useEffect(() => {
		if (!sourceKey) return;
		return mirrorLayoutResultToTranslation(docId, sourceKey);
	}, [docId, sourceKey]);

	const translationAutoStartedRef = useRef(false);
	const hadLayoutRegionsRef = useRef(false);
	const layoutTranslateActiveRef = useRef(layoutTranslateActive);
	layoutTranslateActiveRef.current = layoutTranslateActive;
	const layoutTranslateRunningRef = useRef(layoutTranslateRunning);
	layoutTranslateRunningRef.current = layoutTranslateRunning;

	useEffect(() => {
		if (translationSourceDocId) return;
		const hasRegions = (layoutRawRegions?.length ?? 0) > 0;
		if (hasRegions) {
			hadLayoutRegionsRef.current = true;
		} else if (hadLayoutRegionsRef.current) {
			translationAutoStartedRef.current = false;
			hadLayoutRegionsRef.current = false;
		}
		if (translationAutoStartedRef.current) return;
		if (!hasRegions) {
			// Layout is not ready yet. Park the job on the shared analysis queue
			// so the user sees the "queued — waiting for layout analysis" toast
			// (with a cancel action) instead of a silent empty pane. The hook
			// starts the job once regions land; the mirror above delivers them
			// even when the source pane finishes after this pane opened.
			translationAutoStartedRef.current = true;
			toggleLayoutTranslate();
			return;
		}
		if (layoutTranslateActive || layoutTranslateRunning) {
			translationAutoStartedRef.current = true;
			return;
		}
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
		layoutRawRegions,
		layoutTranslateActive,
		layoutTranslateRunning,
		toggleLayoutTranslate,
		translationSourceDocId,
	]);

	useEffect(() => {
		onHandle?.(null);
		return () => onHandle?.(null);
	}, [onHandle]);

	const linkSource = useSyncExternalStore(
		subscribeTranslatedLinkSource,
		() => getTranslatedLinkSource(sourceKey),
		() => getTranslatedLinkSource(sourceKey),
	);
	const linkInkByKey = linkSource.inkByKey;
	const glyphRunsByPage = linkSource.glyphRunsByPage;

	const pageMarks = useMemo<PdfPageMarksSlice>(
		() => ({
			...EMPTY_MARKS,
			citationLinks: linkSource.citationLinks,
			textLinks: linkSource.textLinks,
		}),
		[linkSource],
	);

	const pageLayout = useMemo<PdfPageLayoutSlice>(
		() => ({
			hoverableRegionsByPage: EMPTY_LAYOUT_REGIONS_BY_PAGE,
			rawRegionsByPage,
			layoutOverlayVisible: false,
			layoutTranslateItemsByPage,
			layoutTranslatePageStateByPage,
			linkInkByKey,
			glyphRunsByPage,
		}),
		[
			rawRegionsByPage,
			layoutTranslateItemsByPage,
			layoutTranslatePageStateByPage,
			linkInkByKey,
			glyphRunsByPage,
		],
	);

	const activateCitation = useCallback(
		(link: PdfLinkAnnoObject) => {
			const raw = getLinkDestination(link.target);
			if (!raw) return;
			// PDFium reports user space. EmbedPDF page size is the visible box,
			// so a CropBox that does not start at (0, 0) has to be subtracted
			// before the top-left conversion.
			const destination = destinationInPageBox(raw, linkSource.pageOrigins);
			const page =
				docCapRef.current?.getDocument(docId)?.pages[destination.pageIndex];
			const height = page?.size.height ?? 0;
			const width = page?.size.width ?? 0;
			const anchored = destination.pdfY > 0 || destination.pdfX != null;
			scrollRef.current?.scrollToPage({
				pageNumber: destination.pageIndex + 1,
				behavior: "instant",
				...(anchored && height > 0
					? {
							pageCoordinates: {
								x:
									destination.pdfX != null && width > 0
										? Math.max(0, destination.pdfX)
										: 0,
								y: Math.max(0, height - destination.pdfY),
							},
							alignX: 0,
							alignY: 18,
						}
					: {}),
			});
		},
		[docId, linkSource.pageOrigins],
	);

	// Sibling clears so citation, crossref, and URL tips dismiss each other.
	const clearCrossrefPreviewRef = useRef<() => void>(() => {});
	const clearCitationPreviewRef = useRef<() => void>(() => {});
	const clearLinkUrlTipRef = useRef<() => void>(() => {});

	const {
		citationPreview,
		scheduleCitationHide,
		markCitationHoverEnter,
		clearCitationPreview,
		handleCitationLinkHover,
		citationImport,
	} = usePdfCitations({
		docId,
		annotationCap: null,
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
	});

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
		showCitationPreview: handleCitationLinkHover,
		onPreviewShow: () => {
			clearCitationPreviewRef.current();
			clearLinkUrlTipRef.current();
		},
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

	useEffect(() => {
		return subscribeLinkPreviewDrag(() => {
			clearCitationPreviewRef.current();
			clearCrossrefPreviewRef.current();
			clearLinkUrlTipRef.current();
		});
	}, []);

	const handleLinkHover = useCallback(
		(link: PdfLinkAnnoObject | null, point?: PdfLinkHoverPoint | null) => {
			if (linkPreviewDragActive()) {
				clearCitationPreview();
				clearCrossrefPreview();
				clearLinkUrlTip();
				return;
			}
			if (!link) handleCitationLinkHover(null);
			handleCrossrefLinkHover(link, point);
		},
		[
			clearCitationPreview,
			clearCrossrefPreview,
			clearLinkUrlTip,
			handleCitationLinkHover,
			handleCrossrefLinkHover,
		],
	);

	const handleLinkUrlHover = useCallback(
		(url: string | null, point?: ScreenPoint | null) => {
			if (linkPreviewDragActive()) {
				clearLinkUrlTip();
				return;
			}
			hoverLinkUrl(url, point);
		},
		[clearLinkUrlTip, hoverLinkUrl],
	);

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

	const pageHandlers = useMemo<PdfPageHandlers>(
		() => ({
			...EMPTY_HANDLERS,
			onTogglePageLayoutTranslate: togglePageLayoutTranslate,
			onCitationActivate: activateCitation,
			onTextLinkActivate: openExternalUrl,
			onCitationHover: handleLinkHover,
			onLinkUrlHover: handleLinkUrlHover,
		}),
		[
			togglePageLayoutTranslate,
			activateCitation,
			handleLinkHover,
			handleLinkUrlHover,
		],
	);

	const renderPage = useCallback(
		({ pageIndex, width, height, rotatedWidth, rotatedHeight }: PageLayout) => (
			<PdfPageLayers
				docId={docId}
				pageIndex={pageIndex}
				reflowDocumentId={reflowDisplayDocumentId}
				width={rotatedWidth || width}
				height={rotatedHeight || height}
				tone={pdfTone}
				zoomRef={zoomRef}
				annotationCap={null}
				marks={pageMarks}
				layout={pageLayout}
				mode={PAGE_MODE}
				handlers={pageHandlers}
			/>
		),
		[
			docId,
			pdfTone,
			zoomRef,
			pageMarks,
			pageLayout,
			pageHandlers,
			reflowDisplayDocumentId,
		],
	);

	return (
		<div
			ref={hostRef}
			className="relative flex h-full min-h-0 w-full select-none flex-col"
		>
			<DockviewViewport
				documentId={docId}
				hostRef={hostRef}
				rightGutter={0}
				className="agentero-scroll-both min-h-0 min-w-0 flex-1"
			>
				<WheelZoomHandler docId={docId} />
				<KeyboardScrollHandler
					documentId={docId}
					active={isActive}
					hostRef={hostRef}
				/>
				<PdfVimKeyHandler
					documentId={docId}
					active={isActive}
					hostRef={hostRef}
				/>
				<PanDragHandler
					active={isActive}
					hostRef={hostRef}
					allowLeftDrag={false}
				/>
				<ZoomGestureWrapper documentId={docId} enableWheel={false}>
					<GlobalPointerProvider documentId={docId}>
						<PdfScroller documentId={docId} renderPage={renderPage} />
					</GlobalPointerProvider>
				</ZoomGestureWrapper>
			</DockviewViewport>
			<PdfTranslateProgressChip
				layoutTranslateRunning={layoutTranslateRunning}
				layoutTranslatePreparing={layoutTranslatePreparing}
				layoutTranslateWaiting={layoutTranslateWaiting}
				layoutTranslateQueued={layoutTranslateQueued}
				layoutTranslateProgress={layoutTranslateProgress}
				layoutTranslatePageCounts={layoutTranslatePageCounts}
				layoutTranslatePartial={layoutTranslatePartial}
				onStop={toggleLayoutTranslate}
			/>
			{typeof document !== "undefined"
				? createPortal(
						<>
							{citationPreview ? (
								<PdfCitationPreview
									screen={citationPreview.screen}
									matched={citationPreview.matched}
									importMenu={citationImportMenu}
									onPointerEnter={markCitationHoverEnter}
									onPointerLeave={scheduleCitationHide}
								/>
							) : null}
							{crossrefPreview ? (
								<PdfCrossrefPreview
									screen={crossrefPreview.screen}
									kind={crossrefPreview.kind}
									page={crossrefPreview.page}
									image={crossrefPreview.image}
									referenceImages={crossrefPreview.referenceImages}
									referenceEntries={crossrefPreview.referenceEntries}
									missingReferences={crossrefPreview.missingReferences}
									targetSize={crossrefPreview.targetSize}
									focusPoint={crossrefPreview.focusPoint}
									onPointerEnter={markCrossrefHoverEnter}
									onPointerLeave={scheduleCrossrefHide}
								/>
							) : null}
							{linkUrlTip ? (
								<PdfLinkUrlTip
									url={linkUrlTip.url}
									screen={linkUrlTip.screen}
									onPointerEnter={markLinkUrlHoverEnter}
									onPointerLeave={scheduleLinkUrlHide}
								/>
							) : null}
						</>,
						document.body,
					)
				: null}
		</div>
	);
}
