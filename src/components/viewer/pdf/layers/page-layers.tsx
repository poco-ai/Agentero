/**
 * Per-page layer stack rendered by EmbedPDF's `<Scroller renderPage>`: raster /
 * tiling / search / selection / annotation layers plus every Agentero overlay
 * (citation hits, layout boxes, bulk-translate text, mark source frames, gutter
 * pins).
 *
 * Memoized because the scroller re-renders every mounted page whenever its
 * layout changes; without a bail-out a single scroll frame rebuilds ten page
 * subtrees. Props are grouped into bundles the parent memoizes, so the shallow
 * comparison stays maintainable — a flat prop list would make it far too easy
 * to silently break memoization.
 */

import type { PdfLinkAnnoObject } from "@embedpdf/models";
import { AnnotationLayer } from "@embedpdf/plugin-annotation/react";
import { PagePointerProvider } from "@embedpdf/plugin-interaction-manager/react";
import { LayoutAnalysisLayer } from "@embedpdf/plugin-layout-analysis/react";
import { RenderLayer } from "@embedpdf/plugin-render/react";
import { SearchLayer } from "@embedpdf/plugin-search/react";
import { SelectionLayer } from "@embedpdf/plugin-selection/react";
import { TilingLayer } from "@embedpdf/plugin-tiling/react";
import { EyeOff, Languages, Loader2 } from "lucide-react";
import { memo, type RefObject, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
	EMPTY_CITATION_LINKS,
	EMPTY_COMMENTS,
	EMPTY_PINS,
	PAGE_LAYER_STYLE,
	PDF_BASE_LAYER_SCALE_CAP,
	pdfRasterDpr,
	pdfTileDpr,
} from "@/components/viewer/pdf/constants";
import { EMBED_PAGE_ATTR } from "@/components/viewer/pdf/coords";
import type { PdfTextLink } from "@/components/viewer/pdf/layers/citation-links";
import { CitationLinkLayer } from "@/components/viewer/pdf/layers/citation-links";
import { CommentCardsLayer } from "@/components/viewer/pdf/layers/comment-cards-layer";
import { HighlightAnnotationMenu } from "@/components/viewer/pdf/layers/highlight-annotation-menu";
import { LayoutTranslateOverlay } from "@/components/viewer/pdf/layers/layout-translate-overlay";
import { PdfRegionSelectLayer } from "@/components/viewer/pdf/layers/region-select-layer";
import { SelectionGutter } from "@/components/viewer/pdf/layers/selection-gutter";
import type { PageAnnotationComment } from "@/components/viewer/pdf/types";
import { cn } from "@/lib/core/utils";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import {
	type HighlightColor,
	highlightHoverOverlayColor,
} from "@/lib/pdf/highlight/palette";
import {
	isLayoutRegionActivation,
	LAYOUT_HINT_MIN_REGION_H_PX,
	LAYOUT_HINT_MIN_REGION_W_PX,
	type LayoutTranslateItem,
	layoutKindBorder,
	layoutKindFill,
	layoutKindHex,
	layoutKindI18nKey,
	type PdfLayoutRegion,
	type PointerOrigin,
} from "@/lib/pdf/layout";
import { PDF_PAGE_RASTER_DARK_CLASS } from "@/lib/pdf/page-theme";
import type { SelectionPin } from "@/lib/pdf/selection";

/** A mark region pinned to a page (visual draft frame / formula legend frame). */
type PageRegion = { page: number; region: PdfAskNormalizedRect } | null;

/**
 * Anchor geometry of an open ask / translate card. Anchor-only: it keeps its
 * identity while the card body streams, so the page layers skip re-rendering
 * per streamed chunk.
 */
export type PdfActiveCardAnchor = {
	id: string;
	/** 1-based page number */
	page: number;
	rects: PdfAskNormalizedRect[];
};

