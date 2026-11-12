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

import { useDocumentState } from "@embedpdf/core/react";
import {
	PdfAnnotationSubtype,
	type PdfHighlightAnnoObject,
	type PdfLinkAnnoObject,
	type Rect,
} from "@embedpdf/models";
import {
	AnnotationLayer,
	type BoxedAnnotationRenderer,
	type useAnnotationCapability,
} from "@embedpdf/plugin-annotation/react";
import { PagePointerProvider } from "@embedpdf/plugin-interaction-manager/react";
import { LayoutAnalysisLayer } from "@embedpdf/plugin-layout-analysis/react";
import { SearchLayer } from "@embedpdf/plugin-search/react";
import { TilingLayer } from "@embedpdf/plugin-tiling/react";
import { Bookmark, EyeOff, Languages, Loader2 } from "lucide-react";
import {
	memo,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { PDF_CHROME_CHIP } from "@/components/viewer/pdf/chrome/pdf-chrome-surface";
import {
	EMPTY_CITATION_LINKS,
	EMPTY_COMMENTS,
	EMPTY_PINS,
	PAGE_LAYER_STYLE,
	PDF_WORKER_SETTLE_MS,
	pdfTileDpr,
} from "@/components/viewer/pdf/constants";
import { EMBED_PAGE_ATTR } from "@/components/viewer/pdf/coords";
import { nativeSelectionBelongsToHost } from "@/components/viewer/pdf/host-dom";
import {
	AgenteroRenderLayer,
	pdfPageRenderRotation,
} from "@/components/viewer/pdf/layers/agentero-render-layer";
import { AskHighlightLayer } from "@/components/viewer/pdf/layers/ask-highlight-layer";
import {
	CitationLinkLayer,
	linkAnnotationUri,
	type PdfTextLink,
} from "@/components/viewer/pdf/layers/citation-links";
import { CommentCardsLayer } from "@/components/viewer/pdf/layers/comment-cards-layer";
import { HighlightAnnotationMenu } from "@/components/viewer/pdf/layers/highlight-annotation-menu";
import { LayoutTranslateOverlay } from "@/components/viewer/pdf/layers/layout-translate-overlay";
import { PASSIVE_LINK_RENDERER } from "@/components/viewer/pdf/layers/link-annotation";
import { PdfTextSelectionLayer } from "@/components/viewer/pdf/layers/pdf-text-selection-layer";
import {
	PASSIVE_HIGHLIGHT_RENDERER,
	READING_ANNOTATION_RENDERERS,
} from "@/components/viewer/pdf/layers/reading-annotation-renderers";
import { PdfRegionSelectLayer } from "@/components/viewer/pdf/layers/region-select-layer";
import { SelectionGutter } from "@/components/viewer/pdf/layers/selection-gutter";
import { PDF_VISUAL_REGION_FRAME_CLASS } from "@/components/viewer/pdf/layers/visual-region-frame";
import {
	askHighlightRects,
	commentForVisibleTranslation,
	selectionPinForVisibleTranslation,
} from "@/components/viewer/pdf/marks-index";
import type {
	PageAnnotationComment,
	ScreenPoint,
	SelectionCommentDraft,
} from "@/components/viewer/pdf/types";
import { cn } from "@/lib/core/utils";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import { isLiveAnnotation } from "@/lib/pdf/highlight/annotation-store";
import {
	HIGHLIGHT_HEX,
	HIGHLIGHT_OPACITY,
	type HighlightColor,
	highlightHoverOverlayColor,
} from "@/lib/pdf/highlight/palette";
import {
	resolveTranslatedHighlightIds,
	sentenceHighlightTints,
} from "@/lib/pdf/highlight/sentence-tint";
import type { HighlightQuoteTint } from "@/lib/pdf/highlight/translated-geometry";
import {
	isLayoutRegionActivation,
	isLayoutTranslateItemPainted,
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
import { translatedTextLinkKey } from "@/lib/pdf/layout/link-ink";
import { translatedLinkHoverAction } from "@/lib/pdf/layout/translated-link-hover";
import type {
	PreservedLinkAssignment,
	TranslateLinkBox,
} from "@/lib/pdf/layout/translated-links";
import {
	subscribeTranslationSelectionBands,
	translationSelectionBandsFor,
} from "@/lib/pdf/layout/translation-selection-bands";
import {
	pageQuarterTurns,
	shellFractionToUnrotatedPdf,
	unrotatedPageFrameTransform,
} from "@/lib/pdf/page-frame";
import {
	PDF_ANNOTATION_DARK_CLASS,
	PDF_PAGE_RASTER_DARK_CLASS,
	PDF_PAPER_SHELL_CLASS,
	PDF_PAPER_TINT,
	type PdfPaperTone,
} from "@/lib/pdf/page-theme";
import type { PdfNavigationRegion } from "@/lib/pdf/pending-pdf-page";
import type { SelectionPin } from "@/lib/pdf/selection";

/**
 * Paint unrotated PDF-point layers (highlights, selection tint) in the same
 * space as the upright tiles. Upright pages render children unchanged.
 */
function UnrotatedPageFrame({
	rotation,
	widthPx,
	heightPx,
	className,
	children,
}: {
	rotation: number;
	widthPx: number;
	heightPx: number;
	className?: string;
	children: ReactNode;
}) {
	const transform = unrotatedPageFrameTransform(rotation, widthPx, heightPx);
	if (!transform) return children;
	return (
		<div
			className={cn("pointer-events-none absolute top-0 left-0", className)}
			style={{
				width: widthPx,
				height: heightPx,
				transform,
				transformOrigin: "0 0",
			}}
		>
			{children}
		</div>
	);
}

const EMPTY_HIGHLIGHT_SET = new Set<string>();

/**
 * Saved translation selection. Same yellow as the English highlight, placed
 * in page fractions so it stays on the sentence the reader boxed.
 */
function TranslatedHighlightLayer({
	paints,
}: {
	paints: readonly {
		id: string;
		color: HighlightColor;
		rects: PdfAskNormalizedRect[];
	}[];
}) {
	if (!paints.length) return null;
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 z-[5]"
			style={{ isolation: "isolate", mixBlendMode: "multiply" }}
		>
			{paints.flatMap((paint) =>
				paint.rects.map((rect) => (
					<div
						key={`${paint.id}:${rect.x}:${rect.y}:${rect.w}:${rect.h}`}
						style={{
							position: "absolute",
							left: `${rect.x * 100}%`,
							top: `${rect.y * 100}%`,
							width: `${rect.w * 100}%`,
							height: `${rect.h * 100}%`,
							backgroundColor: HIGHLIGHT_HEX[paint.color],
							opacity: HIGHLIGHT_OPACITY,
						}}
					/>
				)),
			)}
		</div>
	);
}

/**
 * Text-selection highlight tint: a light translucent blue (Zotero-style) so the
 * underlying glyphs stay legible under the selection. Module-level so every
 * page shares one stable value.
 */
const PDF_TEXT_SELECTION_BACKGROUND = "rgba(96, 165, 250, 0.28)";
const EMPTY_SELECTION_BANDS: readonly PdfAskNormalizedRect[] = [];

/**
 * English draws one rectangle per line under the glyphs. This is that
 * rectangle for a translation drag. It stays under the Chinese, so the
 * characters remain readable, and it is one box so the gap between two
 * characters is not painted twice.
 */
function TranslationLiveSelection({
	documentId,
	pageIndex,
}: {
	documentId: string;
	pageIndex: number;
}) {
	const rects = useSyncExternalStore(
		subscribeTranslationSelectionBands,
		() => translationSelectionBandsFor(documentId, pageIndex),
		() => EMPTY_SELECTION_BANDS,
	);
	if (!rects.length) return null;
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 z-[5]"
		>
			{rects.map((rect) => (
				<div
					key={`${rect.x}:${rect.y}:${rect.w}:${rect.h}`}
					style={{
						position: "absolute",
						left: `${rect.x * 100}%`,
						top: `${rect.y * 100}%`,
						width: `${rect.w * 100}%`,
						height: `${rect.h * 100}%`,
						background: PDF_TEXT_SELECTION_BACKGROUND,
					}}
				/>
			))}
		</div>
	);
}

