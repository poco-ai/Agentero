/**
 * Slim dual-pane translation companion. Mounts only scroll / zoom / raster
 * plugins (no selection, annotation, search, or ONNX layout), so capability
 * hooks that throw on missing plugins are never called here.
 */

import {
	GlobalPointerProvider,
	useInteractionManagerCapability,
} from "@embedpdf/plugin-interaction-manager/react";
import { type PageLayout, Scroller } from "@embedpdf/plugin-scroll/react";
import { useZoom, ZoomGestureWrapper } from "@embedpdf/plugin-zoom/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { EMPTY_LAYOUT_REGIONS_BY_PAGE } from "@/components/viewer/pdf/constants";
import { usePdfLayoutRegions } from "@/components/viewer/pdf/hooks/use-pdf-layout-regions";
import { usePdfLayoutTranslate } from "@/components/viewer/pdf/hooks/use-pdf-layout-translate";
import { usePdfPaperTone } from "@/components/viewer/pdf/hooks/use-pdf-paper-tone";
import { usePdfReadingMode } from "@/components/viewer/pdf/hooks/use-pdf-reading-mode";
import { usePdfScrollSync } from "@/components/viewer/pdf/hooks/use-pdf-scroll-sync";
import { usePdfZoomControls } from "@/components/viewer/pdf/hooks/use-pdf-zoom-controls";
import {
	type PdfPageHandlers,
	PdfPageLayers,
	type PdfPageLayoutSlice,
	type PdfPageMarksSlice,
	type PdfPageModeSlice,
} from "@/components/viewer/pdf/layers/page-layers";
import type { PdfViewerInnerProps } from "@/components/viewer/pdf/types";
import { DockviewViewport } from "@/components/viewer/pdf/viewport/dockview-viewport";
import { PanDragHandler } from "@/components/viewer/pdf/viewport/pan-handler";
import { WheelZoomHandler } from "@/components/viewer/pdf/viewport/wheel-zoom-handler";
import {
	mirrorLayoutResultToTranslation,
	translationSourceKey,
} from "@/lib/pdf/layout";

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
	isActive = true,
	onHandle,
}: PdfViewerInnerProps) {
	usePdfScrollSync(docId);
	usePdfReadingMode(docId);
	// Interaction manager is registered; keep the capability subscribed so
	// GlobalPointerProvider / pan-zoom gestures stay wired.
	useInteractionManagerCapability();

	const { state: zoomState } = useZoom(docId);
	const zoomLevel = zoomState.currentZoomLevel || 1;
	const { zoomRef } = usePdfZoomControls(zoomLevel);
	const hostRef = useRef<HTMLDivElement>(null);
	const { pdfTone } = usePdfPaperTone();
	const paperKey = paperRelPath || paperAbsPath || null;

	const { layoutRawRegions, rawRegionsByPage } = usePdfLayoutRegions(docId);
	const {
		layoutTranslateItemsByPage,
		layoutTranslatePageStateByPage,
		layoutTranslateActive,
		layoutTranslateRunning,
		toggleLayoutTranslate,
		togglePageLayoutTranslate,
	} = usePdfLayoutTranslate({
		docId,
		layoutRawRegions,
		translationPane: true,
		paperAbsPath,
		paperRelPath,
		paperKey,
		vaultPath,
	});

	// `openTranslationTab` seeds a snapshot at open time; if layout analysis was
	// still running then, mirror the source result when it lands so the
	// auto-start below can fire.
	useEffect(() => {
		const sourceKey = translationSourceKey(docId);
		if (!sourceKey) return;
		return mirrorLayoutResultToTranslation(docId, sourceKey);
	}, [docId]);

	const translationAutoStartedRef = useRef(false);
	const hadLayoutRegionsRef = useRef(false);
	const layoutTranslateActiveRef = useRef(layoutTranslateActive);
	layoutTranslateActiveRef.current = layoutTranslateActive;
	const layoutTranslateRunningRef = useRef(layoutTranslateRunning);
	layoutTranslateRunningRef.current = layoutTranslateRunning;

	useEffect(() => {
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
	]);

	useEffect(() => {
		onHandle?.(null);
		return () => onHandle?.(null);
	}, [onHandle]);

	const pageLayout = useMemo<PdfPageLayoutSlice>(
		() => ({
			hoverableRegionsByPage: EMPTY_LAYOUT_REGIONS_BY_PAGE,
			rawRegionsByPage,
			layoutOverlayVisible: false,
			layoutTranslateItemsByPage,
			layoutTranslatePageStateByPage,
		}),
		[
			rawRegionsByPage,
			layoutTranslateItemsByPage,
			layoutTranslatePageStateByPage,
		],
	);

	const pageHandlers = useMemo<PdfPageHandlers>(
		() => ({
			...EMPTY_HANDLERS,
			onTogglePageLayoutTranslate: togglePageLayoutTranslate,
		}),
		[togglePageLayoutTranslate],
	);

	const renderPage = useCallback(
		({ pageIndex, width, height, rotatedWidth, rotatedHeight }: PageLayout) => (
			<PdfPageLayers
				docId={docId}
				pageIndex={pageIndex}
				width={rotatedWidth || width}
				height={rotatedHeight || height}
				tone={pdfTone}
				zoomRef={zoomRef}
				annotationCap={null}
				marks={EMPTY_MARKS}
				layout={pageLayout}
				mode={PAGE_MODE}
				handlers={pageHandlers}
			/>
		),
		[docId, pdfTone, zoomRef, pageLayout, pageHandlers],
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
				<PanDragHandler
					active={isActive}
					hostRef={hostRef}
					allowLeftDrag={false}
				/>
				<ZoomGestureWrapper documentId={docId} enableWheel={false}>
					<GlobalPointerProvider documentId={docId}>
						<Scroller documentId={docId} renderPage={renderPage} />
					</GlobalPointerProvider>
				</ZoomGestureWrapper>
			</DockviewViewport>
		</div>
	);
}