/** Marks and mark-derived overlays. Whole-document work, bucketed by page. */
export type PdfPageMarksSlice = {
	activeAskAnchor: PdfActiveCardAnchor | null;
	activeTranslateAnchor: PdfActiveCardAnchor | null;
	activeVisualTrace: PdfVisualSessionTrace | null;
	visualDraftRegion: PageRegion;
	/** Region whose crop is in flight; gets a spinner frame. */
	visualCropRegion: PageRegion;
	focusedLayoutRegion: PdfLayoutRegion | null;
	pinsByPage: ReadonlyMap<number, SelectionPin[]>;
	/** Annotated highlights per page for the right-edge comment rail. */
	commentsByPage: ReadonlyMap<number, PageAnnotationComment[]>;
	/** Comment currently being edited in the rail; null when idle. */
	editingCommentId: string | null;
	/**
	 * Visual-note crop to outline while its rail card is being edited
	 * (Notion-style: related region lights up).
	 */
	focusedVisualRegion: {
		page: number;
		rects: readonly PdfAskNormalizedRect[];
	} | null;
	/** Resolvable wiki target for comment copy-link/copy-embed; null hides them. */
	commentWikiTarget: string | null;
	citationLinks: ReadonlyMap<number, PdfLinkAnnoObject[]>;
	textLinks: ReadonlyMap<number, PdfTextLink[]>;
	activeCardId: string | null;
	/** Id of the comment-rail card currently being hovered; null when idle. */
	hoveredCommentId: string | null;
};

/** Layout-analysis derived overlays (hover targets, debug boxes, translations). */
export type PdfPageLayoutSlice = {
	hoverableRegionsByPage: ReadonlyMap<number, PdfLayoutRegion[]>;
	rawRegionsByPage: ReadonlyMap<number, PdfLayoutRegion[]>;
	layoutOverlayVisible: boolean;
	layoutTranslateItemsByPage: ReadonlyMap<
		number,
		readonly LayoutTranslateItem[]
	>;
	layoutTranslatePageStateByPage: ReadonlyMap<
		number,
		{ active: boolean; running: boolean }
	>;
};

/** Interaction modes that unmount or gate page layers. */
export type PdfPageModeSlice = {
	regionSelecting: boolean;
	visualCropPending: boolean;
	visualDraftOpen: boolean;
};

export type PdfPageHandlers = {
	onOpenPin: (pin: SelectionPin) => void;
	onCardHoverEnter: () => void;
	onCardHoverLeave: () => void;
	onCitationActivate: (link: PdfLinkAnnoObject) => void;
	onTextLinkActivate: (url: string) => void;
	onCitationHover: (link: PdfLinkAnnoObject | null) => void;
	onRegionSelect: (page: number, region: PdfAskNormalizedRect) => void;
	/** Click a figure / table / algorithm / formula hit target → crop + draft card. */
	onLayoutRegionClick: (region: PdfLayoutRegion) => void;
	onTogglePageLayoutTranslate: (pageIndex: number) => void;
	/** Delete a highlight annotation directly from its on-page selection menu. */
	onDeleteHighlightAnnotation: (pageIndex: number, id: string) => void;
	/** Open the note editor for a highlight from its on-page selection menu. */
	onEditHighlightAnnotation: (id: string) => void;
	/** Change the color of a highlight annotation from its on-page selection menu. */
	onChangeHighlightColor: (
		pageIndex: number,
		id: string,
		color: HighlightColor,
	) => void;
	/** Start in-place edit on a comment-rail card. */
	onOpenComment: (comment: PageAnnotationComment) => void;
	/** Commit in-place edit on a comment-rail card. */
	onSaveComment: (comment: PageAnnotationComment, text: string) => void;
	/** Discard in-place edit (Escape). */
	onCancelComment: () => void;
	/** Delete a highlight / visual note from its comment-rail card. */
	onDeleteComment: (comment: PageAnnotationComment) => void;
	/** Copy the comment card's `[[target@id]]` wikilink. */
	onCopyCommentLink: (comment: PageAnnotationComment) => void;
	/** Copy the comment card's `![[target@id]]` embed. */
	onCopyCommentEmbed: (comment: PageAnnotationComment) => void;
	/** Hover enters a comment-rail card. */
	onHoverComment: (comment: PageAnnotationComment) => void;
	/** Hover leaves a comment-rail card. */
	onLeaveComment: () => void;
};

