import { createPluginRegistration } from "@embedpdf/core";
import { EmbedPDF } from "@embedpdf/core/react";
import type {
	PdfBookmarkObject,
	PdfHighlightAnnoObject,
	PdfLinkAnnoObject,
} from "@embedpdf/models";
import { PdfAnnotationSubtype } from "@embedpdf/models";
import { AiManagerPluginPackage } from "@embedpdf/plugin-ai-manager/react";
import {
	AnnotationLayer,
	AnnotationPluginPackage,
	type AnnotationTransferItem,
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
	PagePointerProvider,
	useInteractionManagerCapability,
} from "@embedpdf/plugin-interaction-manager/react";
import {
	LayoutAnalysisLayer,
	LayoutAnalysisPluginPackage,
	useLayoutAnalysis,
	useLayoutAnalysisCapability,
} from "@embedpdf/plugin-layout-analysis/react";
import {
	RenderLayer,
	RenderPluginPackage,
} from "@embedpdf/plugin-render/react";
import {
	Scroller,
	ScrollPluginPackage,
	useScroll,
} from "@embedpdf/plugin-scroll/react";
import {
	SearchLayer,
	SearchPluginPackage,
	useSearch,
} from "@embedpdf/plugin-search/react";
import {
	type FormattedSelection,
	SelectionLayer,
	SelectionPluginPackage,
	useSelectionCapability,
} from "@embedpdf/plugin-selection/react";
import {
	TilingLayer,
	TilingPluginPackage,
} from "@embedpdf/plugin-tiling/react";
import {
	useIsViewportGated,
	useViewportCapability,
	useViewportElement,
	useViewportPlugin,
	ViewportElementContext,
	ViewportPluginPackage,
} from "@embedpdf/plugin-viewport/react";
import {
	useZoom,
	ZoomGestureWrapper,
	ZoomMode,
	ZoomPluginPackage,
} from "@embedpdf/plugin-zoom/react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
	ChevronDown,
	ChevronUp,
	Languages,
	List,
	Loader2,
	MessageSquareText,
	Minus,
	Moon,
	MoveVertical,
	Plus,
	RotateCcw,
	ScanSearch,
	Search,
	Sun,
	X,
} from "lucide-react";
import {
	type HTMLAttributes,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	CitationLinkLayer,
	isLinkObject,
	useLinkTextResolver,
} from "@/components/viewer/embed/citation-links";
import { usePdfEngineContext } from "@/components/viewer/embed/engine-provider";
import {
	EMBED_PAGE_ATTR,
	pageElByIndex,
	rectRightScreen,
	rectTopCenterScreen,
} from "@/components/viewer/embed/geometry";
import { LayoutTranslateOverlay } from "@/components/viewer/embed/layout-translate-overlay";
import { renderPdfRegionPromptImage } from "@/components/viewer/embed/pdf-region-crop";
import { PdfRegionSelectLayer } from "@/components/viewer/embed/pdf-region-select-layer";
import { anchorFromEmbedSelection } from "@/components/viewer/embed/selection-anchor";
import { AnnotationEditor } from "@/components/viewer/pdf-ask/annotation-editor";
import { AskPopover } from "@/components/viewer/pdf-ask/ask-popover";
import { FormulaAnnotationCard } from "@/components/viewer/pdf-ask/formula-annotation-card";
import { SelectionGutter } from "@/components/viewer/pdf-ask/selection-gutter";
import { SelectionMenu } from "@/components/viewer/pdf-ask/selection-menu";
import { TranslateCard } from "@/components/viewer/pdf-ask/translate-card";
import { VisualAnnotationEditor } from "@/components/viewer/pdf-ask/visual-annotation-editor";
import { VisualTraceCard } from "@/components/viewer/pdf-ask/visual-trace-card";
import { PdfCitationPreview } from "@/components/viewer/pdf-citation-preview";
import i18n from "@/i18n";
import {
	cancelAgentRun,
	listAgents,
	listenAgentCompleted,
	listenAgentFailed,
	listenAgentStream,
	type PromptImage,
	runOnce,
} from "@/lib/agent";
import { agentSessionStore } from "@/lib/agent/agent-session-store";
import {
	clearActiveSelection,
	pinActiveSelection,
	publishSelection,
} from "@/lib/agent/selection-store";
import { addVisualDraft } from "@/lib/agent/visual-context-store";
import {
	BackgroundTaskCancelledError,
	enqueueBackgroundTask,
	isBackgroundTaskCancelledError,
} from "@/lib/core/background-tasks";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import { isPdfViewerSource } from "@/lib/paper";
import {
	type Citation,
	looksLikeCitationMarker,
	matchCitationByMarker,
	paperRefsList,
} from "@/lib/paper/refs";
import {
	createNoteTrace,
	createRunningTraces,
	deletePdfVisualTrace,
	isVisualMarkKind,
	listPdfVisualTraces,
	newTraceMessageId,
	type PdfVisualSessionTrace,
	traceMessages,
	tracePreview,
	writePdfVisualTrace,
} from "@/lib/pdf/agent-trace";
import { loadPdfVisualTraceImage } from "@/lib/pdf/agent-trace/image";
import {
	createEmptyThread,
	deletePdfAskThread,
	listPdfAskThreads,
	newMessageId,
	popoverScreenPoint,
	toSummaries,
	writePdfAskThread,
} from "@/lib/pdf/ask";
import { buildPdfAskPrompt } from "@/lib/pdf/ask/prompt";
import { threadHasUserQuestion } from "@/lib/pdf/ask/schema";
import type {
	PdfAskAnchor,
	PdfAskNormalizedRect,
	PdfAskThread,
} from "@/lib/pdf/ask/types";
import { bookmarkPageIndex } from "@/lib/pdf/bookmark";
import {
	clearCitationHover,
	setCitationHover,
} from "@/lib/pdf/citation-hover-store";
import { createPdfViewportResizeGate } from "@/lib/pdf/dockview-resize";
import {
	type EquationSymbol,
	equationAnnotationPath,
	loadEquationAnnotation,
} from "@/lib/pdf/equation-annotation";
import {
	hasAnnotationsFile,
	highlightViewFromObject,
	isHighlightObject,
	loadAnnotationItems,
	saveAnnotationItems,
} from "@/lib/pdf/highlight/annotation-store";
import { migrateHighlightMarks } from "@/lib/pdf/highlight/migrate-marks";
import {
	DEFAULT_HIGHLIGHT_COLOR,
	HIGHLIGHT_HEX,
	HIGHLIGHT_HEX_LIST,
	HIGHLIGHT_OPACITY,
	type HighlightColor,
} from "@/lib/pdf/highlight/palette";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";
import {
	enqueuePaperLayoutAnalysis,
	getLayoutDocumentResult,
	getPdfAiRuntime,
	hoverableLayoutRegionsOnPage,
	isFormulaLayoutKind,
	LAYOUT_FORMULA_HOVER_DWELL_MS,
	LAYOUT_FORMULA_HOVER_HIDE_MS,
	LAYOUT_HOVER_DWELL_MS,
	LAYOUT_HOVER_HIDE_MS,
	type LayoutTranslateItem,
	type LayoutTranslateJobStatus,
	layoutAnalysisStore,
	layoutKindBorder,
	layoutKindFill,
	layoutKindHex,
	layoutKindI18nKey,
	listTranslatableLayoutRegions,
	type PdfLayoutRegion,
	rawLayoutRegionsOnPage,
	readLayoutSidecar,
	runDocumentLayoutAnalysis,
	runLayoutRegionTranslate,
	setFocusedLayoutRegion,
	setLayoutOverlayVisible,
	toLayoutTranslateItems,
} from "@/lib/pdf/layout";
import { setPaperOutline } from "@/lib/pdf/outline-location";
import { PDF_PAGE_RASTER_DARK_CLASS } from "@/lib/pdf/page-theme";
import { readReadingPage, writeReadingPage } from "@/lib/pdf/reading-position";
import {
	type ActiveSelectionCard,
	type NormalizedRect,
	normalizePageTextRects,
	pinFromRects,
	pinObscuresBodyText,
	type SelectionPin,
} from "@/lib/pdf/selection";
import {
	createTranslateRecord,
	deletePdfTranslate,
	listPdfTranslates,
	writePdfTranslate,
} from "@/lib/pdf/translate";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";
import { createWheelZoomCoalescer } from "@/lib/pdf/wheel-zoom";
import {
	formatPdfZoomPercentage,
	PDF_ZOOM_MAX,
	PDF_ZOOM_MIN,
	parsePdfZoomPercentage,
} from "@/lib/pdf/zoom";
import { loadSettings } from "@/lib/settings";
import { formatShortcutById } from "@/lib/shell/shortcuts";
import {
	openRightTab,
	requestOpenAgentSession,
	setAgentPanelMounted,
} from "@/lib/shell/ui-store";
import {
	buildTranslatePrompt,
	prepareTranslateTask,
	resolveTranslateAgent,
	runTranslate,
} from "@/lib/translate";
import {
	VAULT_FILE_CHANGED_EVENT,
	type VaultFileChangedPayload,
} from "@/lib/vault/fs-watch";
import { normalizePathKey } from "@/lib/vault/path";
import { openPath } from "@/lib/workspace/actions";
import { isDockviewSashTarget } from "@/lib/workspace/dockview-sash";

type PdfColorScheme = "light" | "dark";

const PDF_COLOR_SCHEME_STORAGE_KEY = "agentero-pdf-color-scheme";
const PDF_COLOR_SCHEME_EVENT = "agentero:pdf-color-scheme";

function getDocumentColorScheme(): PdfColorScheme {
	if (typeof document === "undefined") return "light";
	return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function readPdfColorScheme(): PdfColorScheme {
	const stored = readJsonStorage<PdfColorScheme | null>(
		PDF_COLOR_SCHEME_STORAGE_KEY,
		null,
	);
	return stored === "light" || stored === "dark"
		? stored
		: getDocumentColorScheme();
}

function writePdfColorScheme(next: PdfColorScheme): void {
	writeJsonStorage(PDF_COLOR_SCHEME_STORAGE_KEY, next);
	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent<PdfColorScheme>(PDF_COLOR_SCHEME_EVENT, {
				detail: next,
			}),
		);
	}
}

function isPdfDocumentCloseRaceError(error: unknown): boolean {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: error && typeof error === "object" && "message" in error
					? String((error as { message?: unknown }).message)
					: "";
	return /document does not open/i.test(message);
}

export type PdfViewerHandle = {
	getHighlights: () => PdfHighlight[];
	scrollToHighlight: (id: string) => void;
	editComment: (id: string) => void;
	deleteHighlight: (id: string) => void;
	/** Jump to an ask pin and reopen its conversation card. */
	scrollToAsk: (id: string) => void;
	deleteAsk: (id: string) => void;
	/** Jump to a visual agent-trace pin and open its preview card. */
	scrollToVisualTrace: (id: string) => void;
	deleteVisualTrace: (id: string) => void;
	/** Toggle visual-region annotation mode (⌘.). */
	toggleVisualAnnotation: () => void;
	/** Run EmbedPDF layout analysis for figures / tables / formulas. */
	analyzeLayout: () => void;
	/** Jump to a layout region (0-based page) and focus its overlay. */
	scrollToLayoutRegion: (region: {
		id: string;
		pageIndex: number;
		bbox: PdfAskNormalizedRect;
	}) => void;
	/** Crop a normalized page region (for figure sidebar thumbnails). */
	renderRegion: (args: {
		pageIndex: number;
		bbox: PdfAskNormalizedRect;
		maxEdgePx?: number;
	}) => Promise<PromptImage | null>;
};

export type PdfViewerProps = {
	/**
	 * PDF source: local `blob:` (bytes via fs) or remote https. Prefer local
	 * vault PDF; remote URL is fallback when download fails.
	 */
	source: string | null;
	/**
	 * Local PDF bytes. Preferred over `source`: the engine opens the document
	 * straight from the buffer, avoiding a `fetch(blob:)` that stalls/fails in
	 * some webviews (Windows WebView2). `source` is the fallback (remote https).
	 */
	sourceBytes?: ArrayBuffer | null;
	/** Stable per-tab document id (EmbedPDF documentId + scope key). */
	docId?: string | null;
	/** Absolute path to paper folder for annotations/marks persistence */
	paperAbsPath?: string | null;
	/** Vault-relative paper path stored inside JSON */
	paperRelPath?: string | null;
	/** Current vault root for ACP cwd */
	vaultPath?: string | null;
	/** Open the annotations overview (App-level right sidebar tab). */
	onOpenAnnotations?: () => void;
	/** Open Translate settings from a translation error card. */
	onOpenSettings?: () => void;
	className?: string;
	/** Register/unregister an imperative handle for the annotations panel */
	onHandle?: (handle: PdfViewerHandle | null) => void;
	/** Called whenever the highlight list changes (for the annotations panel) */
	onHighlightsChange?: (highlights: PdfHighlight[]) => void;
	/** Called whenever PDF ask threads change (for the annotations panel) */
	onAsksChange?: (threads: PdfAskThread[]) => void;
	/** Called whenever visual agent-trace marks change (for the annotations panel) */
	onVisualTracesChange?: (traces: PdfVisualSessionTrace[]) => void;
	/**
	 * Workspace active tab. Dock may keep inactive PDFs mounted (`pdfKeepMounted`);
	 * only the active viewer should poll marks/ (expensive base64 JSON list).
	 */
	isActive?: boolean;
};

/** Recursive outline (bookmarks) list for the PDF side panel. */
function OutlineTree({
	nodes,
	depth,
	onGoToPage,
}: {
	nodes: PdfBookmarkObject[];
	depth: number;
	onGoToPage: (page: number) => void;
}) {
	return (
		<ul className="space-y-0.5">
			{nodes.map((n) => (
				<li key={`${depth}-${n.title}-${JSON.stringify(n.target ?? null)}`}>
					<button
						type="button"
						className="w-full truncate rounded px-2 py-1 text-left text-muted-foreground text-xs hover:bg-muted/60 hover:text-foreground"
						style={{ paddingLeft: 8 + depth * 12 }}
						title={n.title}
						onClick={() => {
							const pageIndex = bookmarkPageIndex(n);
							if (pageIndex != null) {
								onGoToPage(pageIndex + 1);
							}
						}}
					>
						{n.title}
					</button>
					{n.children?.length ? (
						<OutlineTree
							nodes={n.children}
							depth={depth + 1}
							onGoToPage={onGoToPage}
						/>
					) : null}
				</li>
			))}
		</ul>
	);
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
			createPluginRegistration(ScrollPluginPackage),
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

type PdfViewerInnerProps = PdfViewerProps & { docId: string };

/**
 * Full devicePixelRatio rasters on high-DPI screens make every zoom step
 * expensive (PDFium renders in a single worker shared by all pages). Cap the
 * raster dpr: pages stay sharp enough for reading while each re-render costs
 * far less WASM work.
 */
const PDF_RASTER_DPR_CAP = 1.5;

function pdfRasterDpr(): number {
	const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
	return Math.min(dpr, PDF_RASTER_DPR_CAP);
}

/**
 * RenderLayer is only the base coat under the sharp TilingLayer — cap its
 * scale so zooming past this never re-rasterizes whole pages (the single
 * worker serializes renders; on long documents full-page rasters at high
 * zoom plus their blob transfers dominate). Tiles keep the viewport sharp.
 */
const PDF_BASE_LAYER_SCALE_CAP = 1.5;

/**
 * Native viewport scroll → re-place floating selection cards.
 * Must render inside DockviewViewport (ViewportElementContext).
 */
function ActiveCardScrollSync({
	active,
	onScroll,
}: {
	active: boolean;
	onScroll: () => void;
}) {
	const viewportRef = useViewportElement();
	const onScrollRef = useRef(onScroll);
	onScrollRef.current = onScroll;
	useEffect(() => {
		if (!active) return;
		const el = viewportRef?.current;
		if (!el) return;
		let raf: number | null = null;
		const handle = () => {
			if (raf != null) return;
			raf = requestAnimationFrame(() => {
				raf = null;
				onScrollRef.current();
			});
		};
		el.addEventListener("scroll", handle, { passive: true });
		return () => {
			if (raf != null) cancelAnimationFrame(raf);
			el.removeEventListener("scroll", handle);
		};
	}, [active, viewportRef]);
	return null;
}

/**
 * Custom Ctrl/Cmd+wheel zoom handler.
 *
 * EmbedPDF's ZoomGestureWrapper multiplies the current scale by a factor
 * derived from `deltaY`, which makes a single mouse-wheel tick double or
 * halve the zoom. We disable that built-in behavior and instead step the zoom
 * with the same fixed increments used by the toolbar +/- buttons.
 *
 * Steps are coalesced per animation frame (createWheelZoomCoalescer): a
 * trackpad pinch fires many wheel events per second, and each applied step
 * re-rasterizes all visible pages on the main thread — batching keeps that to
 * once per frame.
 */
function WheelZoomHandler({ docId }: { docId: string }) {
	const viewportRef = useViewportElement();
	const { provides: zoom } = useZoom(docId);
	const zoomRef = useRef(zoom);
	zoomRef.current = zoom;

	useEffect(() => {
		const container = viewportRef?.current;
		if (!container) return;

		const coalescer = createWheelZoomCoalescer({
			onZoomIn: () => zoomRef.current?.zoomIn(),
			onZoomOut: () => zoomRef.current?.zoomOut(),
		});

		let resetTimeout: ReturnType<typeof setTimeout> | null = null;
		const scheduleReset = () => {
			if (resetTimeout) clearTimeout(resetTimeout);
			resetTimeout = setTimeout(() => {
				resetTimeout = null;
				coalescer.reset();
			}, 150);
		};

		const handleWheel = (e: WheelEvent) => {
			if (!e.ctrlKey && !e.metaKey) return;
			e.preventDefault();

			if (!zoomRef.current) return;

			coalescer.addDelta(e.deltaY);
			scheduleReset();
		};

		container.addEventListener("wheel", handleWheel, { passive: false });
		return () => {
			container.removeEventListener("wheel", handleWheel);
			if (resetTimeout) clearTimeout(resetTimeout);
			coalescer.dispose();
		};
	}, [viewportRef]);

	return null;
}

/**
 * Dockview updates panel geometry on every sash pointermove. EmbedPDF's
 * ResizeObserver otherwise turns each of those moves into viewport + scroll
 * state updates. Keep the DOM viewport following the panel while resize
 * metrics are gated; releasing the sash lets EmbedPDF observe the final size
 * once.
 */
type DockviewViewportProps = HTMLAttributes<HTMLDivElement> & {
	children: ReactNode;
	documentId: string;
	hostRef: RefObject<HTMLDivElement | null>;
};

function DockviewViewport({
	children,
	documentId,
	hostRef,
	...props
}: DockviewViewportProps) {
	const [viewportGap, setViewportGap] = useState(0);
	const viewportRef = useRef<HTMLDivElement>(null);
	const { plugin: viewportPlugin } = useViewportPlugin();
	const { provides: viewportCapability } = useViewportCapability();
	const isGated = useIsViewportGated(documentId);

	useEffect(() => {
		if (viewportCapability) {
			setViewportGap(viewportCapability.getViewportGap());
		}
	}, [viewportCapability]);

	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		if (!viewportPlugin || !viewport) return;

		try {
			viewportPlugin.registerViewport(documentId);
		} catch {
			return;
		}

		const ownerDocument = viewport.ownerDocument;
		const ownerWindow = ownerDocument.defaultView;
		const workspace = hostRef.current?.closest(".agentero-dockview") ?? null;
		const requestFrame = (callback: FrameRequestCallback) =>
			ownerWindow
				? ownerWindow.requestAnimationFrame(callback)
				: requestAnimationFrame(callback);
		const cancelFrame = (handle: number) => {
			if (ownerWindow) ownerWindow.cancelAnimationFrame(handle);
			else cancelAnimationFrame(handle);
		};
		const commitResize = () => {
			viewportPlugin.setViewportResizeMetrics(documentId, {
				width: viewport.offsetWidth,
				height: viewport.offsetHeight,
				clientWidth: viewport.clientWidth,
				clientHeight: viewport.clientHeight,
				scrollTop: viewport.scrollTop,
				scrollLeft: viewport.scrollLeft,
				scrollWidth: viewport.scrollWidth,
				scrollHeight: viewport.scrollHeight,
				clientLeft: viewport.clientLeft,
				clientTop: viewport.clientTop,
			});
		};
		const resizeGate = createPdfViewportResizeGate({
			commitResize,
			requestFrame,
			cancelFrame,
		});
		let dockResizeActive = false;

		const removeEndListeners = () => {
			ownerDocument.removeEventListener("pointerup", finishResize, true);
			ownerDocument.removeEventListener("pointercancel", finishResize, true);
			ownerDocument.removeEventListener("contextmenu", finishResize, true);
			ownerWindow?.removeEventListener("blur", finishResize);
		};

		const finishResize = () => {
			if (!dockResizeActive) return;
			dockResizeActive = false;
			removeEndListeners();
			resizeGate.endDockResize();
		};

		const handlePointerDown = (event: PointerEvent) => {
			if (
				dockResizeActive ||
				!workspace ||
				!isDockviewSashTarget(event.target, workspace)
			) {
				return;
			}

			dockResizeActive = true;
			resizeGate.beginDockResize();
			ownerDocument.addEventListener("pointerup", finishResize, true);
			ownerDocument.addEventListener("pointercancel", finishResize, true);
			ownerDocument.addEventListener("contextmenu", finishResize, true);
			ownerWindow?.addEventListener("blur", finishResize);
		};

		const handleScroll = () => {
			viewportPlugin.setViewportScrollMetrics(documentId, {
				scrollTop: viewport.scrollTop,
				scrollLeft: viewport.scrollLeft,
			});
		};
		viewport.addEventListener("scroll", handleScroll);

		const ResizeObserverCtor = ownerWindow?.ResizeObserver ?? ResizeObserver;
		const resizeObserver = new ResizeObserverCtor(() => {
			resizeGate.notifyResize();
		});
		resizeObserver.observe(viewport);

		const unsubscribeScrollRequest = viewportPlugin.onScrollRequest(
			documentId,
			({ x, y, behavior = "auto" }) => {
				requestFrame(() => {
					viewport.scrollTo({ left: x, top: y, behavior });
				});
			},
		);

		ownerDocument.addEventListener("pointerdown", handlePointerDown, true);
		return () => {
			ownerDocument.removeEventListener("pointerdown", handlePointerDown, true);
			removeEndListeners();
			dockResizeActive = false;
			resizeGate.dispose();
			resizeObserver.disconnect();
			viewport.removeEventListener("scroll", handleScroll);
			unsubscribeScrollRequest();
			viewportPlugin.unregisterViewport(documentId);
		};
	}, [documentId, hostRef, viewportPlugin]);

	const { style, ...restProps } = props;

	return (
		<ViewportElementContext.Provider
			value={viewportRef as RefObject<HTMLDivElement>}
		>
			<div
				{...restProps}
				ref={viewportRef}
				style={{
					width: "100%",
					height: "100%",
					overflow: "auto",
					...style,
					padding: `${viewportGap}px`,
				}}
			>
				{!isGated && children}
			</div>
		</ViewportElementContext.Provider>
	);
}