/**
 * Keeps a translation selection visible after focus moves into the note chip.
 * Sits with the English selection tint: above the translation paper, under
 * the glyphs, so the characters stay readable.
 */
function TranslationSelectionVeil({
	pages,
	pageIndex,
}: {
	pages: SelectionCommentDraft["visiblePages"];
	pageIndex: number;
}) {
	const rects = pages?.find((page) => page.pageIndex === pageIndex)?.rects;
	if (!rects?.length) return null;
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 z-[5]"
			style={{ isolation: "isolate", mixBlendMode: "multiply" }}
		>
			{rects.map((rect) => (
				<div
					key={`${rect.x}:${rect.y}:${rect.w}:${rect.h}`}
					style={{
						position: "absolute",
						left: `${rect.x * 100}%`,
						top: `${rect.y * 100}%`,
						width: `${rect.w * 100}%`,
						height: `${rect.h * 100}%`,
						background: PDF_TEXT_SELECTION_BACKGROUND,
					}}
				/>
			))}
		</div>
	);
}

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
	/** Translation-overlay boxes, when the open ask started on a translation. */
	translatedRects?: PdfAskNormalizedRect[];
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
	/** Embed-owned citation highlight; never cleared by global focus or its timer. */
	persistentRegion?: PdfNavigationRegion;
	/** Citation jump: yellow flash that auto-clears (vs persistent figures selection). */
	focusedLayoutFlash: boolean;
	/** Restarts the flash CSS animation when the same region is jumped again. */
	focusedLayoutFlashToken: number;
	pinsByPage: ReadonlyMap<number, SelectionPin[]>;
	/** Annotated highlights per page for the right-edge comment rail. */
	commentsByPage: ReadonlyMap<number, PageAnnotationComment[]>;
	/** Comment currently being edited in the rail; null when idle. */
	editingCommentId: string | null;
	/** Resolvable wiki target for comment copy-link/copy-embed; null hides them. */
	commentWikiTarget: string | null;
	citationLinks: ReadonlyMap<number, PdfLinkAnnoObject[]>;
	textLinks: ReadonlyMap<number, PdfTextLink[]>;
	activeCardId: string | null;
	/**
	 * Id of the comment-rail card currently being hovered; null when idle.
	 *
	 * @deprecated Superseded by the per-page `hoveredCommentId` prop, which
	 * the viewer gates to the owning page so a hover does not re-render every
	 * mounted page through this shared bundle. Optional so the translation
	 * pane's static slice keeps compiling; when set it is used as a fallback.
	 */
	hoveredCommentId?: string | null;
	/**
	 * Sticky text-selection comment chip (right rail). Null when idle or on a
	 * read-only remote PDF.
	 */
	selectionCommentDraft: SelectionCommentDraft | null;
	/**
	 * Persisted selection-translate spans. Painted even after the result card
	 * closes, above the layout-translate paper (z-3) and under its glyphs (z-6).
	 */
	translateHighlightsByPage: ReadonlyMap<
		number,
		{ id: string; rects: PdfAskNormalizedRect[] }[]
	>;
	/**
	 * English highlights keyed by 1-based page that have no translated boxes.
	 * The overlay tints the sentence whose English glyph boxes overlap `rects`.
	 * Nothing is written back. Highlights that stored their own translated
	 * boxes are omitted.
	 */
	highlightQuotesByPage: ReadonlyMap<number, readonly HighlightQuoteTint[]>;
	/**
	 * Translated selection boxes keyed by 1-based page. Painted instead of the
	 * English glyph boxes while this page's translation overlay is showing.
	 */
	translatedHighlightsByPage: ReadonlyMap<
		number,
		{ id: string; color: HighlightColor; rects: PdfAskNormalizedRect[] }[]
	>;
};

/** Layout-analysis derived overlays (hover targets, debug boxes, translations). */
export type PdfPageLayoutSlice = {
	selectionStartPageIndex?: number | null;
	selectionInsertionRegions?: readonly PdfLayoutRegion[];
	selectionTextExclusionsByPage?: ReadonlyMap<number, readonly Rect[]>;
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
	/**
	 * English glyph boxes for each sentence in a translated block, keyed by
	 * item id. Absent until that page's text layer has been read.
	 */
	sentenceRectsByItemId?: ReadonlyMap<
		string,
		readonly (readonly PdfAskNormalizedRect[])[]
	>;
	/**
	 * Raw PDF fill per translated-link key (`link.id`, or the text-link key).
	 * Absent until that page's text runs have been read.
	 */
	linkInkByKey?: ReadonlyMap<string, string>;
	/**
	 * PDF text runs for this page's translated blocks, in page fractions.
	 * Lets a grouped citation stay inside its own glyphs.
	 */
	glyphRunsByPage?: ReadonlyMap<
		number,
		readonly {
			text: string;
			box: { x: number; y: number; w: number; h: number };
		}[]
	>;
};

/** Interaction modes that unmount or gate page layers. */
export type PdfPageModeSlice = {
	regionSelecting: boolean;
	visualCropPending: boolean;
	visualDraftOpen: boolean;
	/**
	 * Dual-pane translation companion: keep raster + translate overlay only.
	 * Selection / annotation / search / citation chrome stay unmounted.
	 */
	translationOnly?: boolean;
	/** PDFs outside papers/: annotation / translate / layout layers stay off. */
	plainViewer?: boolean;
	/** Narrow embeds show active comment cards inside the page. */
	insetCommentCards?: boolean;
};