export type PdfPageLayersProps = {
	docId: string;
	pageIndex: number;
	width: number;
	height: number;
	pdfDark: boolean;
	/** Read at render time only; page width/height already track zoom. */
	zoomRef: RefObject<number>;
	marks: PdfPageMarksSlice;
	layout: PdfPageLayoutSlice;
	mode: PdfPageModeSlice;
	handlers: PdfPageHandlers;
};

type PageTranslateTabProps = {
	pageIndex: number;
	active: boolean;
	running: boolean;
	onToggle: (pageIndex: number) => void;
};

const PAGE_TRANSLATE_TAB_WIDTH_PX = 32;
const PAGE_TRANSLATE_TAB_MIN_HEIGHT_PX = 72;

function labelCharacters(label: string): { key: string; char: string }[] {
	const seen = new Map<string, number>();
	return Array.from(label, (char) => {
		const count = (seen.get(char) ?? 0) + 1;
		seen.set(char, count);
		return { key: `${char}-${count}`, char };
	});
}

const PageTranslateTab = memo(function PageTranslateTab({
	pageIndex,
	active,
	running,
	onToggle,
}: PageTranslateTabProps) {
	const { t } = useTranslation("viewer");
	const label = running
		? t("pdf.layoutTranslate.pageRunning")
		: active
			? t("pdf.layoutTranslate.hidePage")
			: t("pdf.layoutTranslate.translatePage");
	const shortLabel = active
		? t("pdf.layoutTranslate.hidePageShort")
		: t("pdf.layoutTranslate.translatePageShort");
	const Icon = running ? Loader2 : active ? EyeOff : Languages;
	return (
		<button
			type="button"
			className={cn(
				"absolute top-3 right-0 z-[6] flex translate-x-full flex-col items-center justify-center gap-1 rounded-r-md border border-l-0 border-border/80 bg-background/95 px-1 py-2 font-medium text-[11px] text-foreground shadow-sm ring-1 ring-black/5 backdrop-blur-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 dark:ring-white/10",
				active && "border-primary/30 bg-primary/10 text-primary",
			)}
			style={{
				width: PAGE_TRANSLATE_TAB_WIDTH_PX,
				minWidth: PAGE_TRANSLATE_TAB_WIDTH_PX,
				minHeight: PAGE_TRANSLATE_TAB_MIN_HEIGHT_PX,
			}}
			aria-label={label}
			aria-pressed={active}
			onClick={(event) => {
				event.preventDefault();
				event.stopPropagation();
				onToggle(pageIndex);
			}}
			onPointerDown={(event) => event.stopPropagation()}
		>
			<Icon
				className={cn("size-3.5 shrink-0", running && "animate-spin")}
				aria-hidden="true"
			/>
			<span className="flex flex-col items-center gap-0.5 leading-none">
				{labelCharacters(shortLabel).map((part) => (
					<span key={part.key} className="block text-center">
						{part.char}
					</span>
				))}
			</span>
		</button>
	);
});