type SelectionMenuState = {
	screen: { x: number; y: number };
	anchor: PdfAskAnchor;
	pages: FormattedSelection[];
};

type CitationPreviewState = {
	screen: { x: number; y: number };
	marker: string;
	citation: Citation | null;
};

type EditorState = {
	screen: { x: number; y: number };
	pageIndex: number;
	id: string;
	quote: string;
	comment: string;
};

type VisualDraftEditorState = {
	screen: { x: number; y: number };
	page: number;
	region: PdfAskNormalizedRect;
	image: PromptImage;
	/**
	 * Opened by layout-region hover: auto-closes after leaving the region /
	 * draft card (grace period). Manual region-select drafts stay until dismiss.
	 */
	ephemeral?: boolean;
};

/** Hover card for formula regions when `{paper}/Annotation.md` has symbols. */
type FormulaAnnotationPreviewState = {
	screen: { x: number; y: number };
	regionId: string;
	page: number;
	region: PdfAskNormalizedRect;
	symbols: EquationSymbol[];
};

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
	/** Figures rail header toggles this; mirror into EmbedPDF plugin. */
	const layoutOverlayVisible = useStore(
		layoutAnalysisStore,
		(s) => s.overlayVisible[docId] ?? false,
	);

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
	const layoutTaskRef = useRef<Awaited<
		ReturnType<typeof runDocumentLayoutAnalysis>
	> | null>(null);

	const currentPage = scrollState.currentPage || 1;
	const totalPages = scrollState.totalPages || 0;
	const totalPagesRef = useRef(totalPages);
	totalPagesRef.current = totalPages;

	/** Sidebar-selected layout region → PDF focus outline. */
	const focusedLayoutRegion = useStore(layoutAnalysisStore, (s) => {
		if (s.focused?.documentId !== docId) return null;
		const result = s.byDocument[docId];
		if (!result || !s.focused) return null;
		return result.regions.find((r) => r.id === s.focused?.regionId) ?? null;
	});
	const zoomLevel = zoomState.currentZoomLevel || 1;

	const [pageField, setPageField] = useState("1");
	const [zoomField, setZoomField] = useState(() =>
		formatPdfZoomPercentage(zoomLevel),
	);
	const [highlights, setHighlights] = useState<PdfHighlight[]>([]);
	const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(
		null,
	);
	const [regionSelecting, setRegionSelecting] = useState(false);
	const [visualCropPending, setVisualCropPending] = useState(false);
	const [citations, setCitations] = useState<Citation[]>([]);
	const [citationPreview, setCitationPreview] =
		useState<CitationPreviewState | null>(null);
	const [editor, setEditor] = useState<EditorState | null>(null);
	const [visualDraftEditor, setVisualDraftEditor] =
		useState<VisualDraftEditorState | null>(null);
	/** Formula hover → Annotation.md symbol glossary (when present). */
	const [formulaAnnotationPreview, setFormulaAnnotationPreview] =
		useState<FormulaAnnotationPreviewState | null>(null);
	/** Parsed rows from `{paper}/Annotation.md` (empty when missing). */
	const [equationSymbols, setEquationSymbols] = useState<EquationSymbol[]>([]);

	/** Post-merge layout regions for hover hit targets (figures rail source). */
	const layoutDocRegions = useStore(
		layoutAnalysisStore,
		(s) => s.byDocument[docId]?.regions ?? null,
	);
	/** Pre-merge detections for the debug Eye overlay (all model boxes). */
	const layoutRawRegions = useStore(
		layoutAnalysisStore,
		(s) =>
			s.byDocument[docId]?.rawRegions ?? s.byDocument[docId]?.regions ?? null,
	);
	/** Progressive layout bulk-translate overlays (body text / abstract / header). */
	const [layoutTranslateJob, setLayoutTranslateJob] = useState<{
		status: LayoutTranslateJobStatus;
		items: LayoutTranslateItem[];
	}>({ status: "idle", items: [] });
	const layoutTranslateAbortRef = useRef<AbortController | null>(null);

	const [threads, setThreads] = useState<PdfAskThread[]>([]);
	const [translates, setTranslates] = useState<PdfTranslateRecord[]>([]);
	/**
	 * Per-page 0–1 text rects from PDFium `getPageTextRects` — used to decide
	 * whether a gutter pin sits on real glyphs (translucent) vs in a free gutter.
	 */
	const [pageTextMap, setPageTextMap] = useState(
		() => new Map<number, NormalizedRect[]>(),
	);
	const pageTextPendingRef = useRef(new Set<number>());
	const pageTextMapRef = useRef(pageTextMap);
	pageTextMapRef.current = pageTextMap;
	const [visualTraces, setVisualTraces] = useState<PdfVisualSessionTrace[]>([]);
	const [activeCard, setActiveCard] = useState<ActiveSelectionCard | null>(
		null,
	);
	const [cardScreen, setCardScreen] = useState<{
		x: number;
		y: number;
		preferRight?: boolean;
	} | null>(null);
	const [streaming, setStreaming] = useState(false);
	const [askError, setAskError] = useState<string | null>(null);
	const [visualStreaming, setVisualStreaming] = useState(false);
	const [visualError, setVisualError] = useState<string | null>(null);
	/** Keep the just-created Cmd+Enter card expanded until the user dismisses it. */
	const [visualCardExpanded, setVisualCardExpanded] = useState(false);
	const [translateStreaming, setTranslateStreaming] = useState(false);
	const [translateError, setTranslateError] = useState<string | null>(null);
	const translateStreamingRef = useRef(false);

	const [findOpen, setFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const [outline, setOutline] = useState<PdfBookmarkObject[]>([]);
	const [showOutline, setShowOutline] = useState(false);
	const [pdfColorScheme, setPdfColorScheme] =
		useState<PdfColorScheme>(readPdfColorScheme);
	const findInputRef = useRef<HTMLInputElement>(null);

	const pageFocusedRef = useRef(false);
	const restoredRef = useRef(false);
	const importedRef = useRef(false);
	const importingRef = useRef(false);
	const marksLoadedRef = useRef(false);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hostRef = useRef<HTMLDivElement>(null);
	const zoomRef = useRef(zoomLevel);
	zoomRef.current = zoomLevel;
	const zoomFieldFocusedRef = useRef(false);
	const zoomFieldCancelRef = useRef(false);
	const highlightsRef = useRef(highlights);
	highlightsRef.current = highlights;
	const threadsRef = useRef(threads);
	threadsRef.current = threads;
	const translatesRef = useRef(translates);
	translatesRef.current = translates;
	const visualTracesRef = useRef(visualTraces);
	visualTracesRef.current = visualTraces;
	const activeCardRef = useRef<ActiveSelectionCard | null>(null);
	activeCardRef.current = activeCard;
	const regionSelectingRef = useRef(regionSelecting);
	regionSelectingRef.current = regionSelecting;
	const visualCropPendingRef = useRef(visualCropPending);
	visualCropPendingRef.current = visualCropPending;
	const visualDraftEditorRef = useRef(visualDraftEditor);
	visualDraftEditorRef.current = visualDraftEditor;
	const formulaAnnotationPreviewRef = useRef(formulaAnnotationPreview);
	formulaAnnotationPreviewRef.current = formulaAnnotationPreview;
	const equationSymbolsRef = useRef(equationSymbols);
	equationSymbolsRef.current = equationSymbols;
	const selectionMenuRef = useRef(selectionMenu);
	selectionMenuRef.current = selectionMenu;
	/** Pending dwell timer for layout-region hover → visual editor. */
	const layoutHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const layoutHoverRegionIdRef = useRef<string | null>(null);
	/** Bumped to drop late crops after leave / supersede. */
	const layoutHoverSeqRef = useRef(0);
	/** Auto-hide timer for ephemeral layout-hover draft editors. */
	const layoutDraftHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	/** True while pointer is over the ephemeral source region or draft card. */
	const layoutDraftHoverSurfaceRef = useRef(false);
	/** Formula legend dwell (separate from visual-ask dwell). */
	const formulaHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const formulaHoverRegionIdRef = useRef<string | null>(null);
	/** Formula legend auto-hide after leave region / card. */
	const formulaHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	/** True while pointer is over the formula hit region or legend card. */
	const formulaHoverSurfaceRef = useRef(false);
	const activeSessionRef = useRef<string | null>(null);
	const visualSessionRef = useRef<string | null>(null);
	const translateSessionRef = useRef<string | null>(null);
	const hidePopoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	/** True while pointer is over the active card, pin, or source fragment. */
	const cardHoverSurfaceRef = useRef(false);
	const citationHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);

	/** Stable key for resume-reading (null for loose PDFs without a paper path). */
	const paperKey = paperRelPath || paperAbsPath || null;
	const pdfDark = pdfColorScheme === "dark";

	const togglePdfColorScheme = useCallback(() => {
		setPdfColorScheme((current) => {
			const next: PdfColorScheme = current === "dark" ? "light" : "dark";
			writePdfColorScheme(next);
			return next;
		});
	}, []);

	useEffect(() => {
		const onColorSchemeChange = (event: Event) => {
			const next = (event as CustomEvent<PdfColorScheme>).detail;
			if (next === "light" || next === "dark") setPdfColorScheme(next);
		};
		window.addEventListener(PDF_COLOR_SCHEME_EVENT, onColorSchemeChange);
		return () => {
			window.removeEventListener(PDF_COLOR_SCHEME_EVENT, onColorSchemeChange);
		};
	}, []);

	useEffect(() => {
		setCitations([]);
		setCitationPreview(null);
		setRegionSelecting(false);
		clearCitationHover(docId);
		if (!vaultPath || !paperRelPath) return;
		let cancelled = false;
		void paperRefsList(vaultPath, paperRelPath)
			.then((sidecar) => {
				if (!cancelled) setCitations(sidecar?.citations ?? []);
			})
			.catch(() => {
				if (!cancelled) setCitations([]);
			});
		return () => {
			cancelled = true;
		};
	}, [docId, vaultPath, paperRelPath]);

	useEffect(() => {
		if (!zoomFieldFocusedRef.current) {
			setZoomField(formatPdfZoomPercentage(zoomLevel));
		}
	}, [zoomLevel]);

	const commitZoomField = useCallback(
		(value: string) => {
			const requested = parsePdfZoomPercentage(value);
			if (requested == null) {
				setZoomField(formatPdfZoomPercentage(zoomLevel));
				return;
			}
			zoom?.requestZoom(requested);
			setZoomField(formatPdfZoomPercentage(requested));
		},
		[zoom, zoomLevel],
	);

	const askSummaries = useMemo(
		() => toSummaries(threads.filter(threadHasUserQuestion)),
		[threads],
	);

	// Load real page text geometry for pages that have pins (or near the viewport).
	useEffect(() => {
		if (!engine || !docCap || totalPages <= 0) return;
		const doc = docCap.getDocument(docId);
		if (!doc) return;

		const need = new Set<number>();
		const from = Math.max(0, currentPage - 2);
		const to = Math.min(totalPages, currentPage + 2);
		for (let i = from; i < to; i++) need.add(i);
		for (const tr of translates) {
			if (!tr.error) need.add(tr.page - 1);
		}
		for (const th of threads) {
			if (threadHasUserQuestion(th)) need.add(th.anchor.page - 1);
		}
		for (const h of highlights) {
			if (h.comment?.trim()) need.add(h.page - 1);
		}
		for (const v of visualTraces) need.add(v.page - 1);

		for (const pageIndex of need) {
			if (
				pageTextMapRef.current.has(pageIndex) ||
				pageTextPendingRef.current.has(pageIndex)
			) {
				continue;
			}
			const page = doc.pages[pageIndex];
			if (!page) continue;
			pageTextPendingRef.current.add(pageIndex);
			void engine
				.getPageTextRects(doc, page)
				.toPromise()
				.then((rects) => {
					const norm = normalizePageTextRects(rects, page.size);
					setPageTextMap((prev) => {
						if (prev.get(pageIndex) === norm) return prev;
						const next = new Map(prev);
						next.set(pageIndex, norm);
						return next;
					});
				})
				.catch(() => {
					// Leave unloaded; pins stay solid until text geometry is available.
				})
				.finally(() => {
					pageTextPendingRef.current.delete(pageIndex);
				});
		}
	}, [
		engine,
		docCap,
		docId,
		totalPages,
		currentPage,
		translates,
		threads,
		highlights,
		visualTraces,
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
	// ---- Highlights (EmbedPDF annotations) ----

	const [citationLinks, setCitationLinks] = useState<
		Map<number, PdfLinkAnnoObject[]>
	>(new Map());

	const rebuildHighlights = useCallback(() => {
		if (!annotationCap) return;
		const scope = annotationCap.forDocument(docId);
		const all = scope.getAnnotations();
		const list = all
			.map((a) => a.object)
			.filter(isHighlightObject)
			.map((o) => highlightViewFromObject(o, paperKey ?? ""));
		setHighlights(list);
		onHighlightsChangeRef.current?.(list);
		const links = new Map<number, PdfLinkAnnoObject[]>();
		for (const tracked of all) {
			const o = tracked.object;
			if (isLinkObject(o) && o.target) {
				const arr = links.get(o.pageIndex);
				if (arr) arr.push(o);
				else links.set(o.pageIndex, [o]);
			}
		}
		setCitationLinks(links);
	}, [annotationCap, docId, paperKey]);

	const scheduleSave = useCallback(() => {
		if (!paperAbsPath || !annotationCap) return;
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(async () => {
			try {
				const items = await annotationCap
					.forDocument(docId)
					.exportAnnotations()
					.toPromise();
				await saveAnnotationItems(paperAbsPath, items);
			} catch {
				// transient export failures are non-fatal; next change retries
			}
		}, 600);
	}, [paperAbsPath, annotationCap, docId]);

	useEffect(() => {
		if (!annotationCap) return;
		const scope = annotationCap.forDocument(docId);
		const off = scope.onAnnotationEvent((event) => {
			rebuildHighlights();
			if (event.type !== "loaded" && !importingRef.current) scheduleSave();
		});
		rebuildHighlights();
		return () => off();
	}, [annotationCap, docId, rebuildHighlights, scheduleSave]);

	useEffect(() => {
		if (importedRef.current || !annotationCap || !docCap || totalPages <= 0)
			return;
		importedRef.current = true;
		void (async () => {
			const scope = annotationCap.forDocument(docId);
			let items: AnnotationTransferItem[] = paperAbsPath
				? await loadAnnotationItems(paperAbsPath)
				: [];
			if (
				paperAbsPath &&
				!items.length &&
				!(await hasAnnotationsFile(paperAbsPath))
			) {
				const doc = docCap.getDocument(docId);
				const migrated = await migrateHighlightMarks(
					paperAbsPath,
					(pageIndex) => doc?.pages[pageIndex]?.size ?? null,
				);
				if (migrated.length) {
					items = migrated;
					await saveAnnotationItems(paperAbsPath, migrated);
				}
			}
			if (items.length) {
				importingRef.current = true;
				scope.importAnnotations(items);
				setTimeout(() => {
					importingRef.current = false;
					rebuildHighlights();
				}, 0);
			}
		})();
	}, [
		annotationCap,
		docCap,
		docId,
		totalPages,
		paperAbsPath,
		rebuildHighlights,
	]);

	// ---- Ask / Translate persistence + streaming ----

	const upsertThread = useCallback((thread: PdfAskThread) => {
		setThreads((prev) => {
			const i = prev.findIndex((t) => t.id === thread.id);
			if (i < 0) return [thread, ...prev];
			const next = [...prev];
			next[i] = thread;
			return next;
		});
	}, []);

	const persist = useCallback(
		async (thread: PdfAskThread) => {
			if (!paperAbsPath) return;
			try {
				await writePdfAskThread(paperAbsPath, thread);
			} catch {
				// keep UI responsive
			}
		},
		[paperAbsPath],
	);

	const upsertTranslate = useCallback((rec: PdfTranslateRecord) => {
		setTranslates((prev) => {
			const i = prev.findIndex((x) => x.id === rec.id);
			if (i < 0) return [rec, ...prev];
			const next = [...prev];
			next[i] = rec;
			return next;
		});
	}, []);

	const persistTranslate = useCallback(
		async (rec: PdfTranslateRecord) => {
			if (!paperAbsPath) return;
			try {
				await writePdfTranslate(paperAbsPath, rec);
			} catch {
				// keep UI responsive
			}
		},
		[paperAbsPath],
	);

	const markTranslateFailure = useCallback(
		(id: string, message: string) => {
			const latest = translatesRef.current.find((r) => r.id === id);
			if (latest) {
				upsertTranslate({
					...latest,
					error: message,
					updatedAt: new Date().toISOString(),
				});
			}
			translateStreamingRef.current = false;
			setTranslateStreaming(false);
			setTranslateError(message);
		},
		[upsertTranslate],
	);

	// Load persisted ask threads + translate records + agent-trace marks once.
	useEffect(() => {
		if (marksLoadedRef.current || !paperAbsPath) return;
		marksLoadedRef.current = true;
		void (async () => {
			const [ts, trs, traces] = await Promise.all([
				listPdfAskThreads(paperAbsPath),
				listPdfTranslates(paperAbsPath),
				listPdfVisualTraces(paperAbsPath),
			]);
			if (ts.length) setThreads(ts);
			if (trs.length) setTranslates(trs);
			if (traces.length) setVisualTraces(traces);
		})();
	}, [paperAbsPath]);

	// Load `{paper}/Annotation.md` symbol glossary for formula hover cards.
	useEffect(() => {
		let cancelled = false;
		if (!paperAbsPath) {
			setEquationSymbols([]);
			setFormulaAnnotationPreview(null);
			return;
		}
		void loadEquationAnnotation(paperAbsPath).then((symbols) => {
			if (cancelled) return;
			setEquationSymbols(symbols);
		});
		return () => {
			cancelled = true;
		};
	}, [paperAbsPath]);

	// Reload Annotation.md when the Agent / editor rewrites it on disk.
	useEffect(() => {
		if (!paperAbsPath || !isTauri()) return;
		const annotationPath = equationAnnotationPath(paperAbsPath);
		const annotationKey = normalizePathKey(annotationPath);
		let cancelled = false;
		let unsub: (() => void) | undefined;
		void (async () => {
			const { listen } = await import("@tauri-apps/api/event");
			if (cancelled) return;
			unsub = await listen<VaultFileChangedPayload>(
				VAULT_FILE_CHANGED_EVENT,
				({ payload }) => {
					const paths = [...payload.paths];
					if (payload.rename) {
						paths.push(payload.rename.from, payload.rename.to);
					}
					const hit = paths.some((p) => normalizePathKey(p) === annotationKey);
					if (!hit) return;
					void loadEquationAnnotation(paperAbsPath).then((symbols) => {
						setEquationSymbols(symbols);
						// Drop open card if the glossary disappeared.
						if (symbols.length === 0) {
							setFormulaAnnotationPreview(null);
						} else {
							setFormulaAnnotationPreview((prev) =>
								prev ? { ...prev, symbols } : prev,
							);
						}
					});
				},
			);
		})();
		return () => {
			cancelled = true;
			unsub?.();
		};
	}, [paperAbsPath]);

	// Refresh ask conversation cards + agent-trace pins when this viewer is
	// active (dock may keep inactive PDFs mounted under pdfKeepMounted —
	// avoid N× listMarkRaw polls). Covers Agent-panel writes that create ask
	// threads from 「加入对话」 selections while this tab was open.
	//
	// Poll results always carry fresh array identity; only commit state when
	// the content actually changed — otherwise every 4s tick re-renders the
	// whole viewer (renderPage deps) and the pages visibly twitch.
	const lastMarksPollRef = useRef("{asks:[],traces:[]}");
	useEffect(() => {
		if (!paperAbsPath || !marksLoadedRef.current || !isActive) return;
		let cancelled = false;
		const refresh = () => {
			void Promise.all([
				listPdfAskThreads(paperAbsPath),
				listPdfVisualTraces(paperAbsPath),
			]).then(([asks, traces]) => {
				if (cancelled) return;
				let fingerprint: string;
				try {
					fingerprint = JSON.stringify({ asks, traces });
				} catch {
					fingerprint = "";
				}
				if (fingerprint && fingerprint === lastMarksPollRef.current) {
					return;
				}
				lastMarksPollRef.current = fingerprint;
				setThreads(asks);
				setVisualTraces(traces);
			});
		};
		// Immediate refresh on become-active (covers Agent multi-turn writes
		// while this tab was backgrounded).
		refresh();
		const onFocus = () => refresh();
		window.addEventListener("focus", onFocus);
		const timer = window.setInterval(refresh, 4000);
		return () => {
			cancelled = true;
			window.removeEventListener("focus", onFocus);
			window.clearInterval(timer);
		};
	}, [paperAbsPath, isActive]);

	// Publish ask threads (with a real question) to the annotations panel.
	useEffect(() => {
		onAsksChangeRef.current?.(threads.filter(threadHasUserQuestion));
	}, [threads]);

	// Publish visual agent-trace marks to the annotations panel.
	useEffect(() => {
		onVisualTracesChangeRef.current?.(visualTraces);
	}, [visualTraces]);

	const cardScreenRef = useRef<{
		x: number;
		y: number;
		preferRight?: boolean;
	} | null>(null);
	/**
	 * Place the open pin card next to its gutter pin. Returns false when the
	 * page DOM is not mounted yet (virtualized) so callers can retry — never
	 * flash a top-left fallback while EmbedPDF is still scrolling/rendering.
	 *
	 * Uses the same pinFromRects(+pageText) side choice as the gutter so a
	 * left-side pin does not open the dialog on the far right of the selection.
	 */
	const placeActiveCard = useCallback((card: ActiveSelectionCard): boolean => {
		const host = hostRef.current;
		if (!host) return false;
		let page = 1;
		let rects: PdfAskAnchor["rects"] = [];
		if (card.kind === "ask") {
			const thread = threadsRef.current.find((th) => th.id === card.id);
			if (!thread) return false;
			page = thread.anchor.page;
			rects = thread.anchor.rects;
		} else if (card.kind === "translate") {
			const tr = translatesRef.current.find((r) => r.id === card.id);
			if (!tr) return false;
			page = tr.page;
			rects = tr.rects;
		} else if (isVisualMarkKind(card.kind)) {
			const tr = visualTracesRef.current.find((item) => item.id === card.id);
			if (!tr) return false;
			page = tr.page;
			rects = tr.rects;
		} else {
			return false;
		}
		// Same side choice as the gutter pin (page text → may flip left).
		const pageText = pageTextMapRef.current.get(page - 1);
		const pin = pinFromRects(rects, pageText);
		const pageEl = pageElByIndex(host, page - 1);
		const pt = popoverScreenPoint(pageEl, rects, pin);
		// Target page not in the virtual DOM yet — keep cardScreen null so the
		// modal stays hidden until onScroll / rAF retry can place it for real.
		if (!pt) return false;
		// Skip identical coords — avoids re-rendering the open card (and its
		// input) on every scroll tick when the pin did not actually move.
		const prev = cardScreenRef.current;
		if (
			prev &&
			Math.round(prev.x) === Math.round(pt.x) &&
			Math.round(prev.y) === Math.round(pt.y) &&
			prev.preferRight === pt.preferRight
		) {
			return true;
		}
		cardScreenRef.current = pt;
		setCardScreen(pt);
		return true;
	}, []);

	/** After instant page jumps, the virtual page may land a few frames later. */
	const placeActiveCardWithRetry = useCallback(
		(card: ActiveSelectionCard, attempts = 12) => {
			let tries = 0;
			const tick = () => {
				if (placeActiveCard(card)) return;
				tries += 1;
				if (tries >= attempts) return;
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		},
		[placeActiveCard],
	);

	const cancelHoverHide = useCallback(() => {
		if (hidePopoverTimerRef.current) {
			clearTimeout(hidePopoverTimerRef.current);
			hidePopoverTimerRef.current = null;
		}
	}, []);

	/**
	 * Selection / note modals are portaled `role="dialog"`. After pin leave the
	 * hide timer may fire before (or without) a card pointerenter — keep open
	 * while the pointer is still over a dialog or a field inside it is focused.
	 */
	const isFloatingDialogActive = useCallback((): boolean => {
		if (typeof document === "undefined") return false;
		const dialogs = document.querySelectorAll('[role="dialog"]');
		for (const node of dialogs) {
			if (!(node instanceof HTMLElement)) continue;
			// Fixed floating selection cards / annotation editors only.
			if (!node.classList.contains("fixed")) continue;
			try {
				if (node.matches(":hover")) return true;
			} catch {
				// :hover may throw in non-browser test envs
			}
			const ae = document.activeElement;
			if (ae instanceof HTMLElement && node.contains(ae)) return true;
		}
		return false;
	}, []);

	const discardIfEmptyDraft = useCallback((threadId: string | null) => {
		if (!threadId) return;
		const th = threadsRef.current.find((t) => t.id === threadId);
		if (!th || threadHasUserQuestion(th)) return;
		setThreads((prev) => prev.filter((t) => t.id !== threadId));
	}, []);

	const hideActiveCard = useCallback(() => {
		const cur = activeCardRef.current;
		if (cur?.kind === "ask") {
			discardIfEmptyDraft(cur.id);
			setAskError(null);
		}
		if (cur?.kind === "translate") setTranslateError(null);
		if (isVisualMarkKind(cur?.kind)) {
			setVisualError(null);
			setVisualCardExpanded(false);
		}
		cardHoverSurfaceRef.current = false;
		setActiveCard(null);
		cardScreenRef.current = null;
		setCardScreen(null);
		setEditor(null);
	}, [discardIfEmptyDraft]);

	const markCardHoverEnter = useCallback(() => {
		cardHoverSurfaceRef.current = true;
		cancelHoverHide();
	}, [cancelHoverHide]);

	/**
	 * Leave pin / card / source fragment. Translate cards hide when nothing is
	 * hovered (unless still streaming). Ask / visual / note editors keep a 1s
	 * delay, and never dismiss while the floating dialog is hovered or focused.
	 */
	const scheduleHoverHide = useCallback(() => {
		cardHoverSurfaceRef.current = false;
		cancelHoverHide();
		hidePopoverTimerRef.current = setTimeout(() => {
			hidePopoverTimerRef.current = null;
			if (cardHoverSurfaceRef.current) return;
			// Still interacting with the floating note / chat modal.
			if (isFloatingDialogActive()) {
				cardHoverSurfaceRef.current = true;
				return;
			}
			// Ephemeral translate result: stay open only while streaming or hovered.
			if (
				activeCardRef.current?.kind === "translate" &&
				translateStreamingRef.current
			) {
				return;
			}
			hideActiveCard();
		}, 1000);
	}, [cancelHoverHide, hideActiveCard, isFloatingDialogActive]);

	const stopTranslateSession = useCallback(() => {
		const sid = translateSessionRef.current;
		if (sid) {
			void cancelAgentRun(sid).catch(() => undefined);
			if (activeSessionRef.current === sid) activeSessionRef.current = null;
			translateSessionRef.current = null;
		}
		translateStreamingRef.current = false;
		setTranslateStreaming(false);
	}, []);

	// Translate cards are ephemeral: once streaming ends, auto-hide unless the
	// pointer is still over the card, pin, or source highlight.
	const activeTranslateCardId =
		activeCard?.kind === "translate" ? activeCard.id : null;
	useEffect(() => {
		if (!activeTranslateCardId) return;
		if (translateStreaming) return;
		if (cardHoverSurfaceRef.current) return;
		scheduleHoverHide();
	}, [activeTranslateCardId, translateStreaming, scheduleHoverHide]);

	const openCard = useCallback(
		(card: ActiveSelectionCard) => {
			// Cancel pending hide and treat open as an active hover surface so
			// the card does not auto-close while the pointer is still over the
			// pin / newly mounted modal (mount under cursor skips pointerenter).
			cancelHoverHide();
			cardHoverSurfaceRef.current = true;
			if (
				activeCardRef.current?.kind === "translate" &&
				(card.kind !== "translate" || card.id !== activeCardRef.current.id)
			) {
				stopTranslateSession();
			}
			setActiveCard(card);
			if (card.kind === "ask") setAskError(null);
			if (card.kind === "translate") setTranslateError(null);
			// Place now if the page is mounted. If not (far jump / virtualized),
			// clear stale coords so the modal does not flash at the old pin, then
			// retry for a few frames after instant scroll mounts the page.
			if (!placeActiveCard(card)) {
				cardScreenRef.current = null;
				setCardScreen(null);
				placeActiveCardWithRetry(card);
			}
		},
		[
			cancelHoverHide,
			placeActiveCard,
			placeActiveCardWithRetry,
			stopTranslateSession,
		],
	);

	const openThread = useCallback(
		(thread: PdfAskThread) => openCard({ kind: "ask", id: thread.id }),
		[openCard],
	);

	const createThreadFromAnchor = useCallback(
		(anchor: PdfAskAnchor) => {
			const paperPath = paperRelPath || paperAbsPath || "paper";
			const thread = createEmptyThread({ paperPath, anchor });
			setThreads((prev) => [thread, ...prev.filter(threadHasUserQuestion)]);
			return thread;
		},
		[paperAbsPath, paperRelPath],
	);

	const startFromAnchor = useCallback(
		(anchor: PdfAskAnchor) => {
			const thread = createThreadFromAnchor(anchor);
			openThread(thread);
		},
		[createThreadFromAnchor, openThread],
	);

	const sendToThread = useCallback(
		async (
			thread: PdfAskThread,
			question: string,
			agentOpts?: { agentId?: string; modelId?: string },
			/** When set (edit/resend), replace the transcript from this base instead of appending to full history. */
			baseMessages?: PdfAskThread["messages"],
			/** Visual PDF crops attached to this turn. */
			images?: PromptImage[],
		) => {
			const threadId = thread.id;
			if (!question.trim()) return;
			const userMsg = {
				id: newMessageId(),
				role: "user" as const,
				content: question,
				createdAt: new Date().toISOString(),
			};
			const prior = baseMessages ?? thread.messages;
			const withUser: PdfAskThread = {
				...thread,
				status: "open",
				messages: [...prior, userMsg],
				updatedAt: new Date().toISOString(),
			};
			upsertThread(withUser);
			void persist(withUser);
			setAskError(null);
			setStreaming(true);

			const assistantId = newMessageId();
			const prompt = buildPdfAskPrompt(withUser, question);
			try {
				const accepted = await runOnce({
					prompt,
					agentId: agentOpts?.agentId,
					modelId: agentOpts?.modelId,
					images,
					vaultPath: vaultPath ?? undefined,
					workflow: "free",
					autoApprove: true,
					hideFromChatHistory: true,
				});
				activeSessionRef.current = accepted.sessionId;
				const withAssistant: PdfAskThread = {
					...withUser,
					messages: [
						...withUser.messages,
						{
							id: assistantId,
							role: "assistant",
							content: "",
							createdAt: new Date().toISOString(),
							agentSessionId: accepted.sessionId,
						},
					],
				};
				upsertThread(withAssistant);
				const sessionId = accepted.sessionId;
				const unsubs: UnlistenFn[] = [];
				const cleanup = () => {
					for (const u of unsubs) u();
					if (activeSessionRef.current === sessionId)
						activeSessionRef.current = null;
					setStreaming(false);
				};
				unsubs.push(
					await listenAgentStream((ev) => {
						if (ev.sessionId !== sessionId) return;
						if ((ev.kind ?? "message") === "thought") return;
						setThreads((prev) =>
							prev.map((th) => {
								if (th.id !== threadId) return th;
								const msgs = [...th.messages];
								const last = msgs[msgs.length - 1];
								if (last?.id !== assistantId) return th;
								msgs[msgs.length - 1] = {
									...last,
									content: last.content + ev.chunk,
								};
								return { ...th, messages: msgs };
							}),
						);
					}),
				);
				unsubs.push(
					await listenAgentCompleted((ev) => {
						if (ev.sessionId !== sessionId) return;
						setThreads((prev) =>
							prev.map((th) => {
								if (th.id !== threadId) return th;
								const msgs = [...th.messages];
								const last = msgs[msgs.length - 1];
								if (last?.id === assistantId) {
									msgs[msgs.length - 1] = {
										...last,
										content: ev.content || last.content,
										sources: (ev.sources ?? []).map((uri) => ({ uri })),
									};
								}
								const done: PdfAskThread = {
									...th,
									messages: msgs,
									updatedAt: new Date().toISOString(),
								};
								void persist(done);
								return done;
							}),
						);
						cleanup();
					}),
				);
				unsubs.push(
					await listenAgentFailed((ev) => {
						if (ev.sessionId !== sessionId) return;
						setAskError(ev.error || t("pdfAsk.agentFailed"));
						setThreads((prev) =>
							prev.map((th) => {
								if (th.id !== threadId) return th;
								const msgs = th.messages.filter((m) => m.id !== assistantId);
								const done = { ...th, messages: msgs };
								void persist(done);
								return done;
							}),
						);
						cleanup();
					}),
				);
			} catch (e) {
				setStreaming(false);
				setAskError(e instanceof Error ? e.message : t("pdfAsk.agentFailed"));
			}
		},
		[upsertThread, persist, vaultPath, t],
	);

	const resolvePdfAskAgent = useCallback(async () => {
		const registry = await listAgents().catch(() => null);
		const resolved = resolveTranslateAgent(loadSettings().pdfAsk, registry);
		if (!resolved.agentId) {
			const msg = t("pdfAsk.noAgent");
			notifyError(msg);
			setAskError(msg);
			return null;
		}
		return resolved;
	}, [t]);

	const cancelLayoutHover = useCallback((regionId?: string) => {
		if (
			regionId != null &&
			layoutHoverRegionIdRef.current != null &&
			layoutHoverRegionIdRef.current !== regionId
		) {
			return;
		}
		if (layoutHoverTimerRef.current) {
			clearTimeout(layoutHoverTimerRef.current);
			layoutHoverTimerRef.current = null;
		}
		if (regionId == null || layoutHoverRegionIdRef.current === regionId) {
			layoutHoverRegionIdRef.current = null;
		}
	}, []);

	const cancelLayoutDraftHide = useCallback(() => {
		if (!layoutDraftHideTimerRef.current) return;
		clearTimeout(layoutDraftHideTimerRef.current);
		layoutDraftHideTimerRef.current = null;
	}, []);

	const cancelFormulaHover = useCallback((regionId?: string) => {
		if (
			regionId != null &&
			formulaHoverRegionIdRef.current != null &&
			formulaHoverRegionIdRef.current !== regionId
		) {
			return;
		}
		if (formulaHoverTimerRef.current) {
			clearTimeout(formulaHoverTimerRef.current);
			formulaHoverTimerRef.current = null;
		}
		if (regionId == null || formulaHoverRegionIdRef.current === regionId) {
			formulaHoverRegionIdRef.current = null;
		}
	}, []);

	const cancelFormulaHide = useCallback(() => {
		if (!formulaHideTimerRef.current) return;
		clearTimeout(formulaHideTimerRef.current);
		formulaHideTimerRef.current = null;
	}, []);

	const closeVisualDraftEditor = useCallback(() => {
		cancelLayoutDraftHide();
		layoutDraftHoverSurfaceRef.current = false;
		// Layout-hover also sets figures-rail focus for the bbox frame; clear it
		// with the draft so the image selection outline does not linger.
		const wasEphemeral = visualDraftEditorRef.current?.ephemeral === true;
		setVisualDraftEditor(null);
		if (wasEphemeral && !formulaAnnotationPreviewRef.current) {
			setFocusedLayoutRegion(docId, null);
		}
	}, [cancelLayoutDraftHide, docId]);

	const closeFormulaAnnotationPreview = useCallback(() => {
		cancelFormulaHover();
		cancelFormulaHide();
		formulaHoverSurfaceRef.current = false;
		const had = formulaAnnotationPreviewRef.current != null;
		setFormulaAnnotationPreview(null);
		if (had && !visualDraftEditorRef.current?.ephemeral) {
			setFocusedLayoutRegion(docId, null);
		}
	}, [cancelFormulaHide, cancelFormulaHover, docId]);

	const markLayoutDraftHoverEnter = useCallback(() => {
		layoutDraftHoverSurfaceRef.current = true;
		cancelLayoutDraftHide();
	}, [cancelLayoutDraftHide]);

	/**
	 * Leave ephemeral layout-hover source region or draft card.
	 * Manual region-select drafts ignore this (no auto-hide).
	 */
	const scheduleLayoutDraftHide = useCallback(() => {
		if (visualDraftEditorRef.current?.ephemeral !== true) return;
		layoutDraftHoverSurfaceRef.current = false;
		cancelLayoutDraftHide();
		layoutDraftHideTimerRef.current = setTimeout(() => {
			layoutDraftHideTimerRef.current = null;
			if (layoutDraftHoverSurfaceRef.current) return;
			if (!visualDraftEditorRef.current?.ephemeral) return;
			// Clears draft + focused layout bbox (see closeVisualDraftEditor).
			closeVisualDraftEditor();
		}, LAYOUT_HOVER_HIDE_MS);
	}, [cancelLayoutDraftHide, closeVisualDraftEditor]);

	/** Keep formula legend open while pointer is on the hit region or card. */
	const markFormulaHoverEnter = useCallback(() => {
		formulaHoverSurfaceRef.current = true;
		cancelFormulaHide();
	}, [cancelFormulaHide]);

	/**
	 * Leave formula hit / legend card → close after a short grace so the
	 * pointer can cross the gap into the floating card.
	 */
	const scheduleFormulaHide = useCallback(() => {
		if (!formulaAnnotationPreviewRef.current) return;
		formulaHoverSurfaceRef.current = false;
		cancelFormulaHide();
		formulaHideTimerRef.current = setTimeout(() => {
			formulaHideTimerRef.current = null;
			if (formulaHoverSurfaceRef.current) return;
			if (!formulaAnnotationPreviewRef.current) return;
			closeFormulaAnnotationPreview();
		}, LAYOUT_FORMULA_HOVER_HIDE_MS);
	}, [cancelFormulaHide, closeFormulaAnnotationPreview]);

	/** Drop in-flight hover dwell / crop so a late result does not open the editor. */
	const invalidateLayoutHover = useCallback(() => {
		layoutHoverSeqRef.current += 1;
		cancelLayoutHover();
	}, [cancelLayoutHover]);

	/** Screen point near a layout bbox (right edge) for hover cards. */
	const screenPointForRegion = useCallback(
		(pageIndex0: number, region: PdfAskNormalizedRect) => {
			const pageEl = pageElByIndex(hostRef.current, pageIndex0);
			if (!pageEl) return { x: 120, y: 120 };
			const box = pageEl.getBoundingClientRect();
			return {
				x: box.left + (region.x + region.w) * box.width + 8,
				y: box.top + region.y * box.height,
			};
		},
		[],
	);

	/** Open / switch the formula legend card for a layout region. */
	const openFormulaLegend = useCallback(
		(region: PdfLayoutRegion) => {
			const symbols = equationSymbolsRef.current;
			if (symbols.length === 0) return;
			// Pointer is still on the formula hit when we open; keep surface live
			// so unmount/remount of overlays does not immediately hide.
			formulaHoverSurfaceRef.current = true;
			cancelFormulaHide();
			cancelFormulaHover();
			setFocusedLayoutRegion(docId, region.id);
			setFormulaAnnotationPreview({
				screen: screenPointForRegion(region.pageIndex, region.bbox),
				regionId: region.id,
				page: region.pageIndex + 1,
				region: region.bbox,
				symbols,
			});
		},
		[cancelFormulaHide, cancelFormulaHover, docId, screenPointForRegion],
	);

	/** Re-anchor the open formula legend after scroll / zoom. */
	const rePlaceFormulaAnnotationOnScroll = useCallback(() => {
		const prev = formulaAnnotationPreviewRef.current;
		if (!prev) return;
		const screen = screenPointForRegion(prev.page - 1, prev.region);
		setFormulaAnnotationPreview((current) => {
			if (!current || current.regionId !== prev.regionId) return current;
			if (current.screen.x === screen.x && current.screen.y === screen.y) {
				return current;
			}
			return { ...current, screen };
		});
	}, [screenPointForRegion]);

	/** Crop a region and open the visual-annotation draft editor (does not send). */
	const beginVisualAnnotation = useCallback(
		async (
			page: number,
			region: PdfAskNormalizedRect,
			opts?: { seq?: number; ephemeral?: boolean },
		) => {
			if (!engine || !docCap || visualCropPendingRef.current) return;
			if (!docCap.isDocumentOpen(docId)) return;
			const document = docCap.getDocument(docId);
			if (!document) {
				notifyError(t("pdfExplain.cropFailed"));
				return;
			}
			setVisualCropPending(true);
			setRegionSelecting(false);
			// Visual draft and formula legend are mutually exclusive.
			closeFormulaAnnotationPreview();
			try {
				const image = await renderPdfRegionPromptImage({
					engine,
					document,
					pageIndex: page - 1,
					region,
				});
				if (!docCap.isDocumentOpen(docId)) return;
				if (opts?.seq != null && opts.seq !== layoutHoverSeqRef.current) {
					return;
				}
				const screen = screenPointForRegion(page - 1, region);
				const ephemeral = opts?.ephemeral === true;
				// Pointer is still over the region when hover-open completes; keep
				// the surface active so unmounting hit targets does not auto-hide.
				if (ephemeral) {
					layoutDraftHoverSurfaceRef.current = true;
					cancelLayoutDraftHide();
				}
				setVisualDraftEditor({
					screen,
					page,
					region,
					image,
					ephemeral: ephemeral || undefined,
				});
				layoutHoverRegionIdRef.current = null;
			} catch (error) {
				if (opts?.seq != null && opts.seq !== layoutHoverSeqRef.current) {
					return;
				}
				if (
					!docCap.isDocumentOpen(docId) ||
					isPdfDocumentCloseRaceError(error)
				) {
					return;
				}
				const message =
					error instanceof Error ? error.message : t("pdfExplain.cropFailed");
				notifyError(t("pdfExplain.cropFailed"), { description: message });
			} finally {
				setVisualCropPending(false);
			}
		},
		[
			engine,
			docCap,
			docId,
			t,
			cancelLayoutDraftHide,
			closeFormulaAnnotationPreview,
			screenPointForRegion,
		],
	);

	/**
	 * After dwelling on a layout region:
	 * - formula + Annotation.md symbols → 「公式解析」glossary card (light UX)
	 * - otherwise → same visual editor as manual region-select (crop only)
	 */
	const scheduleLayoutHoverOpen = useCallback(
		(region: PdfLayoutRegion) => {
			if (
				regionSelectingRef.current ||
				visualCropPendingRef.current ||
				visualDraftEditorRef.current ||
				selectionMenuRef.current
			) {
				return;
			}

			const symbols = equationSymbolsRef.current;
			const formulaLegend =
				isFormulaLayoutKind(region.kind) && symbols.length > 0;

			// ---- Formula legend path (tooltip-like; independent timers) ----
			if (formulaLegend) {
				// Already showing this formula: cancel pending hide, stay open.
				if (formulaAnnotationPreviewRef.current?.regionId === region.id) {
					markFormulaHoverEnter();
					return;
				}
				// Switching formulas: open the new one after a short dwell (or
				// immediately if a legend is already open — seamless switch).
				if (
					formulaHoverRegionIdRef.current === region.id &&
					formulaHoverTimerRef.current
				) {
					return;
				}
				cancelFormulaHover();
				// Leave visual-ask dwell alone when entering a formula hit.
				cancelLayoutHover();
				// Switching while another legend is open: no extra dwell.
				if (formulaAnnotationPreviewRef.current) {
					openFormulaLegend(region);
					return;
				}
				formulaHoverRegionIdRef.current = region.id;
				formulaHoverTimerRef.current = setTimeout(() => {
					formulaHoverTimerRef.current = null;
					if (formulaHoverRegionIdRef.current !== region.id) return;
					if (
						regionSelectingRef.current ||
						visualCropPendingRef.current ||
						visualDraftEditorRef.current ||
						selectionMenuRef.current
					) {
						return;
					}
					openFormulaLegend(region);
				}, LAYOUT_FORMULA_HOVER_DWELL_MS);
				return;
			}

			// ---- Visual-ask path (figures / tables / algorithms / bare formula) ----
			// Don't stack a visual draft while a formula legend is open.
			if (formulaAnnotationPreviewRef.current) return;

			if (
				layoutHoverRegionIdRef.current === region.id &&
				layoutHoverTimerRef.current
			) {
				return;
			}
			cancelLayoutHover();
			cancelFormulaHover();
			layoutHoverRegionIdRef.current = region.id;
			layoutHoverTimerRef.current = setTimeout(() => {
				layoutHoverTimerRef.current = null;
				if (layoutHoverRegionIdRef.current !== region.id) return;
				if (
					regionSelectingRef.current ||
					visualCropPendingRef.current ||
					visualDraftEditorRef.current ||
					formulaAnnotationPreviewRef.current ||
					selectionMenuRef.current
				) {
					return;
				}
				setFocusedLayoutRegion(docId, region.id);
				const seq = ++layoutHoverSeqRef.current;
				void beginVisualAnnotation(region.pageIndex + 1, region.bbox, {
					seq,
					ephemeral: true,
				});
			}, LAYOUT_HOVER_DWELL_MS);
		},
		[
			beginVisualAnnotation,
			cancelFormulaHover,
			cancelLayoutHover,
			docId,
			markFormulaHoverEnter,
			openFormulaLegend,
		],
	);

	const handleLayoutHoverLeave = useCallback(
		(regionId: string) => {
			// Formula dwell / open legend for this region.
			if (formulaHoverRegionIdRef.current === regionId) {
				cancelFormulaHover(regionId);
			}
			if (formulaAnnotationPreviewRef.current?.regionId === regionId) {
				scheduleFormulaHide();
			}

			if (layoutHoverRegionIdRef.current === regionId) {
				// Timer still running → just cancel. Timer already fired / crop
				// in flight → invalidate so a late crop does not open the editor.
				if (
					layoutHoverTimerRef.current == null ||
					visualCropPendingRef.current
				) {
					layoutHoverSeqRef.current += 1;
				}
			}
			cancelLayoutHover(regionId);
		},
		[cancelFormulaHover, cancelLayoutHover, scheduleFormulaHide],
	);

	useEffect(() => {
		// Drop in-flight hover when switching PDF documents or unmounting.
		if (!docId) {
			invalidateLayoutHover();
			cancelLayoutDraftHide();
			closeFormulaAnnotationPreview();
			return;
		}
		invalidateLayoutHover();
		cancelLayoutDraftHide();
		closeFormulaAnnotationPreview();
		return () => {
			invalidateLayoutHover();
			cancelLayoutDraftHide();
			closeFormulaAnnotationPreview();
		};
	}, [
		docId,
		invalidateLayoutHover,
		cancelLayoutDraftHide,
		closeFormulaAnnotationPreview,
	]);

	// Escape closes the formula legend (same expectation as other floaters).
	useEffect(() => {
		if (!formulaAnnotationPreview) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			closeFormulaAnnotationPreview();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [formulaAnnotationPreview, closeFormulaAnnotationPreview]);

	// Keep formula legend glued to its bbox across zoom (scroll uses ActiveCardScrollSync).
	// biome-ignore lint/correctness/useExhaustiveDependencies: zoomLevel re-places intentionally
	useEffect(() => {
		if (!formulaAnnotationPreview) return;
		rePlaceFormulaAnnotationOnScroll();
	}, [
		formulaAnnotationPreview?.regionId,
		zoomLevel,
		rePlaceFormulaAnnotationOnScroll,
	]);

	const stopLayoutTranslate = useCallback(() => {
		layoutTranslateAbortRef.current?.abort();
		layoutTranslateAbortRef.current = null;
		setLayoutTranslateJob((prev) =>
			prev.status === "running" ? { ...prev, status: "cancelled" } : prev,
		);
	}, []);

	const clearLayoutTranslate = useCallback(() => {
		layoutTranslateAbortRef.current?.abort();
		layoutTranslateAbortRef.current = null;
		setLayoutTranslateJob({ status: "idle", items: [] });
	}, []);

	const startLayoutTranslate = useCallback(() => {
		const raw = layoutRawRegions;
		if (!raw?.length) {
			notifyError(t("pdf.layoutTranslate.needLayout"));
			return;
		}
		const regions = listTranslatableLayoutRegions(raw);
		if (regions.length === 0) {
			notifyError(t("pdf.layoutTranslate.noText"));
			return;
		}
		layoutTranslateAbortRef.current?.abort();
		const ac = new AbortController();
		layoutTranslateAbortRef.current = ac;
		const items = toLayoutTranslateItems(regions);
		setLayoutTranslateJob({ status: "running", items });
		void runLayoutRegionTranslate({
			items,
			signal: ac.signal,
			onUpdate: (next) => {
				if (ac.signal.aborted) return;
				setLayoutTranslateJob((prev) => ({
					status: prev.status === "cancelled" ? "cancelled" : "running",
					items: next,
				}));
			},
		})
			.then((finalItems) => {
				if (ac.signal.aborted) {
					setLayoutTranslateJob({ status: "cancelled", items: finalItems });
					return;
				}
				setLayoutTranslateJob({ status: "done", items: finalItems });
			})
			.catch((e) => {
				if (ac.signal.aborted) return;
				const message = e instanceof Error ? e.message : String(e);
				notifyError(t("pdf.layoutTranslate.failed"), { description: message });
				setLayoutTranslateJob((prev) => ({
					status: "done",
					items: prev.items,
				}));
			})
			.finally(() => {
				if (layoutTranslateAbortRef.current === ac) {
					layoutTranslateAbortRef.current = null;
				}
			});
	}, [layoutRawRegions, t]);

	const toggleLayoutTranslate = useCallback(() => {
		if (layoutTranslateJob.status === "running") {
			stopLayoutTranslate();
			return;
		}
		if (
			layoutTranslateJob.status === "done" ||
			layoutTranslateJob.status === "cancelled"
		) {
			// Second click clears overlays; third starts again from the button.
			if (layoutTranslateJob.items.some((it) => it.translated)) {
				clearLayoutTranslate();
				return;
			}
		}
		startLayoutTranslate();
	}, [
		layoutTranslateJob,
		startLayoutTranslate,
		stopLayoutTranslate,
		clearLayoutTranslate,
	]);

	// Abort bulk translate when switching documents.
	useEffect(() => {
		if (!docId) return;
		layoutTranslateAbortRef.current?.abort();
		layoutTranslateAbortRef.current = null;
		setLayoutTranslateJob({ status: "idle", items: [] });
		return () => {
			layoutTranslateAbortRef.current?.abort();
		};
	}, [docId]);

	const upsertVisualTrace = useCallback((trace: PdfVisualSessionTrace) => {
		setVisualTraces((prev) => {
			const next = [trace, ...prev.filter((tr) => tr.id !== trace.id)];
			// Keep ref in sync so openCard/placeActiveCard can find a just-created mark.
			visualTracesRef.current = next;
			return next;
		});
	}, []);

	/**
	 * Save from the region editor: note-only visual mark (no Agent thread).
	 * Same UX as text 批注备注 — open the pin in note mode.
	 */
	const handleVisualDraftSave = useCallback(
		(comment: string) => {
			const draft = visualDraftEditor;
			if (!draft) return;
			const paperPath = paperRelPath || paperAbsPath || "paper";
			let mark: PdfVisualSessionTrace;
			try {
				mark = createNoteTrace({
					paperPath,
					page: draft.page,
					rects: [draft.region],
					comment,
					image: {
						data: draft.image.data,
						mimeType: draft.image.mimeType || "image/png",
					},
				});
			} catch {
				return;
			}
			closeVisualDraftEditor();
			upsertVisualTrace(mark);
			if (paperAbsPath) {
				void writePdfVisualTrace(paperAbsPath, mark).catch((error) => {
					console.warn("[visual-mark] save note failed", error);
					notifyError(error instanceof Error ? error.message : String(error));
				});
			}
			setVisualCardExpanded(false);
			cardScreenRef.current = draft.screen;
			setCardScreen(draft.screen);
			openCard({ kind: "visual", id: mark.id });
		},
		[
			visualDraftEditor,
			paperRelPath,
			paperAbsPath,
			closeVisualDraftEditor,
			upsertVisualTrace,
			openCard,
		],
	);

	/**
	 * Header「加入侧边栏对话」from the create editor: crop → Agent composer chip.
	 */
	const handleVisualAddToChat = useCallback(
		(comment: string) => {
			const draft = visualDraftEditor;
			if (!draft) return;
			closeVisualDraftEditor();
			addVisualDraft({
				paperPath: paperRelPath || paperAbsPath || "paper",
				paperAbsPath: paperAbsPath ?? undefined,
				page: draft.page,
				rects: [draft.region],
				comment,
				image: draft.image,
			});
			openRightTab("agent");
		},
		[visualDraftEditor, paperRelPath, paperAbsPath, closeVisualDraftEditor],
	);

	/**
	 * Pin modal chat is the same product session as the right-rail Agent panel.
	 * All turns go through agentSessionStore.requestTurn → panel send pipeline.
	 */
	const requestVisualAgentTurn = useCallback(
		(input: {
			trace: PdfVisualSessionTrace;
			text: string;
			visualDrafts?: import("@/lib/agent/visual-context-store").PdfVisualDraft[];
			agentId?: string;
			modelId?: string;
		}) => {
			const { trace, text, visualDrafts, agentId, modelId } = input;
			setAgentPanelMounted(true);
			setVisualError(null);
			agentSessionStore.getState().requestTurn({
				text,
				visualTraceId: trace.id,
				paperAbsPath: paperAbsPath ?? undefined,
				agentId,
				modelId,
				title: text.trim() || trace.comment || t("pdfExplain.visualAnnotation"),
				providerSessionId: trace.agent?.providerSessionId,
				visualDrafts,
			});
		},
		[paperAbsPath, t],
	);

	/**
	 * ⌘/Ctrl+Enter from the region editor: open pin chat and start Agent turn.
	 * Leave mark.comment empty — the editor text is conversation, not a note;
	 * putting it in both comment and messages duplicates in wiki embeds.
	 */
	const handleVisualSendNow = useCallback(
		(comment: string) => {
			const draft = visualDraftEditor;
			if (!draft) return;
			const paperPath = paperRelPath || paperAbsPath || "paper";
			// Conversation body (never the annotation note). Empty input still
			// needs a user turn so the agent path has something to send.
			const promptText = comment.trim() || t("pdfExplain.visualAnnotation");
			const now = new Date().toISOString();
			const userMsg = {
				id: newTraceMessageId(),
				role: "user" as const,
				content: promptText,
				createdAt: now,
			};
			const [provisional] = createRunningTraces({
				paperPath,
				agentId: "pending",
				runtimeSessionId: "pending",
				messageId: "pending",
				items: [
					{
						page: draft.page,
						rects: [draft.region],
						// Note field stays empty; content lives in messages only.
						comment: "",
						image: {
							data: draft.image.data,
							mimeType: draft.image.mimeType || "image/png",
						},
						messages: [userMsg],
					},
				],
				createdAt: now,
			});
			if (!provisional) return;
			closeVisualDraftEditor();
			upsertVisualTrace(provisional);
			setVisualCardExpanded(true);
			setVisualError(null);
			cardScreenRef.current = draft.screen;
			setCardScreen(draft.screen);
			openCard({ kind: "visual", id: provisional.id });

			void (async () => {
				try {
					const resolved = await resolvePdfAskAgent();
					const agentId = resolved?.agentId;
					if (!agentId) {
						setVisualTraces((prev) =>
							prev.filter((tr) => tr.id !== provisional.id),
						);
						hideActiveCard();
						return;
					}
					const visualDraft: import("@/lib/agent/visual-context-store").PdfVisualDraft =
						{
							id: provisional.id,
							paperPath,
							paperAbsPath: paperAbsPath ?? undefined,
							page: draft.page,
							rects: [draft.region],
							// Same rule as mark.comment: chip/note empty on direct chat.
							comment: "",
							image: {
								data: draft.image.data,
								mimeType: draft.image.mimeType || "image/png",
							},
						};
					requestVisualAgentTurn({
						trace: {
							...provisional,
							agent: {
								...(provisional.agent ?? {
									runtimeSessionId: "pending",
									messageId: "pending",
									status: "running" as const,
								}),
								agentId,
							},
						},
						text: promptText,
						visualDrafts: [visualDraft],
						agentId,
						modelId: resolved.modelId,
					});
				} catch (e) {
					const message =
						e instanceof Error ? e.message : t("pdfAsk.agentFailed");
					notifyError(message);
					setVisualError(message);
				}
			})();
		},
		[
			visualDraftEditor,
			paperRelPath,
			paperAbsPath,
			t,
			closeVisualDraftEditor,
			upsertVisualTrace,
			openCard,
			resolvePdfAskAgent,
			requestVisualAgentTurn,
			hideActiveCard,
		],
	);

	/** Persist comment edits from the pin note mode. */
	const handleVisualSaveComment = useCallback(
		(comment: string) => {
			const card = activeCardRef.current;
			const traceId = isVisualMarkKind(card?.kind) ? card.id : null;
			if (!traceId) return;
			const latest = visualTracesRef.current.find((tr) => tr.id === traceId);
			if (!latest) return;
			const next: PdfVisualSessionTrace = {
				...latest,
				comment: comment.trim(),
				updatedAt: new Date().toISOString(),
			};
			// Keep content invariant: need comment, agent, or crop image.
			if (
				!next.comment &&
				!next.agent &&
				!next.image?.path &&
				!next.image?.data
			) {
				return;
			}
			upsertVisualTrace(next);
			if (paperAbsPath) {
				void writePdfVisualTrace(paperAbsPath, next).catch((error) => {
					console.warn("[visual-mark] update comment failed", error);
					notifyError(error instanceof Error ? error.message : String(error));
				});
			}
		},
		[paperAbsPath, upsertVisualTrace],
	);

	/** Header「加入侧边栏对话」from an existing visual mark pin. */
	const handleVisualAddToChatFromMark = useCallback(() => {
		const card = activeCardRef.current;
		const traceId = isVisualMarkKind(card?.kind) ? card.id : null;
		if (!traceId) return;
		const latest = visualTracesRef.current.find((tr) => tr.id === traceId);
		if (!latest) return;
		void (async () => {
			const image =
				(await loadPdfVisualTraceImage(paperAbsPath ?? "", latest.image)) ??
				(latest.image?.data
					? {
							data: latest.image.data,
							mimeType: latest.image.mimeType || "image/png",
						}
					: null);
			if (!image?.data) {
				notifyError(t("pdfExplain.cropFailed"));
				return;
			}
			addVisualDraft({
				id: latest.id,
				paperPath: latest.paperPath || paperRelPath || paperAbsPath || "paper",
				paperAbsPath: paperAbsPath ?? undefined,
				page: latest.page,
				rects: latest.rects,
				comment: latest.comment,
				image: {
					data: image.data,
					mimeType: image.mimeType || "image/png",
				},
			});
			openRightTab("agent");
		})();
	}, [paperAbsPath, paperRelPath, t]);

	const handleVisualContinue = useCallback(
		(question: string) => {
			const card = activeCardRef.current;
			const traceId = isVisualMarkKind(card?.kind) ? card.id : null;
			if (!traceId) return;
			setVisualCardExpanded(true);
			void (async () => {
				try {
					const latest = visualTracesRef.current.find(
						(tr) => tr.id === traceId,
					);
					if (!latest) return;
					// Prefer live providerSessionId from shared agent session.
					const bound = agentSessionStore
						.getState()
						.findByVisualTraceId(traceId);
					const providerSessionId =
						bound?.providerSessionId ?? latest.agent?.providerSessionId;
					// Continue: stick to the agent that owns this session/mark.
					// New pins use resolvePdfAskAgent (default); do not re-resolve here
					// or a Grok default would load a Codex providerSessionId.
					const priorAgentId = latest.agent?.agentId;
					const markAgent =
						bound?.agentId?.trim() ||
						(priorAgentId && priorAgentId !== "pending" ? priorAgentId : null);
					let agentId = markAgent;
					let modelId: string | undefined;
					if (!agentId) {
						const resolved = await resolvePdfAskAgent();
						if (!resolved?.agentId) return;
						agentId = resolved.agentId;
						modelId = resolved.modelId;
					}
					const agent = {
						...(latest.agent ?? {
							agentId,
							runtimeSessionId: "pending",
							messageId: "pending",
							status: "running" as const,
						}),
						agentId,
						providerSessionId:
							providerSessionId ?? latest.agent?.providerSessionId,
					};
					// Note-only (or provisional) mark → first Agent turn must send the
					// crop as visualDrafts so the multimodal prompt includes the image.
					// Reuse the same mark id so createRunningTraces overwrites in place.
					const firstAgentAttach =
						!bound &&
						(!latest.agent ||
							latest.agent.agentId === "pending" ||
							latest.agent.runtimeSessionId === "pending");
					let visualDrafts:
						| import("@/lib/agent/visual-context-store").PdfVisualDraft[]
						| undefined;
					if (firstAgentAttach) {
						const image =
							(await loadPdfVisualTraceImage(
								paperAbsPath ?? "",
								latest.image,
							)) ??
							(latest.image?.data
								? {
										data: latest.image.data,
										mimeType: latest.image.mimeType || "image/png",
									}
								: null);
						if (image?.data) {
							visualDrafts = [
								{
									id: latest.id,
									paperPath: latest.paperPath,
									paperAbsPath: paperAbsPath ?? undefined,
									page: latest.page,
									rects: latest.rects,
									comment: latest.comment,
									image: {
										data: image.data,
										mimeType: image.mimeType || "image/png",
									},
								},
							];
						}
					}
					requestVisualAgentTurn({
						trace: { ...latest, agent },
						text: question,
						agentId,
						modelId,
						visualDrafts,
					});
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					notifyError(message);
					setVisualError(message);
				}
			})();
		},
		[resolvePdfAskAgent, requestVisualAgentTurn, paperAbsPath],
	);

	const handleSend = useCallback(
		(question: string) => {
			const card = activeCardRef.current;
			const threadId = card?.kind === "ask" ? card.id : null;
			if (!threadId) return;
			const thread = threadsRef.current.find((th) => th.id === threadId);
			if (!thread) return;
			void (async () => {
				try {
					const resolved = await resolvePdfAskAgent();
					if (!resolved) return;
					void sendToThread(thread, question, {
						agentId: resolved.agentId,
						modelId: resolved.modelId,
					});
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					notifyError(message);
					setAskError(message);
				}
			})();
		},
		[sendToThread, resolvePdfAskAgent],
	);

	/** Edit last (or any) user turn: drop that message and everything after, then re-send. */
	const handleResend = useCallback(
		(messageId: string, question: string) => {
			const card = activeCardRef.current;
			const threadId = card?.kind === "ask" ? card.id : null;
			if (!threadId) return;
			const thread = threadsRef.current.find((th) => th.id === threadId);
			if (!thread) return;
			const index = thread.messages.findIndex(
				(m) => m.id === messageId && m.role === "user",
			);
			if (index < 0) return;
			const baseMessages = thread.messages.slice(0, index);
			void (async () => {
				try {
					const resolved = await resolvePdfAskAgent();
					if (!resolved) return;
					void sendToThread(
						thread,
						question,
						{
							agentId: resolved.agentId,
							modelId: resolved.modelId,
						},
						baseMessages,
					);
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					notifyError(message);
					setAskError(message);
				}
			})();
		},
		[sendToThread, resolvePdfAskAgent],
	);

	const dismissAskChrome = useCallback(() => {
		if (activeSessionRef.current) {
			void cancelAgentRun(activeSessionRef.current).catch(() => undefined);
			activeSessionRef.current = null;
		}
		setStreaming(false);
		setAskError(null);
		if (activeCardRef.current?.kind === "ask") {
			setActiveCard(null);
			setCardScreen(null);
		}
	}, []);

	const handleHide = useCallback(() => {
		const id =
			activeCardRef.current?.kind === "ask" ? activeCardRef.current.id : null;
		if (id) {
			const thread = threadsRef.current.find((th) => th.id === id);
			if (thread) {
				if (!threadHasUserQuestion(thread)) {
					setThreads((prev) => prev.filter((t) => t.id !== thread.id));
				} else if (thread.status !== "ended") {
					const ended: PdfAskThread = {
						...thread,
						status: "ended",
						updatedAt: new Date().toISOString(),
					};
					upsertThread(ended);
					void persist(ended);
				}
			}
		}
		dismissAskChrome();
	}, [upsertThread, persist, dismissAskChrome]);

	const handleDelete = useCallback(() => {
		const id =
			activeCardRef.current?.kind === "ask" ? activeCardRef.current.id : null;
		if (id) {
			setThreads((prev) => prev.filter((th) => th.id !== id));
			if (paperAbsPath) void deletePdfAskThread(paperAbsPath, id);
		}
		dismissAskChrome();
	}, [paperAbsPath, dismissAskChrome]);

	const deleteTranslateCard = useCallback(() => {
		const id =
			activeCardRef.current?.kind === "translate"
				? activeCardRef.current.id
				: null;
		stopTranslateSession();
		if (id) {
			setTranslates((prev) => prev.filter((r) => r.id !== id));
			if (paperAbsPath) void deletePdfTranslate(paperAbsPath, id);
		}
		hideActiveCard();
	}, [paperAbsPath, stopTranslateSession, hideActiveCard]);

	const deleteVisualTraceById = useCallback(
		(id: string) => {
			setVisualTraces((prev) => prev.filter((tr) => tr.id !== id));
			if (paperAbsPath) void deletePdfVisualTrace(paperAbsPath, id);
			if (
				isVisualMarkKind(activeCardRef.current?.kind) &&
				activeCardRef.current.id === id
			) {
				hideActiveCard();
			}
		},
		[paperAbsPath, hideActiveCard],
	);

	const handleDeleteVisualTrace = useCallback(() => {
		const id = isVisualMarkKind(activeCardRef.current?.kind)
			? activeCardRef.current.id
			: null;
		if (id) deleteVisualTraceById(id);
		else hideActiveCard();
	}, [deleteVisualTraceById, hideActiveCard]);

	const openVisualTraceSession = useCallback(
		async (trace: PdfVisualSessionTrace) => {
			// Note-only marks have no Agent session yet — stay on the pin card.
			if (!trace.agent) return;
			// Same session as the pin modal — activate it in the shared store.
			setAgentPanelMounted(true);
			const store = agentSessionStore.getState();
			const existing =
				store.findByVisualTraceId(trace.id) ||
				(trace.agent.providerSessionId
					? store.findByProviderSessionId(trace.agent.providerSessionId)
					: undefined);
			if (existing) {
				store.setActiveTabId(existing.id);
				store.setLines(existing.lines);
			} else {
				// Seed from mark once so sidebar opens the same transcript.
				const messages = traceMessages(trace);
				const image = await loadPdfVisualTraceImage(
					paperAbsPath ?? "",
					trace.image,
				);
				const title =
					messages.find((m) => m.role === "user")?.content.trim() ||
					trace.comment.trim() ||
					t("pdfExplain.visualAnnotation");
				const agentId =
					trace.agent.agentId === "pending" ? "" : trace.agent.agentId;
				requestOpenAgentSession({
					agentId,
					runtimeSessionId: trace.agent.runtimeSessionId,
					providerSessionId: trace.agent.providerSessionId,
					messageId: trace.agent.messageId,
					title,
					prompt: title,
					answerSnapshot: trace.agent.answerSnapshot,
					paperAbsPath: paperAbsPath ?? undefined,
					visualTrace: {
						traceId: trace.id,
						page: trace.page,
						comment: trace.comment,
						paperPath: trace.paperPath,
						...(image ? { image } : {}),
						messages: messages.map((m) => ({ ...m })),
						status: trace.agent.status,
					},
				});
			}
			openRightTab("agent");
			hideActiveCard();
		},
		[hideActiveCard, paperAbsPath, t],
	);

	/** Stable callbacks so VisualTraceCard memo can skip PdfViewer re-renders. */
	const handleOpenActiveVisualSession = useCallback(() => {
		const card = activeCardRef.current;
		if (!isVisualMarkKind(card?.kind)) return;
		const tr = visualTracesRef.current.find((item) => item.id === card.id);
		if (tr) void openVisualTraceSession(tr);
	}, [openVisualTraceSession]);

	const handleStopVisualSession = useCallback(() => {
		// Shared agent session store is the source of truth after modal↔panel
		// unification. visualSessionRef is legacy and may be null for turns
		// that went through requestTurn → panel send.
		const store = agentSessionStore.getState();
		const card = activeCardRef.current;
		const traceId = isVisualMarkKind(card?.kind) ? card.id : null;
		const bound = traceId ? store.findByVisualTraceId(traceId) : undefined;
		const sid =
			visualSessionRef.current ||
			bound?.id ||
			(store.submitting && store.activeTabId !== "draft"
				? store.activeTabId
				: null);
		if (sid && sid !== "draft") {
			void cancelAgentRun(sid).catch(() => undefined);
			store.setSessions((prev) =>
				prev.map((item) =>
					item.id === sid && item.status === "running"
						? { ...item, status: "cancelled" }
						: item,
				),
			);
		}
		// Also clear any other visual-bound sessions stuck as running (e.g.
		// after an ErrorBoundary crash mid-stream).
		if (traceId) {
			store.setSessions((prev) =>
				prev.map((item) =>
					"visualTraceId" in item &&
					(item as { visualTraceId?: string }).visualTraceId === traceId &&
					item.status === "running"
						? { ...item, status: "cancelled" }
						: item,
				),
			);
		}
		store.setSubmitting(false);
		visualSessionRef.current = null;
		setVisualStreaming(false);
		setVisualError(null);
	}, []);

	const openEditorForAnnotation = useCallback(
		(id: string) => {
			const obj = annotationCap
				?.forDocument(docId)
				.getAnnotationById(id)?.object;
			if (!obj || !isHighlightObject(obj)) return;
			const pageEl = pageElByIndex(hostRef.current, obj.pageIndex);
			if (!pageEl) return;
			// Same sticky-hover contract as openCard — pin leave must not close
			// the note editor while the user is moving onto / into the modal.
			cancelHoverHide();
			cardHoverSurfaceRef.current = true;
			setEditor({
				screen: rectRightScreen(pageEl, obj.rect, zoomRef.current),
				pageIndex: obj.pageIndex,
				id,
				quote: ((obj.custom ?? {}) as { quote?: string }).quote?.trim() ?? "",
				comment: obj.contents?.trim() ?? "",
			});
		},
		[annotationCap, docId, cancelHoverHide],
	);

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
		[upsertThread, openThread, openCard, openEditorForAnnotation],
	);

	// ---- Selection action menu ----

	const closeSelectionMenu = useCallback(() => {
		setSelectionMenu(null);
		selectionCap?.clear(docId);
	}, [selectionCap, docId]);

	const createHighlights = useCallback(
		(pages: FormattedSelection[], color: HighlightColor, quote: string) => {
			const scope = annotationCap?.forDocument(docId);
			if (!scope) return [] as { pageIndex: number; id: string }[];
			const created: { pageIndex: number; id: string }[] = [];
			for (const page of pages) {
				const id = crypto.randomUUID();
				const obj: PdfHighlightAnnoObject = {
					type: PdfAnnotationSubtype.HIGHLIGHT,
					id,
					pageIndex: page.pageIndex,
					rect: page.rect,
					segmentRects: page.segmentRects,
					strokeColor: HIGHLIGHT_HEX[color],
					opacity: HIGHLIGHT_OPACITY,
					created: new Date(),
					custom: { app: "agentero", paletteKey: color, quote },
				};
				scope.createAnnotation(page.pageIndex, obj);
				created.push({ pageIndex: page.pageIndex, id });
			}
			return created;
		},
		[annotationCap, docId],
	);

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
					quote,
					comment: "",
				});
			}
		}
	}, [selectionMenu, createHighlights, selectionCap, docId]);

	const handleCopy = useCallback(() => {
		selectionCap?.copyToClipboard(docId);
	}, [selectionCap, docId]);

	const handleMenuAsk = useCallback(() => {
		if (!selectionMenu) return;
		const anchor = selectionMenu.anchor;
		setSelectionMenu(null);
		selectionCap?.clear(docId);
		startFromAnchor(anchor);
	}, [selectionMenu, startFromAnchor, selectionCap, docId]);

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
	}, [selectionMenu, selectionCap, docId, paperRelPath, paperAbsPath]);

	const handleMenuTranslate = useCallback(() => {
		if (!selectionMenu) return;
		const anchor = selectionMenu.anchor;
		const quote = anchor.quote?.trim();
		setSelectionMenu(null);
		selectionCap?.clear(docId);
		if (!quote) return;
		stopTranslateSession();
		const paperPath = paperRelPath || paperAbsPath || "paper";
		const rec = createTranslateRecord({
			paperPath,
			page: anchor.page,
			rects: anchor.rects,
			quote,
		});
		upsertTranslate(rec);
		// Menu action is not a hover surface; card auto-hides after result.
		cardHoverSurfaceRef.current = false;
		openCard({ kind: "translate", id: rec.id });
		translateStreamingRef.current = true;
		setTranslateStreaming(true);
		setTranslateError(null);

		const { providerId, targetLangName } = prepareTranslateTask({
			text: quote,
			context: { page: anchor.page, surface: "pdf-selection" },
		});

		if (providerId === "agent") {
			const prompt = buildTranslatePrompt({
				text: quote,
				targetLangName,
				page: anchor.page,
				surface: "pdf-selection",
			});
			void (async () => {
				try {
					const registry = await listAgents().catch(() => null);
					const resolved = resolveTranslateAgent(
						loadSettings().translate,
						registry,
					);
					if (!resolved.agentId) {
						const msg = t("selection.translateNoAgent");
						notifyError(msg);
						markTranslateFailure(rec.id, msg);
						return;
					}
					const accepted = await runOnce({
						prompt,
						agentId: resolved.agentId,
						modelId: resolved.modelId,
						vaultPath: vaultPath ?? undefined,
						workflow: "free",
						autoApprove: true,
						hideFromChatHistory: true,
					});
					const sessionId = accepted.sessionId;
					translateSessionRef.current = sessionId;
					activeSessionRef.current = sessionId;
					const unsubs: UnlistenFn[] = [];
					const cleanup = () => {
						for (const u of unsubs) u();
						if (translateSessionRef.current === sessionId)
							translateSessionRef.current = null;
						if (activeSessionRef.current === sessionId)
							activeSessionRef.current = null;
						translateStreamingRef.current = false;
						setTranslateStreaming(false);
					};
					unsubs.push(
						await listenAgentStream((ev) => {
							if (ev.sessionId !== sessionId) return;
							if ((ev.kind ?? "message") === "thought") return;
							const latest =
								translatesRef.current.find((r) => r.id === rec.id) ?? rec;
							upsertTranslate({
								...latest,
								result: (latest.result ?? "") + ev.chunk,
								updatedAt: new Date().toISOString(),
								error: undefined,
							});
						}),
					);
					unsubs.push(
						await listenAgentCompleted((ev) => {
							if (ev.sessionId !== sessionId) return;
							const latest =
								translatesRef.current.find((r) => r.id === rec.id) ?? rec;
							const next = {
								...latest,
								result: (ev.content || latest.result || "").trim(),
								updatedAt: new Date().toISOString(),
								error: undefined,
							};
							upsertTranslate(next);
							void persistTranslate(next);
							setTranslateError(null);
							cleanup();
						}),
					);
					unsubs.push(
						await listenAgentFailed((ev) => {
							if (ev.sessionId !== sessionId) return;
							const msg = ev.error || t("pdfAsk.agentFailed");
							notifyError(msg);
							markTranslateFailure(rec.id, msg);
							cleanup();
						}),
					);
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					notifyError(message);
					markTranslateFailure(rec.id, message);
				}
			})();
			return;
		}

		void (async () => {
			try {
				const result = await runTranslate(
					{
						text: quote,
						context: { page: anchor.page, surface: "pdf-selection" },
					},
					{ providerId },
				);
				const latest =
					translatesRef.current.find((r) => r.id === rec.id) ?? rec;
				const next = {
					...latest,
					result: result.trim(),
					updatedAt: new Date().toISOString(),
					error: undefined,
				};
				upsertTranslate(next);
				void persistTranslate(next);
				translateStreamingRef.current = false;
				setTranslateStreaming(false);
				setTranslateError(null);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				notifyError(message);
				markTranslateFailure(rec.id, message);
			}
		})();
	}, [
		selectionMenu,
		selectionCap,
		docId,
		t,
		vaultPath,
		paperAbsPath,
		paperRelPath,
		stopTranslateSession,
		upsertTranslate,
		persistTranslate,
		markTranslateFailure,
		openCard,
	]);

	// Show the selection action menu when a drag-selection ends.
	useEffect(() => {
		if (!selectionCap || !docCap) return;
		const scope = selectionCap.forDocument(docId);
		const offEnd = scope.onEndSelection(() => {
			const pages = selectionCap.getFormattedSelection(docId);
			if (!pages.length) {
				setSelectionMenu(null);
				return;
			}
			const first = pages[0];
			const pageEl = pageElByIndex(hostRef.current, first.pageIndex);
			if (!pageEl) return;
			const screen = rectTopCenterScreen(pageEl, first.rect, zoomRef.current);
			void (async () => {
				let quote = "";
				try {
					const lines = await selectionCap.getSelectedText(docId).toPromise();
					quote = (lines ?? []).join(" ").replace(/\s+/g, " ").trim();
				} catch {
					// text extraction is best-effort
				}
				const doc = docCap.getDocument(docId);
				const anchor = anchorFromEmbedSelection(
					pages,
					quote,
					(pageIndex) => doc?.pages[pageIndex]?.size ?? null,
				);
				if (!anchor) return;
				setSelectionMenu({ screen, anchor, pages });
				publishSelection({
					text: quote,
					sourcePath: paperRelPath ?? paperAbsPath ?? "PDF",
					origin: "pdf",
					page: anchor.page,
					rects: anchor.rects,
					paperAbsPath: paperAbsPath ?? undefined,
				});
			})();
		});
		const offChange = scope.onSelectionChange((sel) => {
			if (!sel) {
				setSelectionMenu(null);
				clearActiveSelection("pdf");
			}
		});
		return () => {
			offEnd();
			offChange();
			clearActiveSelection("pdf");
		};
	}, [selectionCap, docCap, docId, paperRelPath, paperAbsPath]);

	const rePlaceActiveCardOnScroll = useCallback(() => {
		if (activeCardRef.current) placeActiveCard(activeCardRef.current);
	}, [placeActiveCard]);

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

	// Run a debounced full-document search as the query changes.
	useEffect(() => {
		if (!search) return;
		const q = findQuery.trim();
		if (!q) {
			search.stopSearch();
			return;
		}
		const id = setTimeout(() => {
			void search.searchAllPages(q);
		}, 250);
		return () => clearTimeout(id);
	}, [findQuery, search]);

	// Load the document outline (bookmarks / TOC) once available.
	useEffect(() => {
		if (!bookmarkCap || totalPages <= 0) return;
		let cancelled = false;
		void bookmarkCap
			.forDocument(docId)
			.getBookmarks()
			.toPromise()
			.then((res) => {
				if (cancelled) return;
				const bookmarks = res?.bookmarks ?? [];
				setOutline(bookmarks);
				// Share with annotation embeds for location breadcrumbs.
				const paperKey = paperAbsPath || paperRelPath;
				if (paperKey) setPaperOutline(paperKey, bookmarks);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [bookmarkCap, docId, totalPages, paperAbsPath, paperRelPath]);

	// Cmd/Ctrl+F opens the in-document find bar when the PDF host is focused.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const onKey = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
			if (!host.matches(":hover") && !host.contains(document.activeElement))
				return;
			e.preventDefault();
			setFindOpen(true);
			search?.startSearch();
			setTimeout(() => findInputRef.current?.focus(), 0);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [search]);

	const saveEditor = useCallback(
		(text: string) => {
			if (!editor) return;
			annotationCap
				?.forDocument(docId)
				.updateAnnotation(editor.pageIndex, editor.id, {
					contents: text.trim() || undefined,
				});
			setEditor(null);
		},
		[editor, annotationCap, docId],
	);

	/** Header delete on the text annotation editor — remove highlight and close. */
	const deleteEditorAnnotation = useCallback(() => {
		if (!editor) return;
		annotationCap
			?.forDocument(docId)
			.deleteAnnotation(editor.pageIndex, editor.id);
		setEditor(null);
	}, [editor, annotationCap, docId]);

	/**
	 * Run layout analysis for this document.
	 * - force: re-run PP-DocLayoutV3 (PDF→JSON) even when source/layout.json exists
	 * - without force: prefer layout.json → merge → sidebar when paper has a sidecar
	 * - openFigures / showOverlay: UI side-effects for the manual Figures button
	 * - asBackgroundTask: surface progress in the IDE background-tasks panel
	 */
	const startLayoutAnalysis = useCallback(
		(opts?: {
			force?: boolean;
			/** "manual" resets the crash guard; automatic runs back off after crashes. */
			trigger?: "auto" | "manual";
			openFigures?: boolean;
			showOverlay?: boolean;
			asBackgroundTask?: boolean;
			/** When false, skip notifyError (auto-run uses the tasks panel). */
			notifyOnError?: boolean;
		}) => {
			const la = layoutCapRef.current?.forDocument(docId);
			if (!la) {
				if (opts?.notifyOnError !== false) {
					notifyError(t("pdf.layout.unavailable"));
				}
				return;
			}
			layoutTaskRef.current?.abort({
				type: "no-document",
				message: "superseded",
			});
			const pages = totalPagesRef.current;
			const paperLabel =
				paperRelPath || paperAbsPath?.split(/[/\\]/).pop() || docId;

			const runCore = (hooks?: { signal?: AbortSignal }) =>
				new Promise<void>((resolve, reject) => {
					let settled = false;
					const finish = (fn: () => void) => {
						if (settled) return;
						settled = true;
						hooks?.signal?.removeEventListener("abort", onAbort);
						fn();
					};
					const onAbort = () => {
						layoutTaskRef.current?.abort({
							type: "no-document",
							message: "cancelled",
						});
						layoutTaskRef.current = null;
						finish(() => reject(new BackgroundTaskCancelledError()));
					};
					if (hooks?.signal?.aborted) {
						onAbort();
						return;
					}
					hooks?.signal?.addEventListener("abort", onAbort);

					void runDocumentLayoutAnalysis(la, docId, {
						paperAbsPath,
						totalPages: pages > 0 ? pages : null,
						force: opts?.force === true,
						trigger: opts?.trigger,
						onDone: () => {
							layoutTaskRef.current = null;
							if (opts?.showOverlay) {
								setLayoutOverlayVisible(docId, true);
							}
							if (opts?.openFigures) {
								void import("@/lib/shell/ui-store").then(({ openRightTab }) =>
									openRightTab("figures"),
								);
							}
							finish(() => resolve());
						},
						onError: (message, aborted) => {
							layoutTaskRef.current = null;
							finish(() => {
								if (aborted) {
									reject(new BackgroundTaskCancelledError());
									return;
								}
								reject(new Error(message));
							});
						},
					})
						.then((task) => {
							layoutTaskRef.current = task;
							// Cache hit resolves via onDone before returning null.
							if (task == null && !settled) {
								// onDone should have run; if not, resolve to avoid hang.
								finish(() => resolve());
							}
						})
						.catch((e) => {
							layoutTaskRef.current = null;
							finish(() =>
								reject(e instanceof Error ? e : new Error(String(e))),
							);
						});
				});

			if (opts?.asBackgroundTask) {
				void enqueueBackgroundTask(
					{
						kind: "parse",
						title: i18n.t("app:tasks.layoutAnalysis"),
						detail: paperLabel,
					},
					async ({ setProgress, setDetail, signal }) => {
						/**
						 * Mirror layoutAnalysisStore.ui — same overall % and copy as the
						 * Figures sidebar (message + page/total or pct), not per-page stages.
						 */
						const syncFromLayoutUi = () => {
							const { ui, activeDocumentId } = layoutAnalysisStore.getState();
							if (activeDocumentId != null && activeDocumentId !== docId) {
								return;
							}
							if (ui.stage !== "running") return;

							if (typeof ui.progress === "number") {
								setProgress(ui.progress);
							}

							const page =
								typeof ui.page === "number" && ui.page > 0
									? ui.page
									: typeof ui.completed === "number"
										? ui.completed
										: null;
							const total =
								typeof ui.total === "number" && ui.total > 0 ? ui.total : null;
							const message = ui.message?.trim() || t("figures.analyzing");
							const pageLine =
								total != null && page != null
									? t("figures.progressPages", { page, total })
									: typeof ui.progress === "number"
										? t("figures.progressPct", {
												pct: Math.round(ui.progress),
											})
										: null;
							setDetail(pageLine ? `${message} · ${pageLine}` : message);
						};

						setProgress(0);
						setDetail(t("pdf.layout.preparingModel"));
						const unsub = layoutAnalysisStore.subscribe(syncFromLayoutUi);
						syncFromLayoutUi();
						try {
							await runCore({ signal });
						} finally {
							unsub();
						}
					},
				).catch((e) => {
					if (isBackgroundTaskCancelledError(e)) return;
					if (opts?.notifyOnError !== false) {
						const message = e instanceof Error ? e.message : String(e);
						notifyError(t("pdf.layout.failed"), { description: message });
					}
				});
				return;
			}

			void runCore().catch((e) => {
				if (isBackgroundTaskCancelledError(e)) return;
				if (opts?.notifyOnError === false) return;
				const message = e instanceof Error ? e.message : String(e);
				notifyError(t("pdf.layout.failed"), { description: message });
			});
		},
		[docId, paperAbsPath, paperRelPath, t],
	);

	// Any open paper (active or not) → headless queue so multi-tab can all
	// land in the background-tasks panel. ONNX still serial (concurrency:1).
	useEffect(() => {
		if (!paperAbsPath) return;
		enqueuePaperLayoutAnalysis({
			paperAbsPath,
			paperLabel: paperRelPath || undefined,
		});
	}, [paperAbsPath, paperRelPath]);

	// Active viewer: pull layout into the tab store once sidecar exists.
	// Headless may still be writing it for this paper (or a sibling tab);
	// poll until ready. Loose PDFs (no paper folder) still analyze in-viewer.
	const layoutAutoStartedForDocRef = useRef<string | null>(null);
	useEffect(() => {
		if (!isActive) return;
		if (!layoutCap || totalPages <= 0) return;
		if (getLayoutDocumentResult(docId)) return;
		if (!layoutCap.forDocument(docId)) return;

		let cancelled = false;
		let pollTimer: ReturnType<typeof setTimeout> | null = null;
		/** Stop polling after ~15 min so a permanent headless failure does not spin. */
		const pollDeadline = Date.now() + 15 * 60 * 1000;

		const clearPoll = () => {
			if (pollTimer != null) {
				clearTimeout(pollTimer);
				pollTimer = null;
			}
		};

		const loadSilent = () => {
			if (layoutAutoStartedForDocRef.current === docId) return;
			layoutAutoStartedForDocRef.current = docId;
			startLayoutAnalysis({
				force: false,
				openFigures: false,
				showOverlay: false,
				asBackgroundTask: false,
				notifyOnError: false,
			});
		};

		const tryLoad = async () => {
			if (cancelled) return;
			if (getLayoutDocumentResult(docId)) return;

			try {
				if (paperAbsPath) {
					const hasSidecar = Boolean(await readLayoutSidecar(paperAbsPath));
					if (cancelled) return;
					if (getLayoutDocumentResult(docId)) return;
					if (hasSidecar) {
						loadSilent();
						return;
					}
					// Sidecar not ready yet — headless job may be queued/running.
					if (Date.now() < pollDeadline) {
						pollTimer = setTimeout(() => {
							void tryLoad();
						}, 1500);
					} else if (layoutAutoStartedForDocRef.current === docId) {
						layoutAutoStartedForDocRef.current = null;
					}
					return;
				}

				// No paper folder (loose PDF): only the active tab can run in-viewer.
				if (layoutAutoStartedForDocRef.current === docId) return;
				layoutAutoStartedForDocRef.current = docId;
				startLayoutAnalysis({
					force: false,
					openFigures: false,
					showOverlay: false,
					asBackgroundTask: true,
					notifyOnError: false,
				});
			} catch {
				if (layoutAutoStartedForDocRef.current === docId) {
					layoutAutoStartedForDocRef.current = null;
				}
				if (!cancelled && paperAbsPath && Date.now() < pollDeadline) {
					pollTimer = setTimeout(() => {
						void tryLoad();
					}, 2500);
				}
			}
		};

		void tryLoad();

		return () => {
			cancelled = true;
			clearPoll();
			// Strict-mode remount / leave tab before result: allow retry on re-activate.
			if (!getLayoutDocumentResult(docId)) {
				layoutAutoStartedForDocRef.current = null;
			}
		};
	}, [
		isActive,
		layoutCap,
		docId,
		totalPages,
		paperAbsPath,
		startLayoutAnalysis,
	]);

	// Register the imperative handle for the annotations panel.
	// Parent often passes an inline onHandle; keep it in a ref. Read scroll via
	// scrollRef so EmbedPDF's fresh scope object does not re-register every paint.
	const onHandleRef = useRef(onHandle);
	onHandleRef.current = onHandle;
	const startLayoutAnalysisRef = useRef(startLayoutAnalysis);
	startLayoutAnalysisRef.current = startLayoutAnalysis;
	useEffect(() => {
		const register = onHandleRef.current;
		if (!register) return;
		const handle: PdfViewerHandle = {
			getHighlights: () => highlightsRef.current,
			scrollToHighlight: (id) => {
				const obj = annotationCap
					?.forDocument(docId)
					.getAnnotationById(id)?.object;
				if (!obj || !isHighlightObject(obj)) return;
				// Instant: smooth jumps across distant pages feel like slow render.
				scrollRef.current?.scrollToPage({
					pageNumber: obj.pageIndex + 1,
					behavior: "instant",
				});
				annotationCap?.forDocument(docId).selectAnnotation(obj.pageIndex, id);
			},
			editComment: (id) => openEditorForAnnotation(id),
			deleteHighlight: (id) => {
				const obj = annotationCap
					?.forDocument(docId)
					.getAnnotationById(id)?.object;
				if (obj && isHighlightObject(obj))
					annotationCap?.forDocument(docId).deleteAnnotation(obj.pageIndex, id);
			},
			scrollToAsk: (id) => {
				const thread = threadsRef.current.find((th) => th.id === id);
				if (!thread) return;
				scrollRef.current?.scrollToPage({
					pageNumber: thread.anchor.page,
					behavior: "instant",
				});
				// openThread → openCard places after page mount (retry if virtualized).
				openThread({ ...thread, status: "open" });
			},
			deleteAsk: (id) => {
				setThreads((prev) => prev.filter((th) => th.id !== id));
				if (paperAbsPath) void deletePdfAskThread(paperAbsPath, id);
			},
			scrollToVisualTrace: (id) => {
				const tr = visualTracesRef.current.find((item) => item.id === id);
				if (!tr) return;
				scrollRef.current?.scrollToPage({
					pageNumber: tr.page,
					behavior: "instant",
				});
				openCard({ kind: "visual", id: tr.id });
			},
			deleteVisualTrace: (id) => {
				deleteVisualTraceById(id);
			},
			toggleVisualAnnotation: () => {
				if (visualCropPending) return;
				setSelectionMenu(null);
				closeVisualDraftEditor();
				selectionCap?.clear(docId);
				setRegionSelecting((active) => !active);
			},
			analyzeLayout: () => {
				// Prefer source/layout.json → merge → sidebar. Full ONNX (PDF→JSON)
				// only when there is no sidecar (or force is set elsewhere).
				startLayoutAnalysisRef.current({
					force: false,
					trigger: "manual",
					openFigures: true,
					showOverlay: true,
					asBackgroundTask: true,
					notifyOnError: true,
				});
			},
			scrollToLayoutRegion: (region) => {
				scrollRef.current?.scrollToPage({
					pageNumber: region.pageIndex + 1,
					behavior: "instant",
				});
				setFocusedLayoutRegion(docId, region.id);
			},
			renderRegion: async ({ pageIndex, bbox, maxEdgePx }) => {
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
						pageIndex,
						region: bbox,
						maxEdgePx: maxEdgePx ?? 360,
					});
					if (!docs.isDocumentOpen(docId)) return null;
					return image;
				} catch {
					return null;
				}
			},
		};
		register(handle);
		return () => {
			layoutTaskRef.current?.abort({
				type: "no-document",
				message: "unmount",
			});
			layoutTaskRef.current = null;
			register(null);
		};
	}, [
		annotationCap,
		docId,
		paperAbsPath,
		openEditorForAnnotation,
		openThread,
		openCard,
		deleteVisualTraceById,
		selectionCap,
		visualCropPending,
		closeVisualDraftEditor,
	]);

	// Keep the page-number input in sync with the observed current page.
	useEffect(() => {
		if (!pageFocusedRef.current) setPageField(String(currentPage));
	}, [currentPage]);

	// On first load: record page count (reading heatmap) and restore last page.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrollReady waits for EmbedPDF scope
	useEffect(() => {
		const scrollScope = scrollRef.current;
		if (restoredRef.current || totalPages <= 0 || !scrollScope) return;
		restoredRef.current = true;
		if (paperKey) {
			const saved = readReadingPage(paperKey);
			if (saved && saved > 1 && saved <= totalPages) {
				scrollScope.scrollToPage({
					pageNumber: saved,
					behavior: "instant",
				});
			}
		}
	}, [totalPages, scrollReady, paperAbsPath, paperKey]);

	// Persist the last read page (debounced) as the user scrolls.
	useEffect(() => {
		if (!paperKey || !restoredRef.current || currentPage < 1) return;
		const id = setTimeout(() => {
			writeReadingPage(paperKey, currentPage);
		}, 400);
		return () => clearTimeout(id);
	}, [paperKey, currentPage]);

	const scrollToResult = (idx: number) => {
		const r = searchState.results[idx];
		if (r && scroll)
			scroll.scrollToPage({
				pageNumber: r.pageIndex + 1,
				behavior: "instant",
			});
	};

	const closeFind = () => {
		setFindOpen(false);
		setFindQuery("");
		search?.stopSearch();
	};

	const goToPage = (n: number) => {
		if (!scroll || totalPages <= 0) return;
		const clamped = Math.min(totalPages, Math.max(1, Math.floor(n)));
		scroll.scrollToPage({ pageNumber: clamped, behavior: "instant" });
	};

	const commitPageField = () => {
		const n = Number.parseInt(pageField, 10);
		if (Number.isFinite(n)) goToPage(n);
		else setPageField(String(currentPage));
	};

	// ---- In-text citation / internal PDF links ----

	const resolveLinkText = useLinkTextResolver(docId);
	const linkHoverSeqRef = useRef(0);

	const cancelCitationHide = useCallback(() => {
		if (!citationHideTimerRef.current) return;
		clearTimeout(citationHideTimerRef.current);
		citationHideTimerRef.current = null;
	}, []);

	const scheduleCitationHide = useCallback(() => {
		cancelCitationHide();
		citationHideTimerRef.current = setTimeout(() => {
			citationHideTimerRef.current = null;
			setCitationPreview(null);
		}, 250);
	}, [cancelCitationHide]);

	/** GoTo/destination → smooth scroll (annotation plugin); URI → browser. */
	const handleCitationLinkActivate = useCallback(
		(link: PdfLinkAnnoObject) => {
			const target = link.target;
			if (!target || !annotationCap) return;
			annotationCap
				.navigateTarget(target, docId)
				.toPromise()
				.then((result) => {
					if (result.outcome === "uri") openExternalUrl(result.uri);
				})
				.catch(() => {});
		},
		[annotationCap, docId],
	);

	const handleCitationLinkHover = useCallback(
		(link: PdfLinkAnnoObject | null) => {
			const seq = ++linkHoverSeqRef.current;
			if (!link) {
				clearCitationHover(docId);
				scheduleCitationHide();
				return;
			}
			cancelCitationHide();
			setCitationPreview(null);
			void resolveLinkText(link).then((text) => {
				if (linkHoverSeqRef.current !== seq || !text) return;
				if (!looksLikeCitationMarker(text)) {
					clearCitationHover(docId);
					return;
				}
				setCitationHover(docId, text);
				const citationId = matchCitationByMarker(citations, text);
				const citation =
					citations.find((item) => item.id === citationId) ?? null;
				const pageEl = pageElByIndex(hostRef.current, link.pageIndex);
				if (!pageEl) return;
				setCitationPreview({
					screen: rectRightScreen(pageEl, link.rect, zoomRef.current),
					marker: text,
					citation,
				});
			});
		},
		[
			docId,
			resolveLinkText,
			citations,
			scheduleCitationHide,
			cancelCitationHide,
		],
	);

	useEffect(
		() => () => {
			clearCitationHover(docId);
			if (citationHideTimerRef.current) {
				clearTimeout(citationHideTimerRef.current);
			}
		},
		[docId],
	);

	const handleVisualRegionSelect = useCallback(
		(page: number, region: PdfAskNormalizedRect) => {
			void beginVisualAnnotation(page, region);
		},
		[beginVisualAnnotation],
	);

	useEffect(() => {
		if (!regionSelecting) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setRegionSelecting(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [regionSelecting]);

	// Region-select mode must not allow EmbedPDF text selection under the marquee.
	useEffect(() => {
		if (!regionSelecting) return;
		setSelectionMenu(null);
		selectionCap?.clear(docId);
		const scope = interactionCap?.forDocument(docId);
		scope?.pause();
		return () => {
			scope?.resume();
		};
	}, [regionSelecting, selectionCap, interactionCap, docId]);

	/**
	 * Page renderer for the Scroller. Memoized so plain scroll/zoom re-renders
	 * (which only change `currentPage`/`zoomLevel`) keep a stable callback
	 * identity and avoid re-running the per-page pin/filter work.
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
		}) => {
			const pageNumber = pageIndex + 1;
			const pageText = pageTextMap.get(pageIndex);
			const activeAskOnPage =
				activeThread?.anchor.page === pageNumber ? activeThread : null;
			const activeTranslateOnPage =
				activeTranslate?.page === pageNumber ? activeTranslate : null;
			const activeVisualOnPage =
				activeVisualTrace?.page === pageNumber ? activeVisualTrace : null;
			const visualDraftRegionOnPage =
				visualDraftRegion?.page === pageNumber
					? visualDraftRegion.region
					: null;
			const formulaAnnotationRegionOnPage =
				formulaAnnotationRegion?.page === pageNumber
					? formulaAnnotationRegion.region
					: null;
			const focusedLayoutOnPage =
				focusedLayoutRegion?.pageIndex === pageIndex
					? focusedLayoutRegion
					: null;
			const pins: SelectionPin[] = [
				...highlights
					.filter(
						(highlight) =>
							highlight.page === pageNumber &&
							Boolean(highlight.comment?.trim()),
					)
					.flatMap((highlight): SelectionPin[] => {
						const obj = annotationCap
							?.forDocument(docId)
							.getAnnotationById(highlight.id)?.object;
						if (!obj || !isHighlightObject(obj)) return [];
						const pageWidth = width / zoomRef.current;
						const pageHeight = height / zoomRef.current;
						if (pageWidth <= 0 || pageHeight <= 0) return [];
						const normRect = {
							x: obj.rect.origin.x / pageWidth,
							y: obj.rect.origin.y / pageHeight,
							w: obj.rect.size.width / pageWidth,
							h: obj.rect.size.height / pageHeight,
						};
						const pin = pinFromRects([normRect], pageText);
						return [
							{
								id: highlight.id,
								kind: "annotate",
								x: pin.x,
								y: pin.y,
								preview: highlight.comment?.trim() ?? highlight.id,
								overText: pinObscuresBodyText(pin, pageText),
								side: pin.side,
							},
						];
					}),
				...askSummaries
					.filter((s) => s.page === pageNumber)
					.map((s): SelectionPin => {
						const thread = threads.find((th) => th.id === s.id);
						const pin = thread
							? pinFromRects(thread.anchor.rects, pageText)
							: { x: s.x, y: s.y, side: "right" as const };
						return {
							id: s.id,
							kind: "ask",
							x: pin.x,
							y: pin.y,
							preview: s.preview,
							ended: s.status === "ended",
							overText: pinObscuresBodyText(pin, pageText),
							side: pin.side,
						};
					}),
				...translates
					.filter((tr) => tr.page === pageNumber && !tr.error)
					.map((tr): SelectionPin => {
						const pin = pinFromRects(tr.rects, pageText);
						return {
							id: tr.id,
							kind: "translate",
							x: pin.x,
							y: pin.y,
							preview: tr.result?.trim() || tr.quote?.trim() || tr.id,
							overText: pinObscuresBodyText(pin, pageText),
							side: pin.side,
						};
					}),
				...visualTraces
					.filter((tr) => tr.page === pageNumber)
					.map((tr): SelectionPin => {
						const pin = pinFromRects(tr.rects, pageText);
						return {
							id: tr.id,
							kind: "visual",
							x: pin.x,
							y: pin.y,
							preview: tracePreview(tr),
							ended: tr.agent?.status !== "running",
							traceId: tr.id,
							overText: pinObscuresBodyText(pin, pageText),
							side: pin.side,
						};
					}),
			];
			// Page shell: paper-white in light mode; near-black when PDF dark mode is on
			// so loading gaps match inverted page rasters.
			return (
				<div
					className={cn(
						"relative overflow-hidden rounded-sm shadow-sm ring-1",
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
						style={{ position: "absolute", inset: 0 }}
					/>
					<TilingLayer
						documentId={docId}
						pageIndex={pageIndex}
						dpr={pdfRasterDpr()}
						className={pdfDark ? PDF_PAGE_RASTER_DARK_CLASS : undefined}
						style={{ position: "absolute", inset: 0 }}
					/>
					<SearchLayer
						documentId={docId}
						pageIndex={pageIndex}
						style={{ position: "absolute", inset: 0 }}
					/>
					{/*
					 * EmbedPDF raw bbox layer — kept mounted for plugin state, but
					 * visibility is forced off (see effect). Store-backed boxes below.
					 */}
					<LayoutAnalysisLayer
						documentId={docId}
						pageIndex={pageIndex}
						style={{ position: "absolute", inset: 0 }}
					/>
					<PagePointerProvider
						documentId={docId}
						pageIndex={pageIndex}
						style={{ position: "absolute", inset: 0 }}
					>
						{/* Unmount text selection while framing a visual region. */}
						{regionSelecting ? null : (
							<SelectionLayer documentId={docId} pageIndex={pageIndex} />
						)}
						<AnnotationLayer documentId={docId} pageIndex={pageIndex} />
						<CitationLinkLayer
							links={citationLinks.get(pageIndex) ?? []}
							pageWidthPt={width / zoomRef.current}
							pageHeightPt={height / zoomRef.current}
							label={t("pdf.linkAria")}
							onActivate={handleCitationLinkActivate}
							onHover={handleCitationLinkHover}
						/>
						<PdfRegionSelectLayer
							active={regionSelecting && !visualCropPending}
							label={t("pdfExplain.regionSelectionLabel", {
								page: pageNumber,
							})}
							onSelect={(region) =>
								handleVisualRegionSelect(pageNumber, region)
							}
						/>
						{/*
						 * Debug Eye overlay: pre-merge detections (all kinds, no NMS),
						 * score ≥ LAYOUT_SIDEBAR_MIN_SCORE (30%). Label = kind + conf.
						 */}
						{layoutOverlayVisible && layoutRawRegions
							? rawLayoutRegionsOnPage(layoutRawRegions, pageIndex).map(
									(region) => {
										const pct = Math.round(region.score * 100);
										const kindLabel = t(layoutKindI18nKey(region.kind));
										const label = t("figures.overlayLabel", {
											kind: kindLabel,
											pct,
										});
										return (
											<div
												key={`layout-box-${region.id}`}
												className="pointer-events-none absolute z-[1] rounded-sm border-[1.5px]"
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
									},
								)
							: null}
						{/* Bulk layout translate: progressive text overlays over body blocks. */}
						{layoutTranslateJob.items.length > 0 ? (
							<LayoutTranslateOverlay
								items={layoutTranslateJob.items}
								pageIndex={pageIndex}
								pageWidthPx={width}
								pageHeightPx={height}
								pdfDark={pdfDark}
							/>
						) : null}
						{/*
						 * Hover hit targets for post-merge figure/table/algorithm/formula.
						 * Largest first so smaller boxes stack on top and win pointer hits.
						 * Hidden when framing or a visual draft is open (not during crop:
						 * unmount leave must not cancel an in-flight hover open).
						 * Formula legend keeps hits mounted so leave/enter can switch
						 * equations and drive hide without a second hover surface.
						 */}
						{!regionSelecting && !visualDraftEditor && layoutDocRegions
							? hoverableLayoutRegionsOnPage(layoutDocRegions, pageIndex).map(
									(region) => {
										const formulaLegend =
											isFormulaLayoutKind(region.kind) &&
											equationSymbols.length > 0;
										return (
											<button
												key={`layout-hit-${region.id}`}
												type="button"
												data-layout-hit={region.id}
												aria-label={
													formulaLegend
														? t("equationAnnotation.hoverAria")
														: t("figures.hoverAskAria")
												}
												className="absolute z-[2] cursor-pointer rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-primary/5"
												style={{
													left: `${region.bbox.x * 100}%`,
													top: `${region.bbox.y * 100}%`,
													width: `${region.bbox.w * 100}%`,
													height: `${region.bbox.h * 100}%`,
												}}
												onPointerEnter={() => scheduleLayoutHoverOpen(region)}
												onPointerLeave={() => handleLayoutHoverLeave(region.id)}
											/>
										);
									},
								)
							: null}
						{/* Open ask conversation card: highlight the anchored selection. */}
						{activeAskOnPage
							? activeAskOnPage.anchor.rects.map((rect) => (
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
										onMouseEnter={markCardHoverEnter}
										onMouseLeave={scheduleHoverHide}
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
										onMouseEnter={markCardHoverEnter}
										onMouseLeave={scheduleHoverHide}
									/>
								))
							: null}
						{/* Open visual draft / mark: show the framed source region on-page. */}
						{visualDraftRegionOnPage ? (
							<div
								className={cn(
									"absolute z-[2] rounded-sm border-2 border-primary bg-primary/15 shadow-[0_0_0_1px_rgba(255,255,255,0.55)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.5)]",
									// Ephemeral layout-hover drafts need a hover surface so
									// leaving the region can schedule auto-hide.
									visualDraftEditor?.ephemeral
										? "pointer-events-auto"
										: "pointer-events-none",
								)}
								style={{
									left: `${visualDraftRegionOnPage.x * 100}%`,
									top: `${visualDraftRegionOnPage.y * 100}%`,
									width: `${visualDraftRegionOnPage.w * 100}%`,
									height: `${visualDraftRegionOnPage.h * 100}%`,
								}}
								aria-hidden="true"
								onMouseEnter={
									visualDraftEditor?.ephemeral
										? markLayoutDraftHoverEnter
										: undefined
								}
								onMouseLeave={
									visualDraftEditor?.ephemeral
										? scheduleLayoutDraftHide
										: undefined
								}
							/>
						) : null}
						{/*
						 * Formula legend: keep the same primary visual frame as visual-ask
						 * so the hovered equation is clearly boxed on the page.
						 * Hits own enter/leave; frame is visual-only.
						 */}
						{formulaAnnotationRegionOnPage ? (
							<div
								className="pointer-events-none absolute z-[2] rounded-sm border-2 border-primary bg-primary/15 shadow-[0_0_0_1px_rgba(255,255,255,0.55)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
								style={{
									left: `${formulaAnnotationRegionOnPage.x * 100}%`,
									top: `${formulaAnnotationRegionOnPage.y * 100}%`,
									width: `${formulaAnnotationRegionOnPage.w * 100}%`,
									height: `${formulaAnnotationRegionOnPage.h * 100}%`,
								}}
								aria-hidden="true"
							/>
						) : null}
						{/* Figures sidebar selection: EmbedPDF layout hue for kind. */}
						{focusedLayoutOnPage && !formulaAnnotationRegionOnPage ? (
							<div
								className="pointer-events-none absolute z-[2] rounded-sm border-2 shadow-[0_0_0_1px_rgba(255,255,255,0.55)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
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
										className="pointer-events-none absolute z-[2] rounded-sm border-2 border-primary bg-primary/15 shadow-[0_0_0_1px_rgba(255,255,255,0.55)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
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
							activeId={activeCard?.id ?? null}
							onOpen={handleOpenPin}
							onEnter={markCardHoverEnter}
							onLeave={scheduleHoverHide}
						/>
					</PagePointerProvider>
				</div>
			);
		},
		[
			docId,
			highlights,
			annotationCap,
			askSummaries,
			threads,
			visualTraces,
			translates,
			pageTextMap,
			activeThread,
			activeTranslate,
			activeVisualTrace,
			visualDraftRegion,
			formulaAnnotationRegion,
			focusedLayoutRegion,
			activeCard?.id,
			handleOpenPin,
			markCardHoverEnter,
			scheduleHoverHide,
			citationLinks,
			handleCitationLinkActivate,
			handleCitationLinkHover,
			regionSelecting,
			visualCropPending,
			visualDraftEditor,
			equationSymbols.length,
			layoutDocRegions,
			layoutRawRegions,
			layoutOverlayVisible,
			layoutTranslateJob.items,
			handleVisualRegionSelect,
			scheduleLayoutHoverOpen,
			handleLayoutHoverLeave,
			markLayoutDraftHoverEnter,
			scheduleLayoutDraftHide,
			pdfDark,
			t,
		],
	);

	const pdfColorSchemeLabel = pdfDark
		? t("pdf.useLightMode")
		: t("pdf.useDarkMode");

	return (
		<div ref={hostRef} className="relative flex h-full min-h-0 w-full flex-col">
			{outline.length > 0 ? (
				<div className="pointer-events-none absolute top-2 left-3 z-30">
					<TooltipProvider delayDuration={200}>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									className="pointer-events-auto rounded-lg border border-border/80 bg-background/95 shadow-sm backdrop-blur-sm"
									aria-label={t("pdf.outline")}
									aria-pressed={showOutline}
									onClick={() => setShowOutline((v) => !v)}
								>
									<List className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">{t("pdf.outline")}</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				</div>
			) : null}
			{showOutline && outline.length > 0 ? (
				<aside className="agentero-scroll absolute inset-y-0 left-0 z-20 w-60 border-r bg-background/95 pt-11 pb-2 backdrop-blur-sm">
					<div className="px-2">
						<OutlineTree nodes={outline} depth={0} onGoToPage={goToPage} />
					</div>
				</aside>
			) : null}
			{findOpen ? (
				<TooltipProvider delayDuration={200}>
					<div className="absolute top-12 right-3 z-30 flex items-center gap-1 rounded-lg border border-border/80 bg-background/95 p-1 shadow-md backdrop-blur-sm">
						<Search className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
						<input
							ref={findInputRef}
							type="text"
							className="w-40 bg-transparent text-xs outline-none"
							placeholder={t("pdf.findPlaceholder")}
							value={findQuery}
							onChange={(e) => setFindQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									scrollToResult(
										e.shiftKey
											? (search?.previousResult() ?? -1)
											: (search?.nextResult() ?? -1),
									);
								} else if (e.key === "Escape") {
									e.preventDefault();
									closeFind();
								}
							}}
						/>
						<span className="min-w-11 shrink-0 px-1 text-center text-muted-foreground text-xs tabular-nums">
							{findQuery.trim()
								? searchState.total > 0
									? `${searchState.activeResultIndex + 1}/${searchState.total}`
									: t("pdf.findNoResults")
								: ""}
						</span>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									aria-label={t("pdf.findPrev")}
									disabled={searchState.total === 0}
									onClick={() => scrollToResult(search?.previousResult() ?? -1)}
								>
									<ChevronUp className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">{t("pdf.findPrev")}</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									aria-label={t("pdf.findNext")}
									disabled={searchState.total === 0}
									onClick={() => scrollToResult(search?.nextResult() ?? -1)}
								>
									<ChevronDown className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">{t("pdf.findNext")}</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									aria-label={t("pdf.findClose")}
									onClick={closeFind}
								>
									<X className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{t("pdf.findClose")}
							</TooltipContent>
						</Tooltip>
					</div>
				</TooltipProvider>
			) : null}
			<div className="pointer-events-none absolute top-2 right-3 z-20 flex items-center gap-1">
				<TooltipProvider delayDuration={200}>
					<div className="pointer-events-auto flex h-7 items-center gap-0.5 rounded-lg border border-border/80 bg-background/95 p-0.5 shadow-sm backdrop-blur-sm">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									className="shrink-0 self-center"
									aria-label={t("pdf.zoomOut")}
									disabled={zoomLevel <= PDF_ZOOM_MIN}
									onClick={() => zoom?.zoomOut()}
								>
									<Minus className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">{t("pdf.zoomOut")}</TooltipContent>
						</Tooltip>
						<div className="flex h-6 shrink-0 items-center self-center">
							<input
								type="text"
								inputMode="decimal"
								maxLength={6}
								value={zoomField}
								aria-label={t("pdf.zoomPercentage")}
								title={t("pdf.zoomPercentage")}
								size={Math.max(zoomField.length, 1)}
								style={{ width: `${Math.max(zoomField.length, 1)}ch` }}
								className="h-6 min-w-[1ch] rounded border border-transparent bg-transparent p-0 text-center font-medium text-muted-foreground text-xs leading-6 tabular-nums outline-none hover:border-border focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
								onChange={(event) => setZoomField(event.target.value)}
								onFocus={(event) => {
									zoomFieldFocusedRef.current = true;
									event.currentTarget.select();
								}}
								onBlur={(event) => {
									zoomFieldFocusedRef.current = false;
									if (zoomFieldCancelRef.current) {
										zoomFieldCancelRef.current = false;
										setZoomField(formatPdfZoomPercentage(zoomLevel));
										return;
									}
									commitZoomField(event.currentTarget.value);
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										event.currentTarget.blur();
									} else if (event.key === "Escape") {
										event.preventDefault();
										zoomFieldCancelRef.current = true;
										event.currentTarget.blur();
									}
								}}
							/>
							<span
								aria-hidden="true"
								className="select-none text-muted-foreground text-xs leading-none"
							>
								%
							</span>
						</div>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									className="shrink-0 self-center"
									aria-label={t("pdf.zoomIn")}
									disabled={zoomLevel >= PDF_ZOOM_MAX}
									onClick={() => zoom?.zoomIn()}
								>
									<Plus className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">{t("pdf.zoomIn")}</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant={regionSelecting ? "secondary" : "ghost"}
									className="shrink-0 self-center"
									aria-label={t("pdfExplain.selectRegion")}
									aria-pressed={regionSelecting}
									disabled={visualCropPending || !engine}
									onClick={() => {
										setSelectionMenu(null);
										closeVisualDraftEditor();
										selectionCap?.clear(docId);
										setRegionSelecting((active) => !active);
									}}
								>
									<ScanSearch
										className={cn(
											"size-3.5",
											visualCropPending && "animate-pulse",
										)}
									/>
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{regionSelecting
									? t("pdfExplain.cancelRegion")
									: t("pdfExplain.selectRegion")}
								{/* Inverted tooltip: mute via text-background, not muted-foreground. */}
								<span className="ml-2 text-background/70">
									{formatShortcutById("visualAnnotation")}
								</span>
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant={
										layoutTranslateJob.status === "running" ||
										layoutTranslateJob.items.some((it) => it.translated)
											? "secondary"
											: "ghost"
									}
									className="shrink-0 self-center"
									aria-label={
										layoutTranslateJob.status === "running"
											? t("pdf.layoutTranslate.stop")
											: layoutTranslateJob.items.some((it) => it.translated)
												? t("pdf.layoutTranslate.clear")
												: t("pdf.layoutTranslate.start")
									}
									aria-pressed={
										layoutTranslateJob.status === "running" ||
										layoutTranslateJob.items.some((it) => it.translated)
									}
									disabled={!engine}
									onClick={toggleLayoutTranslate}
								>
									{layoutTranslateJob.status === "running" ? (
										<Loader2 className="size-3.5 animate-spin" aria-hidden />
									) : (
										<Languages className="size-3.5" aria-hidden />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">
								{layoutTranslateJob.status === "running"
									? t("pdf.layoutTranslate.stop")
									: layoutTranslateJob.items.some((it) => it.translated)
										? t("pdf.layoutTranslate.clear")
										: t("pdf.layoutTranslate.start")}
							</TooltipContent>
						</Tooltip>
						{onOpenAnnotations ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										size="icon-xs"
										variant="ghost"
										className="shrink-0 self-center"
										aria-label={t("annotations.title")}
										onClick={onOpenAnnotations}
									>
										<MessageSquareText className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">
									{t("annotations.title")}
								</TooltipContent>
							</Tooltip>
						) : null}
					</div>
				</TooltipProvider>
			</div>

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

			{typeof document !== "undefined"
				? createPortal(
						<>
							{selectionMenu ? (
								<SelectionMenu
									screen={selectionMenu.screen}
									onHighlight={handleHighlight}
									onCopy={handleCopy}
									onNote={handleNote}
									onAsk={handleMenuAsk}
									onAddToChat={handleMenuAddToChat}
									onTranslate={handleMenuTranslate}
									onClose={closeSelectionMenu}
								/>
							) : null}

							{visualDraftEditor ? (
								<VisualAnnotationEditor
									screen={visualDraftEditor.screen}
									onSave={handleVisualDraftSave}
									onAddToChat={handleVisualAddToChat}
									onSendNow={handleVisualSendNow}
									onDelete={closeVisualDraftEditor}
									onClose={closeVisualDraftEditor}
									onPointerEnter={
										visualDraftEditor.ephemeral
											? markLayoutDraftHoverEnter
											: undefined
									}
									onPointerLeave={
										visualDraftEditor.ephemeral
											? scheduleLayoutDraftHide
											: undefined
									}
								/>
							) : null}

							{formulaAnnotationPreview ? (
								<FormulaAnnotationCard
									screen={formulaAnnotationPreview.screen}
									symbols={formulaAnnotationPreview.symbols}
									onOpenFile={
										paperAbsPath
											? () => {
													closeFormulaAnnotationPreview();
													openPath(equationAnnotationPath(paperAbsPath));
												}
											: undefined
									}
									onClose={closeFormulaAnnotationPreview}
									onPointerEnter={markFormulaHoverEnter}
									onPointerLeave={scheduleFormulaHide}
								/>
							) : null}

							{citationPreview ? (
								<PdfCitationPreview
									screen={citationPreview.screen}
									marker={citationPreview.marker}
									citation={citationPreview.citation}
									onOpenReferences={() => {
										setCitationPreview(null);
										openRightTab("references");
									}}
									onPointerEnter={cancelCitationHide}
									onPointerLeave={scheduleCitationHide}
								/>
							) : null}

							{activeThread && cardScreen ? (
								<AskPopover
									thread={activeThread}
									screen={cardScreen}
									preferRight={cardScreen.preferRight ?? true}
									streaming={streaming}
									error={askError}
									onSend={handleSend}
									onResend={handleResend}
									onHide={handleHide}
									onDelete={handleDelete}
									onPointerEnter={markCardHoverEnter}
									onPointerLeave={scheduleHoverHide}
									onStop={() => {
										const sid = activeSessionRef.current;
										if (!sid) return;
										void cancelAgentRun(sid).catch(() => undefined);
										activeSessionRef.current = null;
										setStreaming(false);
									}}
								/>
							) : null}

							{activeVisualTrace && cardScreen ? (
								<VisualTraceCard
									trace={activeVisualTrace}
									screen={cardScreen}
									preferRight={cardScreen.preferRight ?? true}
									streaming={visualStreaming}
									error={visualError}
									initialExpanded={visualCardExpanded}
									onOpenSession={handleOpenActiveVisualSession}
									onAddToChat={handleVisualAddToChatFromMark}
									onSaveComment={handleVisualSaveComment}
									onSend={handleVisualContinue}
									onDelete={handleDeleteVisualTrace}
									onHide={hideActiveCard}
									onPointerEnter={markCardHoverEnter}
									onPointerLeave={scheduleHoverHide}
									onStop={handleStopVisualSession}
								/>
							) : null}

							{activeTranslate && cardScreen ? (
								<TranslateCard
									screen={cardScreen}
									preferRight={cardScreen.preferRight ?? true}
									result={activeTranslate.result ?? ""}
									streaming={translateStreaming}
									error={translateError ?? activeTranslate.error ?? null}
									onOpenSettings={() => onOpenSettings?.()}
									onHide={hideActiveCard}
									onDelete={deleteTranslateCard}
									onPointerEnter={markCardHoverEnter}
									onPointerLeave={scheduleHoverHide}
								/>
							) : null}

							{editor ? (
								<AnnotationEditor
									screen={editor.screen}
									initialComment={editor.comment}
									onSave={saveEditor}
									onClose={() => setEditor(null)}
									onDelete={deleteEditorAnnotation}
									onPointerEnter={markCardHoverEnter}
									onPointerLeave={scheduleHoverHide}
								/>
							) : null}
						</>,
						document.body,
					)
				: null}

			{/* Bottom bar: page nav + PDF color scheme. */}
			{totalPages > 0 ? (
				<div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
					<TooltipProvider delayDuration={200}>
						<div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-border/80 bg-background/95 p-0.5 shadow-sm backdrop-blur-sm">
							<input
								type="text"
								inputMode="numeric"
								className="w-6 rounded bg-transparent text-center font-medium text-foreground text-xs tabular-nums outline-none focus:bg-muted"
								aria-label={t("pdf.goToPage")}
								value={pageField}
								onFocus={(e) => {
									pageFocusedRef.current = true;
									e.currentTarget.select();
								}}
								onChange={(e) =>
									setPageField(e.target.value.replace(/[^0-9]/g, ""))
								}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										commitPageField();
										e.currentTarget.blur();
									}
								}}
								onBlur={() => {
									pageFocusedRef.current = false;
									commitPageField();
								}}
							/>
							<span className="px-0.5 text-muted-foreground text-xs tabular-nums">
								/ {totalPages}
							</span>
							<span
								aria-hidden
								className="mx-0.5 h-3.5 w-px shrink-0 bg-border"
							/>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										size="icon-xs"
										variant="ghost"
										aria-label={pdfColorSchemeLabel}
										aria-pressed={pdfDark}
										onClick={togglePdfColorScheme}
									>
										{pdfDark ? (
											<Sun className="size-3.5" />
										) : (
											<Moon className="size-3.5" />
										)}
									</Button>
								</TooltipTrigger>
								<TooltipContent side="top">
									{pdfColorSchemeLabel}
								</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										size="icon-xs"
										variant="ghost"
										aria-label={t("pdf.zoomFit")}
										onClick={() => zoom?.requestZoom(ZoomMode.FitWidth)}
									>
										<RotateCcw className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="top">{t("pdf.zoomFit")}</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										size="icon-xs"
										variant="ghost"
										aria-label={t("pdf.zoomFitPage")}
										onClick={() => zoom?.requestZoom(ZoomMode.FitPage)}
									>
										<MoveVertical className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="top">
									{t("pdf.zoomFitPage")}
								</TooltipContent>
							</Tooltip>
						</div>
					</TooltipProvider>
				</div>
			) : null}
		</div>
	);
}