export type PdfPageHandlers = {
	onOpenPin: (pin: SelectionPin, preview?: boolean) => void;
	onCardHoverEnter: () => void;
	onCardHoverLeave: () => void;
	onCitationActivate: (link: PdfLinkAnnoObject) => void;
	onTextLinkActivate: (url: string) => void;
	onCitationHover: (
		link: PdfLinkAnnoObject | null,
		clientPoint?: ScreenPoint | null,
	) => void;
	/** External URL hover (annotation URI / Launch, or detected page text). */
	onLinkUrlHover?: (
		url: string | null,
		clientPoint?: ScreenPoint | null,
	) => void;
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
	/** Add a visual comment's crop to the Agent sidebar composer (#396). */
	onAddCommentToChat: (comment: PageAnnotationComment) => void;
	/** Hover enters a comment-rail card. */
	onHoverComment: (comment: PageAnnotationComment) => void;
	/** Hover leaves a comment-rail card. */
	onLeaveComment: () => void;
	/** Commit a typed note from the selection comment chip. */
	onCommitSelectionComment: (comment: string) => void;
	/** Keep the sticky draft alive while the chip is interacted with. */
	onSelectionCommentActiveChange: (active: boolean) => void;
	/** Drop the sticky selection comment chip. */
	onDismissSelectionComment: () => void;
};

/**
 * EmbedPDF annotation capability. Passed in by the caller rather than read
 * with `useAnnotationCapability()` here: the slim dual-pane translation
 * viewer renders `PdfPageLayers` without registering the annotation plugin,
 * and that hook throws ("Plugin annotation not found") when the plugin is
 * absent — hooks run before the `mode.translationOnly` early return.
 */
type AnnotationCapabilityProvides = ReturnType<
	typeof useAnnotationCapability
>["provides"];

export type PdfPageLayersProps = {
	onBookmarkPage?: (pageIndex: number) => void;
	pageBookmarked?: boolean;
	bookmarkSaving?: boolean;
	annotationSource?: string;
	docId: string;
	pageIndex: number;
	/** Finished translated PDF registered as a hidden display document. */
	reflowDocumentId?: string | null;
	/** Lightweight version currently loaded by the hidden translated document. */
	reflowDocumentVersion?:
		| import("@/lib/pdf/reflow/output-version").ReflowOutputVersion
		| null;
	width: number;
	height: number;
	/** Paper tone for this viewer (process-wide preference). */
	tone: PdfPaperTone;
	/** Read at render time only; page width/height already track zoom. */
	zoomRef: RefObject<number>;
	/** EmbedPDF capability from the owning viewer; null in panes without the annotation plugin. */
	annotationCap: AnnotationCapabilityProvides;
	marks: PdfPageMarksSlice;
	/**
	 * Id of the hovered comment-rail card, gated by the caller to the page
	 * that owns the comment (null elsewhere): the emphasis overlay and the
	 * rail highlight only exist on the owning page, so gating keeps every
	 * other page's memo intact while the hover id flips.
	 */
	hoveredCommentId?: string | null;
	layout: PdfPageLayoutSlice;
	mode: PdfPageModeSlice;
	handlers: PdfPageHandlers;
};

type PageTranslateTabProps = {
	pageIndex: number;
	active: boolean;
	running: boolean;
	/** Current PDF zoom; the tab shrinks and grows with the page. */
	zoom: number;
	onToggle: (pageIndex: number) => void;
};