export const PdfPageLayers = memo(function PdfPageLayers({
	docId,
	pageIndex,
	width,
	height,
	pdfDark,
	zoomRef,
	marks,
	layout,
	mode,
	handlers,
}: PdfPageLayersProps) {
	const { t } = useTranslation("viewer");
	/**
	 * Pointer position at the last pointerdown on a layout hit target. A click
	 * that travelled beyond the tolerance was a drag, not an activation.
	 */
	const pointerOriginRef = useRef<PointerOrigin | null>(null);
	const pageNumber = pageIndex + 1;
	const activeAskOnPage =
		marks.activeAskAnchor?.page === pageNumber ? marks.activeAskAnchor : null;
	const activeTranslateOnPage =
		marks.activeTranslateAnchor?.page === pageNumber
			? marks.activeTranslateAnchor
			: null;
	const activeVisualOnPage =
		marks.activeVisualTrace?.page === pageNumber
			? marks.activeVisualTrace
			: null;
	const visualDraftRegionOnPage =
		marks.visualDraftRegion?.page === pageNumber
			? marks.visualDraftRegion.region
			: null;
	const visualCropRegionOnPage =
		marks.visualCropRegion?.page === pageNumber
			? marks.visualCropRegion.region
			: null;
	const focusedLayoutOnPage =
		marks.focusedLayoutRegion?.pageIndex === pageIndex
			? marks.focusedLayoutRegion
			: null;
	const pins = marks.pinsByPage.get(pageNumber) ?? EMPTY_PINS;
	const comments = marks.commentsByPage.get(pageNumber) ?? EMPTY_COMMENTS;
	const layoutTranslateOnPage =
		layout.layoutTranslateItemsByPage.get(pageIndex);
	const pageTranslateState = layout.layoutTranslatePageStateByPage.get(
		pageIndex,
	) ?? { active: false, running: false };
	const emphasizedCommentId = marks.hoveredCommentId ?? marks.editingCommentId;
	const emphasizedComment = emphasizedCommentId
		? (comments.find((c) => c.id === emphasizedCommentId) ?? null)
		: null;
	const isHoveredComment =
		!!emphasizedComment && emphasizedComment.id === marks.hoveredCommentId;
	const isEditingComment =
		!!emphasizedComment && emphasizedComment.id === marks.editingCommentId;
	// Page shell: paper-white in light mode; near-black when PDF dark mode is on
	// so loading gaps match inverted page rasters.
	return (
		<div
			className={cn(
				"relative overflow-visible rounded-sm shadow-sm ring-1",
				pdfDark ? "bg-zinc-900 ring-white/10" : "bg-white ring-black/5",
			)}
			style={{ width, height }}
			{...{ [EMBED_PAGE_ATTR]: pageIndex }}
		>
			{/*
			 * EmbedPDF has no page color-scheme API yet (UI chrome theme only).
			 * Invert + hue-rotate only the raster layers so selection / search /
			 * annotation / pin overlays keep their intended colors. Agent crops
			 * use engine.renderPageRect and are unaffected.
			 */}
			<RenderLayer
				documentId={docId}
				pageIndex={pageIndex}
				scale={Math.min(zoomRef.current, PDF_BASE_LAYER_SCALE_CAP)}
				dpr={pdfRasterDpr()}
				className={pdfDark ? PDF_PAGE_RASTER_DARK_CLASS : undefined}
				style={PAGE_LAYER_STYLE}
			/>
			<TilingLayer
				documentId={docId}
				pageIndex={pageIndex}
				dpr={pdfTileDpr()}
				className={pdfDark ? PDF_PAGE_RASTER_DARK_CLASS : undefined}
				style={PAGE_LAYER_STYLE}
			/>
			<SearchLayer
				documentId={docId}
				pageIndex={pageIndex}
				style={PAGE_LAYER_STYLE}
			/>
			{/*
			 * EmbedPDF raw bbox layer — kept mounted for plugin state, but
			 * visibility is forced off (see effect). Store-backed boxes below.
			 */}
			<LayoutAnalysisLayer
				documentId={docId}
				pageIndex={pageIndex}
				style={PAGE_LAYER_STYLE}
			/>
			<PagePointerProvider
				documentId={docId}
				pageIndex={pageIndex}
				style={PAGE_LAYER_STYLE}
			>
				{/* Unmount text selection while framing a visual region. */}
				{mode.regionSelecting ? null : (
					<SelectionLayer documentId={docId} pageIndex={pageIndex} />
				)}
				<AnnotationLayer
					documentId={docId}
					pageIndex={pageIndex}
					selectionMenu={(menuProps) => (
						<HighlightAnnotationMenu
							{...menuProps}
							onEdit={handlers.onEditHighlightAnnotation}
							onDelete={handlers.onDeleteHighlightAnnotation}
							onChangeColor={handlers.onChangeHighlightColor}
						/>
					)}
				/>
				<PageTranslateTab
					pageIndex={pageIndex}
					active={pageTranslateState.active}
					running={pageTranslateState.running}
					onToggle={handlers.onTogglePageLayoutTranslate}
				/>
				<CitationLinkLayer
					links={marks.citationLinks.get(pageIndex) ?? EMPTY_CITATION_LINKS}
					textLinks={marks.textLinks.get(pageIndex) ?? []}
					pageWidthPt={width / zoomRef.current}
					pageHeightPt={height / zoomRef.current}
					label={t("pdf.linkAria")}
					onActivate={handlers.onCitationActivate}
					onTextActivate={handlers.onTextLinkActivate}
					onHover={handlers.onCitationHover}
				/>
				<PdfRegionSelectLayer
					active={mode.regionSelecting && !mode.visualCropPending}
					label={t("pdfExplain.regionSelectionLabel", {
						page: pageNumber,
					})}
					onSelect={(region) => handlers.onRegionSelect(pageNumber, region)}
				/>
				{/*
				 * Debug Eye overlay: pre-merge detections (all kinds, no NMS),
				 * score ≥ LAYOUT_SIDEBAR_MIN_SCORE (30%). Label = kind + conf.
				 */}
				{layout.layoutOverlayVisible
					? layout.rawRegionsByPage.get(pageIndex)?.map((region) => {
							const pct = Math.round(region.score * 100);
							const kindLabel = t(layoutKindI18nKey(region.kind));
							const label = t("figures.overlayLabel", {
								kind: kindLabel,
								pct,
							});
							return (
								<div
									key={`layout-box-${region.id}`}
									className="pointer-events-none absolute z-[1] rounded-none border"
									style={{
										left: `${region.bbox.x * 100}%`,
										top: `${region.bbox.y * 100}%`,
										width: `${region.bbox.w * 100}%`,
										height: `${region.bbox.h * 100}%`,
										borderColor: layoutKindBorder(region.kind),
										backgroundColor: layoutKindFill(region.kind),
									}}
									aria-hidden="true"
								>
									<span
										className="absolute top-0 left-0 max-w-full truncate rounded-br-sm px-1 py-px font-medium text-[10px] text-white leading-4"
										style={{
											backgroundColor: layoutKindHex(region.kind),
										}}
									>
										{label}
									</span>
								</div>
							);
						})
					: null}
				{/* Bulk layout translate: progressive text overlays over body blocks. */}
				{layoutTranslateOnPage && layoutTranslateOnPage.length > 0 ? (
					<LayoutTranslateOverlay
						items={layoutTranslateOnPage}
						pageWidthPx={width}
						pageHeightPx={height}
						pdfDark={pdfDark}
					/>
				) : null}
				{/*
				 * Hit targets for post-merge figure/table/algorithm/formula.
				 * Largest first so smaller boxes stack on top and win pointer hits.
				 * Hidden when framing or a visual draft is open (not during crop:
				 * unmount leave must not cancel an in-flight crop).
				 * All kinds crop on click; hover and keyboard focus preview the
				 * exact bbox that would be cropped.
				 */}
				{!mode.regionSelecting && !mode.visualDraftOpen
					? layout.hoverableRegionsByPage.get(pageIndex)?.map((region) => {
							// Fixed-size chip in a zoom-scaled box: only draw it where
							// it actually fits inside the region.
							const showHint =
								region.bbox.w * width >= LAYOUT_HINT_MIN_REGION_W_PX &&
								region.bbox.h * height >= LAYOUT_HINT_MIN_REGION_H_PX;
							return (
								<button
									key={`layout-hit-${region.id}`}
									type="button"
									data-layout-hit={region.id}
									aria-label={t("figures.clickAnnotateAria", {
										kind: t(layoutKindI18nKey(region.kind)),
									})}
									// Click crops in place; pointer cursor is reserved for
									// navigation (citation links).
									className="group absolute z-[2] cursor-crosshair rounded-none border-0 bg-transparent p-0 transition-colors hover:bg-primary/5"
									style={{
										left: `${region.bbox.x * 100}%`,
										top: `${region.bbox.y * 100}%`,
										width: `${region.bbox.w * 100}%`,
										height: `${region.bbox.h * 100}%`,
									}}
									onPointerDown={(event) => {
										pointerOriginRef.current = {
											x: event.clientX,
											y: event.clientY,
										};
									}}
									onClick={(event) => {
										const origin = pointerOriginRef.current;
										pointerOriginRef.current = null;
										// A drag that merely started here is not a click.
										if (
											!isLayoutRegionActivation({
												detail: event.detail,
												origin,
												end: { x: event.clientX, y: event.clientY },
											})
										) {
											return;
										}
										event.preventDefault();
										event.stopPropagation();
										handlers.onLayoutRegionClick(region);
									}}
								>
									{/*
									 * Frame the exact crop bounds before the click commits, and
									 * give keyboard focus a visible landmark over unpredictable
									 * page content.
									 */}
									<span
										className="pointer-events-none absolute inset-0 border border-primary/45 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
										aria-hidden="true"
									/>
									{showHint ? (
										<span
											className="pointer-events-none absolute top-1 right-1 max-w-[calc(100%-0.5rem)] truncate rounded border border-border/60 bg-background/90 px-1.5 py-0.5 font-medium text-[10px] text-foreground/90 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
											aria-hidden="true"
										>
											{t("figures.clickAnnotateHint")}
										</span>
									) : null}
								</button>
							);
						})
					: null}
				{/* Open ask conversation card: highlight the anchored selection. */}
				{activeAskOnPage
					? activeAskOnPage.rects.map((rect) => (
							<div
								key={`${activeAskOnPage.id}-source-${rect.x}-${rect.y}-${rect.w}-${rect.h}`}
								className="pointer-events-auto absolute z-[1] rounded-[2px] bg-amber-300/45 dark:bg-amber-400/35"
								style={{
									left: `${rect.x * 100}%`,
									top: `${rect.y * 100}%`,
									width: `${rect.w * 100}%`,
									height: `${rect.h * 100}%`,
								}}
								aria-hidden="true"
								onMouseEnter={handlers.onCardHoverEnter}
								onMouseLeave={handlers.onCardHoverLeave}
							/>
						))
					: null}
				{activeTranslateOnPage
					? activeTranslateOnPage.rects.map((rect) => (
							<div
								key={`${activeTranslateOnPage.id}-source-${rect.x}-${rect.y}-${rect.w}-${rect.h}`}
								className="pointer-events-auto absolute z-[1] rounded-[2px] bg-yellow-300/40 dark:bg-yellow-400/35"
								style={{
									left: `${rect.x * 100}%`,
									top: `${rect.y * 100}%`,
									width: `${rect.w * 100}%`,
									height: `${rect.h * 100}%`,
								}}
								aria-hidden="true"
								onMouseEnter={handlers.onCardHoverEnter}
								onMouseLeave={handlers.onCardHoverLeave}
							/>
						))
					: null}
				{/* Open visual draft / mark: show the framed source region on-page. */}
				{visualDraftRegionOnPage ? (
					<div
						className="pointer-events-none absolute z-[2] rounded-none border border-primary/40 bg-primary/5 shadow-[0_0_0_1px_rgba(255,255,255,0.55)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
						style={{
							left: `${visualDraftRegionOnPage.x * 100}%`,
							top: `${visualDraftRegionOnPage.y * 100}%`,
							width: `${visualDraftRegionOnPage.w * 100}%`,
							height: `${visualDraftRegionOnPage.h * 100}%`,
						}}
						aria-hidden="true"
					/>
				) : null}
				{/*
				 * Crop in flight: PDFium renders the region asynchronously, so frame
				 * it and spin — otherwise a click looks like nothing happened.
				 */}
				{visualCropRegionOnPage ? (
					<div
						className="pointer-events-none absolute z-[3] flex items-center justify-center rounded-none border border-primary/50 bg-primary/10 shadow-[0_0_0_1px_rgba(255,255,255,0.55)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
						style={{
							left: `${visualCropRegionOnPage.x * 100}%`,
							top: `${visualCropRegionOnPage.y * 100}%`,
							width: `${visualCropRegionOnPage.w * 100}%`,
							height: `${visualCropRegionOnPage.h * 100}%`,
						}}
						role="status"
						aria-label={t("pdfExplain.cropping")}
					>
						<Loader2
							className="size-4 animate-spin text-primary"
							aria-hidden="true"
						/>
					</div>
				) : null}
				{/* Figures sidebar selection: EmbedPDF layout hue for kind. */}
				{focusedLayoutOnPage ? (
					<div
						className="pointer-events-none absolute z-[2] rounded-none border shadow-[0_0_0_1px_rgba(255,255,255,0.55)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
						style={{
							left: `${focusedLayoutOnPage.bbox.x * 100}%`,
							top: `${focusedLayoutOnPage.bbox.y * 100}%`,
							width: `${focusedLayoutOnPage.bbox.w * 100}%`,
							height: `${focusedLayoutOnPage.bbox.h * 100}%`,
							borderColor: layoutKindHex(focusedLayoutOnPage.kind),
							backgroundColor: layoutKindFill(focusedLayoutOnPage.kind),
							// Keep a slightly stronger edge for visibility.
							outline: `1px solid ${layoutKindBorder(focusedLayoutOnPage.kind)}`,
						}}
						aria-hidden="true"
					/>
				) : null}
				{/* Active visual mark: theme outline of the crop region. */}
				{activeVisualOnPage
					? activeVisualOnPage.rects.map((rect) => (
							<div
								key={`${activeVisualOnPage.id}-region-${rect.x}-${rect.y}-${rect.w}-${rect.h}`}
								className="pointer-events-none absolute z-[2] rounded-none border border-primary/40 bg-primary/5 shadow-[0_0_0_1px_rgba(255,255,255,0.55)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
								style={{
									left: `${rect.x * 100}%`,
									top: `${rect.y * 100}%`,
									width: `${rect.w * 100}%`,
									height: `${rect.h * 100}%`,
								}}
								aria-hidden="true"
							/>
						))
					: null}
				{/* Rail-edit focus: same crop outline when the visual note is
				    being edited in place and no pin card is already open. */}
				{!activeVisualOnPage && marks.focusedVisualRegion?.page === pageNumber
					? marks.focusedVisualRegion.rects.map((rect) => (
							<div
								key={`comment-focus-${rect.x}-${rect.y}-${rect.w}-${rect.h}`}
								className="pointer-events-none absolute z-[2] rounded-none border border-primary/40 bg-primary/5 shadow-[0_0_0_1px_rgba(255,255,255,0.55)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
								style={{
									left: `${rect.x * 100}%`,
									top: `${rect.y * 100}%`,
									width: `${rect.w * 100}%`,
									height: `${rect.h * 100}%`,
								}}
								aria-hidden="true"
							/>
						))
					: null}
				<SelectionGutter
					items={pins}
					activeId={marks.activeCardId}
					onOpen={handlers.onOpenPin}
					onEnter={handlers.onCardHoverEnter}
					onLeave={handlers.onCardHoverLeave}
				/>
				{/* Emphasis overlay for the hovered or edited comment-rail card. */}
				{emphasizedComment
					? emphasizedComment.rects.map((rect) => (
							<div
								key={`comment-hover-${emphasizedComment.id}-${rect.x}-${rect.y}-${rect.w}-${rect.h}`}
								className={cn(
									"pointer-events-none absolute z-[4] rounded-[1px]",
									emphasizedComment.kind === "visual"
										? cn(
												"box-border",
												isHoveredComment
													? "border-4 border-primary/80"
													: isEditingComment
														? "border-2 border-primary/60"
														: "border-2 border-primary/60",
											)
										: "mix-blend-multiply",
								)}
								style={{
									left: `${rect.x * 100}%`,
									top: `${rect.y * 100}%`,
									width: `${rect.w * 100}%`,
									height: `${rect.h * 100}%`,
									backgroundColor:
										emphasizedComment.kind === "visual"
											? "transparent"
											: highlightHoverOverlayColor(emphasizedComment.color),
								}}
								aria-hidden="true"
							/>
						))
					: null}
				<CommentCardsLayer
					items={comments}
					pageHeightPx={height}
					editingId={marks.editingCommentId}
					wikiTarget={marks.commentWikiTarget}
					hoveredId={marks.hoveredCommentId}
					onOpen={handlers.onOpenComment}
					onSave={handlers.onSaveComment}
					onCancel={handlers.onCancelComment}
					onDelete={handlers.onDeleteComment}
					onCopyLink={handlers.onCopyCommentLink}
					onCopyEmbed={handlers.onCopyCommentEmbed}
					onHover={handlers.onHoverComment}
					onLeave={handlers.onLeaveComment}
				/>
			</PagePointerProvider>
		</div>
	);
});