/**
 * In-page translate / hide tab, inside the page's top-left corner (just
 * inward of the old outside-left hang). Mounted only while the page is
 * hovered. Match PDF chrome: Callout `text-xs`, `size-3.5` icons,
 * `h-7`-wide hit target, shared surface. Rem sizes keep Windows
 * non-integer DPR from drifting the tab.
 */
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
	zoom,
	onToggle,
}: PageTranslateTabProps) {
	const { t } = useTranslation("viewer");
	const scale = zoom > 0 ? zoom : 1;
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
			data-pdf-chrome
			className={cn(
				"pointer-events-auto absolute top-2 left-2 z-[8] flex w-7 min-h-16 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 font-medium text-xs text-foreground transition-colors duration-100 hover:bg-muted/80 active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
				PDF_CHROME_CHIP,
				active && "border-primary/30 bg-primary/10 text-primary",
			)}
			style={{
				// Layout-level zoom re-computes the chip's font, icon, and padding
				// sizes before painting; transform scaling stretches a texture.
				zoom: scale,
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
	onBookmarkPage,
	pageBookmarked = false,
	bookmarkSaving = false,
	annotationSource,
	docId,
	pageIndex,
	reflowDocumentId,
	reflowDocumentVersion,
	width,
	height,
	tone,
	zoomRef,
	annotationCap,
	marks,
	hoveredCommentId: hoveredCommentIdProp,
	layout,
	mode,
	handlers,
}: PdfPageLayersProps) {
	const { t } = useTranslation("viewer");
	const documentState = useDocumentState(docId);
	const pageRotation = pdfPageRenderRotation(documentState, pageIndex);
	const pageScale =
		documentState?.scale && documentState.scale > 0 ? documentState.scale : 1;
	const pageSize = documentState?.document?.pages[pageIndex]?.size;
	const quarter = pageQuarterTurns(pageRotation);
	const frameWidth =
		pageSize?.width && pageSize.width > 0
			? pageSize.width * pageScale
			: quarter % 2 === 1
				? height
				: width;
	const frameHeight =
		pageSize?.height && pageSize.height > 0
			? pageSize.height * pageScale
			: quarter % 2 === 1
				? width
				: height;
	const pdfDark = tone === "dark";
	const paperTint = PDF_PAPER_TINT[tone];
	const cardScale = zoomRef.current > 0 ? zoomRef.current : 1;
	const pageShellRef = useRef<HTMLDivElement | null>(null);
	/**
	 * Lazily arm text selection once the pointer reaches the page. Registering
	 * on mount made the viewer extract PDFium glyph geometry for every
	 * scroller-buffer page the moment a document opened; that work shares the
	 * single PDFium worker with the first raster render, delaying both first
	 * paint and the page becoming selectable. Arming on pointer intent keeps the
	 * page selectable the moment the user reaches for it while leaving
	 * off-screen buffer pages unloaded.
	 */
	const [selectionArmed, setSelectionArmed] = useState(false);
	/** Show the in-page translate/hide tab only while the pointer is on this page. */
	const [pageHovered, setPageHovered] = useState(false);
	const armSelection = () => {
		if (!selectionArmed) setSelectionArmed(true);
	};
	/**
	 * Prefetch selection geometry only after the page stays visible. Arming on
	 * the first intersection queued `getPageGeometry` for every page a fling
	 * crosses, and that extraction shares the single PDFium worker with the
	 * raster. Pointer entry still arms immediately.
	 */
	useEffect(() => {
		if (selectionArmed) return;
		const el = pageShellRef.current;
		if (!el) return;
		if (typeof IntersectionObserver === "undefined") {
			setSelectionArmed(true);
			return;
		}
		let timer = 0;
		const observer = new IntersectionObserver((entries) => {
			const visible = entries.some((entry) => entry.isIntersecting);
			if (!visible) {
				window.clearTimeout(timer);
				timer = 0;
				return;
			}
			if (timer) return;
			timer = window.setTimeout(() => {
				observer.disconnect();
				setSelectionArmed(true);
			}, PDF_WORKER_SETTLE_MS);
		});
		observer.observe(el);
		return () => {
			window.clearTimeout(timer);
			observer.disconnect();
		};
	}, [selectionArmed]);
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
	const persistentRegion =
		marks.persistentRegion?.pageIndex === pageIndex
			? marks.persistentRegion
			: null;

	const pins = marks.pinsByPage.get(pageNumber) ?? EMPTY_PINS;
	const comments = marks.commentsByPage.get(pageNumber) ?? EMPTY_COMMENTS;
	// Per-page gated prop wins; the translation pane still passes the id
	// inside `marks`.
	const hoveredCommentId =
		hoveredCommentIdProp ?? marks.hoveredCommentId ?? null;
	const selectionDraftOnPage =
		marks.selectionCommentDraft?.page === pageNumber
			? marks.selectionCommentDraft
			: null;
	const translateHighlightsOnPage =
		marks.translateHighlightsByPage.get(pageNumber) ?? [];
	const layoutTranslateOnPage =
		layout.layoutTranslateItemsByPage.get(pageIndex);
	const translationVisible =
		layoutTranslateOnPage?.some(isLayoutTranslateItemPainted) ?? false;
	const shownComments = translationVisible
		? comments.map((comment) => commentForVisibleTranslation(comment, true))
		: comments;
	const shownPins = useMemo(
		() =>
			translationVisible
				? pins.map((pin) => selectionPinForVisibleTranslation(pin, true))
				: pins,
		[pins, translationVisible],
	);
	const askHighlights = useMemo(() => {
		const paints: { id: string; rects: readonly PdfAskNormalizedRect[] }[] = [];
		const seen = new Set<string>();
		for (const pin of pins) {
			if (pin.kind !== "ask") continue;
			const rects = askHighlightRects(pin, translationVisible);
			if (!rects.length) continue;
			seen.add(pin.id);
			paints.push({ id: pin.id, rects });
		}
		if (activeAskOnPage && !seen.has(activeAskOnPage.id)) {
			const rects = askHighlightRects(activeAskOnPage, translationVisible);
			if (rects.length) paints.push({ id: activeAskOnPage.id, rects });
		}
		return paints;
	}, [activeAskOnPage, pins, translationVisible]);
	const pageTranslateState = layout.layoutTranslatePageStateByPage.get(
		pageIndex,
	) ?? { active: false, running: false };
	const emphasizedCommentId = hoveredCommentId ?? marks.editingCommentId;
	const emphasizedComment = emphasizedCommentId
		? (shownComments.find((c) => c.id === emphasizedCommentId) ?? null)
		: null;
	const translatedPaints =
		marks.translatedHighlightsByPage.get(pageNumber) ?? [];
	const highlightQuotes = marks.highlightQuotesByPage.get(pageNumber);
	const resolvedTranslatedIds = useMemo(
		() =>
			translationVisible
				? resolveTranslatedHighlightIds({
						translatedPaints,
						highlightQuotes,
						layoutItems: layoutTranslateOnPage,
						sentenceRectsByItemId: layout.sentenceRectsByItemId,
					})
				: EMPTY_HIGHLIGHT_SET,
		[
			translationVisible,
			translatedPaints,
			highlightQuotes,
			layoutTranslateOnPage,
			layout.sentenceRectsByItemId,
		],
	);
	const translatedSentenceTints = useMemo(
		() =>
			translationVisible
				? sentenceHighlightTints({
						layoutItems: layoutTranslateOnPage,
						highlightQuotes,
						sentenceRectsByItemId: layout.sentenceRectsByItemId,
					})
				: null,
		[
			translationVisible,
			layoutTranslateOnPage,
			highlightQuotes,
			layout.sentenceRectsByItemId,
		],
	);
	const annotationRenderers = useMemo<BoxedAnnotationRenderer[]>(() => {
		if (!translationVisible || resolvedTranslatedIds.size === 0) {
			return READING_ANNOTATION_RENDERERS;
		}
		return [
			{
				...PASSIVE_HIGHLIGHT_RENDERER,
				render: (props) => {
					if (resolvedTranslatedIds.has(props.currentObject.id)) {
						return (
							<span className="pointer-events-none hidden" aria-hidden="true" />
						);
					}
					return PASSIVE_HIGHLIGHT_RENDERER.render(props);
				},
			},
			PASSIVE_LINK_RENDERER,
		];
	}, [translationVisible, resolvedTranslatedIds]);

	const shellFractionAt = (clientX: number, clientY: number) => {
		const pageRect = pageShellRef.current?.getBoundingClientRect();
		if (!pageRect?.width || !pageRect.height) return null;
		const x = (clientX - pageRect.left) / pageRect.width;
		const y = (clientY - pageRect.top) / pageRect.height;
		if (x < 0 || x > 1 || y < 0 || y > 1) return null;
		// CSS zoom preview scales the live box without changing `width`. The
		// fraction stays on the page; restorePosition then undoes /Rotate.
		return shellFractionToUnrotatedPdf(
			{ x, y },
			pageRotation,
			width,
			height,
			zoomRef.current,
		);
	};

	const textCommentAtPoint = (clientX: number, clientY: number) => {
		if (!shownComments.length) return null;
		const point = shellFractionAt(clientX, clientY);
		if (!point) return null;
		return (
			shownComments.find(
				(comment) =>
					comment.kind !== "visual" &&
					comment.rects.some(
						(rect) =>
							point.x >= rect.x &&
							point.x <= rect.x + rect.w &&
							point.y >= rect.y &&
							point.y <= rect.y + rect.h,
					),
			) ?? null
		);
	};

	const highlightAtPoint = (clientX: number, clientY: number) => {
		const point = shellFractionAt(clientX, clientY);
		if (!point || !annotationCap) return null;
		const zoom = zoomRef.current > 0 ? zoomRef.current : 1;
		const unrotatedWidthPt = (quarter % 2 === 1 ? height : width) / zoom;
		const unrotatedHeightPt = (quarter % 2 === 1 ? width : height) / zoom;
		if (translationVisible) {
			const x = point.x;
			const y = point.y;
			const hit = translatedPaints.find((paint) =>
				paint.rects.some(
					(rect) =>
						x >= rect.x &&
						x <= rect.x + rect.w &&
						y >= rect.y &&
						y <= rect.y + rect.h,
				),
			);
			if (hit) {
				const tracked = annotationCap
					.forDocument(docId)
					.getAnnotationById(hit.id);
				if (tracked && isLiveAnnotation(tracked)) {
					const object = tracked.object;
					if (
						object.type === PdfAnnotationSubtype.HIGHLIGHT &&
						object.pageIndex === pageIndex
					) {
						return object;
					}
				}
			}
		}
		const pageXPt = point.x * unrotatedWidthPt;
		const pageYPt = point.y * unrotatedHeightPt;
		const highlights = annotationCap
			.forDocument(docId)
			.getAnnotations()
			.filter(isLiveAnnotation)
			.map((annotation) => annotation.object)
			.filter(
				(annotation): annotation is PdfHighlightAnnoObject =>
					annotation.type === PdfAnnotationSubtype.HIGHLIGHT &&
					annotation.pageIndex === pageIndex &&
					(!translationVisible || !resolvedTranslatedIds.has(annotation.id)),
			);
		return (
			highlights.find((highlight) => {
				const segments = highlight.segmentRects?.length
					? highlight.segmentRects
					: [highlight.rect];
				return segments.some(
					(rect) =>
						pageXPt >= rect.origin.x &&
						pageXPt <= rect.origin.x + rect.size.width &&
						pageYPt >= rect.origin.y &&
						pageYPt <= rect.origin.y + rect.size.height,
				);
			}) ?? null
		);
	};

	const handlePagePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		// Any movement over the page is selection intent: arm the geometry load
		// even if `pointerenter` was missed (e.g. a page scrolled under a
		// stationary cursor).
		armSelection();
		if ((event.target as Element | null)?.closest("[data-pdf-chrome]")) return;
		const comment = textCommentAtPoint(event.clientX, event.clientY);
		if (comment?.id === hoveredCommentId) return;
		if (comment) {
			handlers.onHoverComment(comment);
			return;
		}
		// Visual notes own their hover through the crop hit targets and rail
		// cards. Clearing here would cancel the hover frame on the next pointer
		// move inside an already-annotated crop.
		const hoveringVisual =
			hoveredCommentId !== null &&
			shownComments.some(
				(item) => item.id === hoveredCommentId && item.kind === "visual",
			);
		if (hoveredCommentId && !hoveringVisual) handlers.onLeaveComment();
	};

	const handlePagePointerLeave = () => {
		if (hoveredCommentId) handlers.onLeaveComment();
	};

	const translatedHighlightAtTarget = (
		target: EventTarget | null,
	): string | null => {
		if (!translatedSentenceTints) return null;
		const sentenceEl = (target as Element | null)?.closest?.("[data-sentence]");
		if (!sentenceEl) return null;
		const itemId = sentenceEl
			.closest("[data-layout-item]")
			?.getAttribute("data-layout-item");
		const sentenceIndex = Number(sentenceEl.getAttribute("data-sentence"));
		if (!itemId || !Number.isInteger(sentenceIndex)) return null;
		return (
			translatedSentenceTints.get(itemId)?.get(sentenceIndex)?.highlightId ??
			null
		);
	};

	const handlePageClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
		if ((event.target as Element | null)?.closest("[data-pdf-chrome]")) return;
		// A translation overlay selection is a real DOM range; page clicks must not
		// steal it. Selections elsewhere in the app (notes, Agent panel) must not
		// block annotation hits.
		const viewerRoot = pageShellRef.current?.closest("[data-pdf-root]");
		if (
			viewerRoot instanceof HTMLElement &&
			nativeSelectionBelongsToHost(viewerRoot)
		) {
			return;
		}
		const comment = textCommentAtPoint(event.clientX, event.clientY);
		if (comment) {
			event.stopPropagation();
			handlers.onOpenComment(comment);
			return;
		}
		const highlight = highlightAtPoint(event.clientX, event.clientY);
		if (!highlight) {
			// In translated mode the English highlight is replaced by a sentence
			// tint with no annotation hit area. Resolve the clicked sentence back
			// to its highlight so the annotation menu (recolor / edit / delete)
			// stays reachable.
			const tintedId = translatedHighlightAtTarget(event.target);
			if (!tintedId) return;
			event.stopPropagation();
			annotationCap?.forDocument(docId).selectAnnotation(pageIndex, tintedId);
			return;
		}
		event.stopPropagation();
		annotationCap?.forDocument(docId).selectAnnotation(pageIndex, highlight.id);
	};

	const paperRaster = (
		<div className="absolute inset-0 isolate">
			{/*
			 * Dual-pane translation already paints tiles, and the whole-page base
			 * coat is a second PDFium job on the shared worker. The page shell
			 * covers the gap until those tiles arrive.
			 */}
			{mode.translationOnly ? null : (
				<AgenteroRenderLayer
					pageRef={pageShellRef}
					documentId={docId}
					pageIndex={pageIndex}
					scale={1}
					dpr={1}
					className={pdfDark ? PDF_PAGE_RASTER_DARK_CLASS : undefined}
					style={PAGE_LAYER_STYLE}
				/>
			)}
			<TilingLayer
				documentId={docId}
				pageIndex={pageIndex}
				dpr={pdfTileDpr()}
				className={pdfDark ? PDF_PAGE_RASTER_DARK_CLASS : undefined}
				style={PAGE_LAYER_STYLE}
			/>
			{/*
			 * Tinted paper: multiply over the rasters only, so white paper lands on
			 * the tone while text stays black and figures keep their saturation.
			 * Painted below the interaction layers so highlights stay untouched.
			 */}
			{paperTint ? (
				<div
					aria-hidden
					className="pointer-events-none absolute inset-0 mix-blend-multiply"
					style={{ backgroundColor: paperTint }}
				/>
			) : null}
		</div>
	);

	const translateLinkBoxes = useMemo(() => {
		const zoom = zoomRef.current || 1;
		const pageWidthPt = width / zoom;
		const pageHeightPt = height / zoom;
		if (pageWidthPt <= 0 || pageHeightPt <= 0) return [] as TranslateLinkBox[];
		const boxes: TranslateLinkBox[] = [];
		const ink = layout.linkInkByKey;
		const norm = (rect: {
			origin: { x: number; y: number };
			size: { width: number; height: number };
		}): TranslateLinkBox["box"] => ({
			x: rect.origin.x / pageWidthPt,
			y: rect.origin.y / pageHeightPt,
			w: rect.size.width / pageWidthPt,
			h: rect.size.height / pageHeightPt,
		});
		const withInk = (box: TranslateLinkBox, key: string): TranslateLinkBox => {
			const color = ink?.get(key);
			return color ? { ...box, color } : box;
		};
		for (const link of marks.citationLinks.get(pageIndex) ?? []) {
			const url = linkAnnotationUri(link);
			boxes.push(
				withInk(
					{
						key: link.id,
						kind: url ? "url" : "goto",
						url: url ?? undefined,
						box: norm(link.rect),
					},
					link.id,
				),
			);
		}
		for (const link of marks.textLinks.get(pageIndex) ?? []) {
			const key = translatedTextLinkKey(link);
			boxes.push(
				withInk(
					{
						key,
						kind: "url",
						url: link.url,
						box: norm(link.rect),
					},
					key,
				),
			);
		}
		return boxes;
	}, [
		height,
		layout.linkInkByKey,
		marks.citationLinks,
		marks.textLinks,
		pageIndex,
		width,
		zoomRef,
	]);
	const citationById = useMemo(() => {
		const map = new Map<string, PdfLinkAnnoObject>();
		for (const link of marks.citationLinks.get(pageIndex) ?? []) {
			map.set(link.id, link);
		}
		return map;
	}, [marks.citationLinks, pageIndex]);
	const openTranslatedLink = useCallback(
		(assignment: PreservedLinkAssignment) => {
			if (assignment.key) {
				const link = citationById.get(assignment.key);
				if (link) {
					const url = linkAnnotationUri(link);
					if (url) handlers.onTextLinkActivate(url);
					else handlers.onCitationActivate(link);
					return;
				}
			}
			if (assignment.url) handlers.onTextLinkActivate(assignment.url);
		},
		[citationById, handlers],
	);
	const hoverTranslatedLink = useCallback(
		(
			assignment: PreservedLinkAssignment | null,
			point: { x: number; y: number; top: number; bottom: number } | null,
		) => {
			const link = assignment?.key
				? citationById.get(assignment.key)
				: undefined;
			const action = translatedLinkHoverAction(assignment, link);
			if (action.kind === "url") {
				handlers.onCitationHover(null);
				handlers.onLinkUrlHover?.(action.url, point);
				return;
			}
			handlers.onLinkUrlHover?.(null);
			if (action.kind === "citation") {
				handlers.onCitationHover(action.link, point ?? undefined);
				return;
			}
			handlers.onCitationHover(null);
		},
		[citationById, handlers],
	);
	const translateOverlay =
		translationVisible && layoutTranslateOnPage ? (
			<LayoutTranslateOverlay
				items={layoutTranslateOnPage}
				pageIndex={pageIndex}
				reflowDocumentId={reflowDocumentId}
				reflowDocumentVersion={reflowDocumentVersion}
				zoom={
					pageSize?.width && pageSize.width > 0
						? width / pageSize.width
						: (zoomRef.current ?? 1)
				}
				pageWidthPx={width}
				pageHeightPx={height}
				tone={tone}
				layoutRegions={layout.rawRegionsByPage.get(pageIndex)}
				highlightQuotes={highlightQuotes}
				sentenceRectsByItemId={layout.sentenceRectsByItemId}
				links={translateLinkBoxes}
				glyphRuns={layout.glyphRunsByPage?.get(pageIndex)}
				onOpenLink={openTranslatedLink}
				onHoverLink={hoverTranslatedLink}
			/>
		) : null;

	// Dual-pane companion: raster + translated text only. Skipping the full
	// interaction stack halves per-page React work while the second EmbedPDF
	// instance is still warming up.
	// Keep both shells free of blurred shadows: they can cause long scroll
	// frames in WebKitGTK. The ring still provides a crisp paper edge.
	if (mode.translationOnly) {
		return (
			<div
				className={cn(
					"relative overflow-visible rounded-sm ring-1",
					PDF_PAPER_SHELL_CLASS[tone],
				)}
				style={{ width, height }}
				{...{ [EMBED_PAGE_ATTR]: pageIndex }}
			>
				{paperRaster}
				{translateOverlay}
			</div>
		);
	}

	// Page shell: matches the finished paper so loading gaps do not flash a
	// different colour.
	return (
		<div
			ref={pageShellRef}
			data-annotation-pdf={docId}
			data-annotation-source={annotationSource}
			data-annotation-page={pageIndex + 1}
			className={cn(
				"relative overflow-visible rounded-sm ring-1",
				PDF_PAPER_SHELL_CLASS[tone],
			)}
			style={{ width, height }}
			onPointerEnter={() => {
				armSelection();
				setPageHovered(true);
			}}
			onPointerMove={handlePagePointerMove}
			onPointerLeave={() => {
				setPageHovered(false);
				handlePagePointerLeave();
			}}
			onClickCapture={handlePageClickCapture}
			{...{ [EMBED_PAGE_ATTR]: pageIndex }}
		>
			{/*
			 * Paper group: rasters plus the tint that recolours them, isolated so the
			 * multiply blend reads only this page's paper and never the viewer
			 * backdrop. Isolation lives here rather than on the page shell so overlays
			 * that overflow the page (comment cards, translate tab, highlight menu)
			 * keep painting across page boundaries.
			 *
			 * EmbedPDF has no page color-scheme API yet (UI chrome theme only).
			 * Invert + hue-rotate only the raster layers so selection / search /
			 * annotation / pin overlays keep their intended colors. Agent crops
			 * use engine.renderPageRect and are unaffected.
			 */}
			{onBookmarkPage && (
				<button
					type="button"
					data-pdf-chrome
					className={cn(
						"absolute top-2 right-2 z-10 flex size-7 items-center justify-center rounded-sm transition-[color,opacity,transform] duration-150 hover:opacity-100 active:scale-90 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current motion-reduce:transform-none motion-reduce:transition-none",
						pageBookmarked
							? pdfDark
								? "text-[#ef8791]"
								: "text-[#bd4554]"
							: pdfDark
								? "text-white/50 hover:text-[#ef8791]"
								: "text-black/35 hover:text-[#bd4554]",
						pageBookmarked
							? "opacity-100"
							: pageHovered
								? "opacity-70"
								: "opacity-0 [@media(hover:none)]:opacity-60",
					)}
					disabled={bookmarkSaving}
					aria-busy={bookmarkSaving}
					aria-pressed={pageBookmarked}
					aria-label={t(
						pageBookmarked
							? "pdf.bookmarks.removePage"
							: "pdf.bookmarks.addPage",
						{ page: pageIndex + 1 },
					)}
					title={t(
						pageBookmarked
							? "pdf.bookmarks.removePage"
							: "pdf.bookmarks.addPage",
						{ page: pageIndex + 1 },
					)}
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						onBookmarkPage(pageIndex);
					}}
				>
					<Bookmark
						className="size-4"
						strokeWidth={1.75}
						fill={pageBookmarked ? "currentColor" : "none"}
					/>
				</button>
			)}
			{paperRaster}
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
				<UnrotatedPageFrame
					rotation={pageRotation}
					widthPx={frameWidth}
					heightPx={frameHeight}
					className="z-[5]"
				>
					{/* Unmount text selection while framing a visual region. */}
					{mode.regionSelecting ? null : (
						<PdfTextSelectionLayer
							documentId={docId}
							pageIndex={pageIndex}
							background={PDF_TEXT_SELECTION_BACKGROUND}
							armed={selectionArmed}
							insertionRegions={layout.selectionInsertionRegions}
							selectionStartPageIndex={layout.selectionStartPageIndex}
							excludedTextRects={layout.selectionTextExclusionsByPage?.get(
								pageIndex,
							)}
							draftPages={
								marks.selectionCommentDraft?.visiblePages?.length
									? undefined
									: marks.selectionCommentDraft?.pages
							}
						/>
					)}
					{/*
					 * AnnotationLayer is not inverted with the page rasters. In PDF dark
					 * mode its bright highlight colors look glaring on dark paper, so
					 * dim/saturation-reduce the whole layer slightly. Links keep only
					 * their border appearance; CitationLinkLayer owns navigation.
					 * The frame maps these unrotated point rects onto a /Rotate page
					 * the same way tiles do, so zoom does not walk the highlight off
					 * the glyphs.
					 */}
					{!mode.plainViewer ? (
						<div
							className={cn(
								// Above translation paper (z-3), under glyphs (z-6), same
								// slot as the selection tint. The highlight menu lifts the
								// layer so it stays clickable over the glyphs.
								// Empty areas pass through to citation hits (z-2). Annotation
								// controls opt back into pointers on their own elements.
								"pointer-events-none absolute inset-0 z-[5] has-[[data-pdf-chrome]]:z-[7]",
								pdfDark && PDF_ANNOTATION_DARK_CLASS,
							)}
						>
							<AnnotationLayer
								documentId={docId}
								pageIndex={pageIndex}
								annotationRenderers={annotationRenderers}
								selectionMenu={(menuProps) => (
									<HighlightAnnotationMenu
										{...menuProps}
										docId={docId}
										onEdit={handlers.onEditHighlightAnnotation}
										onDelete={handlers.onDeleteHighlightAnnotation}
										onChangeColor={handlers.onChangeHighlightColor}
									/>
								)}
							/>
						</div>
					) : null}
				</UnrotatedPageFrame>
				{!mode.plainViewer && pageHovered ? (
					<PageTranslateTab
						pageIndex={pageIndex}
						active={pageTranslateState.active}
						running={pageTranslateState.running}
						zoom={cardScale}
						onToggle={handlers.onTogglePageLayoutTranslate}
					/>
				) : null}
				<CitationLinkLayer
					links={marks.citationLinks.get(pageIndex) ?? EMPTY_CITATION_LINKS}
					textLinks={marks.textLinks.get(pageIndex) ?? []}
					pageWidthPt={width / zoomRef.current}
					pageHeightPt={height / zoomRef.current}
					label={t("pdf.linkAria")}
					onActivate={handlers.onCitationActivate}
					onTextActivate={handlers.onTextLinkActivate}
					onHover={handlers.onCitationHover}
					onUrlHover={handlers.onLinkUrlHover}
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
									className={cn(
										"pointer-events-none absolute z-[1] rounded-none border",
									)}
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
										className="absolute top-0 left-0 max-w-full truncate rounded-br-sm px-1 py-px font-medium text-caption text-white leading-4"
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
				{/*
				 * Bulk layout translate. Paper is z-3 (under the selection tint,
				 * z-5); glyphs are z-6 so the tint cannot wash them out.
				 */}
				{translateOverlay}
				<TranslationLiveSelection documentId={docId} pageIndex={pageIndex} />
				{translationVisible ? (
					<TranslatedHighlightLayer paints={translatedPaints} />
				) : null}
				<TranslationSelectionVeil
					pages={marks.selectionCommentDraft?.visiblePages}
					pageIndex={pageIndex}
				/>
				{/*
				 * Selection-translate spans stay tinted after the result card
				 * closes, above the opaque translation paper (z-3) and under
				 * the glyphs (z-6).
				 */}
				{translateHighlightsOnPage.map((item) =>
					item.id === activeTranslateOnPage?.id
						? null
						: item.rects.map((rect) => (
								<div
									key={`tr-hl-${item.id}-${rect.x}-${rect.y}-${rect.w}-${rect.h}`}
									className="pointer-events-none absolute z-[4] rounded-[2px] bg-yellow-300/40 dark:bg-yellow-400/35"
									style={{
										left: `${rect.x * 100}%`,
										top: `${rect.y * 100}%`,
										width: `${rect.w * 100}%`,
										height: `${rect.h * 100}%`,
									}}
									aria-hidden="true"
								/>
							)),
				)}
				{/*
				 * Hit targets for post-merge figure/table/algorithm/formula.
				 * Largest first so smaller boxes stack on top and win pointer hits.
				 * Hidden when framing or a visual draft is open (not during crop:
				 * unmount leave must not cancel an in-flight crop).
				 * All kinds crop on click; hover and keyboard focus preview the
				 * exact bbox that would be cropped.
				 */}
				{!mode.regionSelecting && !mode.visualDraftOpen && !mode.plainViewer
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
									className={cn(
										"group absolute z-[2] cursor-crosshair rounded-none border-0 bg-transparent p-0 transition-colors hover:bg-default-primary/5",
									)}
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
										className={cn(
											PDF_VISUAL_REGION_FRAME_CLASS,
											"inset-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
										)}
										aria-hidden="true"
									/>
									{showHint ? (
										<span
											className="pointer-events-none absolute top-1 right-1 max-w-[calc(100%-0.5rem)] truncate rounded border border-border/60 bg-background/90 px-1.5 py-0.5 font-medium text-caption text-foreground/90 opacity-0 shadow-raised backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
											aria-hidden="true"
										>
											{t("figures.clickAnnotateHint")}
										</span>
									) : null}
								</button>
							);
						})
					: null}
				{/*
				 * Quick-chat selections stay painted after the card closes, in the
				 * same yellow as saved annotations. The open card still bridges
				 * hover back to itself when the translation paper is not covering
				 * the page.
				 */}
				<AskHighlightLayer
					paints={askHighlights}
					activeId={activeAskOnPage?.id ?? null}
					bridgeHover={!translationVisible}
					onHoverEnter={handlers.onCardHoverEnter}
					onHoverLeave={handlers.onCardHoverLeave}
				/>
				{activeTranslateOnPage
					? activeTranslateOnPage.rects.map((rect) => (
							<div
								key={`${activeTranslateOnPage.id}-source-${rect.x}-${rect.y}-${rect.w}-${rect.h}`}
								className={cn(
									"pointer-events-auto absolute z-[4] rounded-[2px] bg-yellow-300/40 dark:bg-yellow-400/35",
								)}
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
						className={cn(PDF_VISUAL_REGION_FRAME_CLASS, "z-[2]")}
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
						className={cn(
							PDF_VISUAL_REGION_FRAME_CLASS,
							"z-[3] flex items-center justify-center",
						)}
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
							className="size-4 animate-spin text-default-primary"
							aria-hidden="true"
						/>
					</div>
				) : null}
				{/* Figures selection outline, or citation yellow flash block. */}
				{persistentRegion ? (
					<div
						data-pdf-embed-target={persistentRegion.id}
						className="pointer-events-none absolute z-[6] rounded-sm border border-amber-400/45 bg-amber-300/20 dark:bg-amber-300/15"
						style={{
							left: `${persistentRegion.bbox.x * 100}%`,
							top: `${persistentRegion.bbox.y * 100}%`,
							width: `${persistentRegion.bbox.w * 100}%`,
							height: `${persistentRegion.bbox.h * 100}%`,
						}}
						aria-hidden="true"
					/>
				) : null}
				{focusedLayoutOnPage ? (
					<div
						key={`${focusedLayoutOnPage.id}:${focusedLayoutOnPage.pageIndex}:${focusedLayoutOnPage.bbox.y}:${marks.focusedLayoutFlashToken}`}
						className={cn(
							"pointer-events-none absolute rounded-sm border",
							marks.focusedLayoutFlash
								? "citation-focus-flash z-[6] border-amber-400/90 bg-amber-300/55 shadow-[0_0_0_1px_rgba(251,191,36,0.55)] dark:bg-amber-300/40"
								: "z-[2] shadow-[0_0_0_1px_rgba(255,255,255,0.55)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.5)]",
						)}
						style={
							marks.focusedLayoutFlash
								? {
										left: `${focusedLayoutOnPage.bbox.x * 100}%`,
										top: `${focusedLayoutOnPage.bbox.y * 100}%`,
										width: `${focusedLayoutOnPage.bbox.w * 100}%`,
										height: `${focusedLayoutOnPage.bbox.h * 100}%`,
									}
								: {
										left: `${focusedLayoutOnPage.bbox.x * 100}%`,
										top: `${focusedLayoutOnPage.bbox.y * 100}%`,
										width: `${focusedLayoutOnPage.bbox.w * 100}%`,
										height: `${focusedLayoutOnPage.bbox.h * 100}%`,
										borderColor: layoutKindHex(focusedLayoutOnPage.kind),
										backgroundColor: layoutKindFill(focusedLayoutOnPage.kind),
										outline: `1px solid ${layoutKindBorder(focusedLayoutOnPage.kind)}`,
									}
						}
						aria-hidden="true"
					/>
				) : null}
				{/* Active visual mark: default-theme outline of the crop region. */}
				{activeVisualOnPage
					? activeVisualOnPage.rects.map((rect) => (
							<div
								key={`${activeVisualOnPage.id}-region-${rect.x}-${rect.y}-${rect.w}-${rect.h}`}
								className={cn(PDF_VISUAL_REGION_FRAME_CLASS, "z-[2]")}
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
				{!mode.plainViewer ? (
					<SelectionGutter
						items={shownPins}
						activeId={marks.activeCardId}
						onOpen={handlers.onOpenPin}
						onEnter={handlers.onCardHoverEnter}
						onLeave={handlers.onCardHoverLeave}
					/>
				) : null}
				{/*
				 * Emphasis overlay for the hovered or edited comment-rail card.
				 * Visual notes reuse the shared region frame so the rail card,
				 * the marquee draft and the click-crop all read as one UI; skip
				 * it while the open trace already frames the same rects below.
				 */}
				{/*
				 * Text-highlight emphasis uses unrotated page fractions, same
				 * space as the annotation layer. Visual crops stay in the
				 * pointer provider (display fractions of that box).
				 */}
				{emphasizedComment && emphasizedComment.kind !== "visual" ? (
					<UnrotatedPageFrame
						rotation={pageRotation}
						widthPx={frameWidth}
						heightPx={frameHeight}
						className="z-[4]"
					>
						{emphasizedComment.rects.map((rect) => (
							<div
								key={`comment-hover-${emphasizedComment.id}-${rect.x}-${rect.y}-${rect.w}-${rect.h}`}
								className="pointer-events-none absolute z-[4] rounded-[1px] mix-blend-multiply"
								style={{
									left: `${rect.x * 100}%`,
									top: `${rect.y * 100}%`,
									width: `${rect.w * 100}%`,
									height: `${rect.h * 100}%`,
									backgroundColor: highlightHoverOverlayColor(
										emphasizedComment.color,
									),
								}}
								aria-hidden="true"
							/>
						))}
					</UnrotatedPageFrame>
				) : null}
				{emphasizedComment &&
				emphasizedComment.kind === "visual" &&
				!activeVisualOnPage
					? emphasizedComment.rects.map((rect) => (
							<div
								key={`comment-hover-${emphasizedComment.id}-${rect.x}-${rect.y}-${rect.w}-${rect.h}`}
								className={cn(
									"pointer-events-none absolute z-[4]",
									PDF_VISUAL_REGION_FRAME_CLASS,
								)}
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
				{/*
				 * Bidirectional hover for rail comments: hovering the page region
				 * (text highlight or visual crop) emphasizes the card and draws the
				 * connector. Visual regions keep the existing click-to-edit path (#396);
				 * text highlights with a note do the same, while plain highlights
				 * (not in `comments`) still use EmbedPDF's annotation menu.
				 */}
				{shownComments.map((comment) =>
					comment.rects.map((rect) =>
						comment.kind === "visual" ? (
							<button
								key={`comment-hover-hit-${comment.id}-${rect.x}-${rect.y}-${rect.w}-${rect.h}`}
								type="button"
								className={cn("absolute z-[3] cursor-pointer bg-transparent")}
								style={{
									left: `${rect.x * 100}%`,
									top: `${rect.y * 100}%`,
									width: `${rect.w * 100}%`,
									height: `${rect.h * 100}%`,
								}}
								aria-label={t("pdfExplain.visualAnnotation")}
								onMouseEnter={() => handlers.onHoverComment(comment)}
								onMouseLeave={handlers.onLeaveComment}
								onClick={(event) => {
									event.stopPropagation();
									handlers.onOpenComment(comment);
								}}
							/>
						) : null,
					),
				)}
				{!mode.plainViewer ? (
					<CommentCardsLayer
						items={shownComments}
						inset={mode.insetCommentCards}
						pageWidthPx={width}
						pageHeightPx={height}
						editingId={marks.editingCommentId}
						wikiTarget={marks.commentWikiTarget}
						hoveredId={hoveredCommentId}
						selectionDraft={selectionDraftOnPage}
						onCommitSelectionComment={handlers.onCommitSelectionComment}
						onSelectionCommentActiveChange={
							handlers.onSelectionCommentActiveChange
						}
						onDismissSelectionComment={handlers.onDismissSelectionComment}
						onOpen={handlers.onOpenComment}
						onSave={handlers.onSaveComment}
						onCancel={handlers.onCancelComment}
						onDelete={handlers.onDeleteComment}
						onCopyLink={handlers.onCopyCommentLink}
						onCopyEmbed={handlers.onCopyCommentEmbed}
						onAddToChat={handlers.onAddCommentToChat}
						onHover={handlers.onHoverComment}
						onLeave={handlers.onLeaveComment}
					/>
				) : null}
			</PagePointerProvider>
		</div>
	);
});
