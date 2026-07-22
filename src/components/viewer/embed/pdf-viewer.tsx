import { createPluginRegistration } from "@embedpdf/core";
import { EmbedPDF } from "@embedpdf/core/react";
import type {
	PdfBookmarkObject,
	PdfHighlightAnnoObject,
} from "@embedpdf/models";
import { PdfAnnotationSubtype } from "@embedpdf/models";
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
	DocumentManagerPluginPackage,
	useDocumentManagerCapability,
} from "@embedpdf/plugin-document-manager/react";
import {
	GlobalPointerProvider,
	InteractionManagerPluginPackage,
	PagePointerProvider,
} from "@embedpdf/plugin-interaction-manager/react";
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
	Viewport,
	ViewportPluginPackage,
} from "@embedpdf/plugin-viewport/react";
import {
	useZoom,
	ZoomMode,
	ZoomPluginPackage,
} from "@embedpdf/plugin-zoom/react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	List,
	Maximize2,
	MessageSquareText,
	Minimize2,
	Minus,
	MoveVertical,
	Plus,
	RotateCcw,
	Search,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePdfEngineContext } from "@/components/viewer/embed/engine-provider";
import {
	EMBED_PAGE_ATTR,
	pageElByIndex,
	rectRightScreen,
	rectTopCenterScreen,
} from "@/components/viewer/embed/geometry";
import { anchorFromEmbedSelection } from "@/components/viewer/embed/selection-anchor";
import { AnnotationEditor } from "@/components/viewer/pdf-ask/annotation-editor";
import { AskPopover } from "@/components/viewer/pdf-ask/ask-popover";
import { SelectionGutter } from "@/components/viewer/pdf-ask/selection-gutter";
import { SelectionMenu } from "@/components/viewer/pdf-ask/selection-menu";
import { TranslateCard } from "@/components/viewer/pdf-ask/translate-card";
import {
	cancelAgentRun,
	listAgents,
	listenAgentCompleted,
	listenAgentFailed,
	listenAgentStream,
	runOnce,
} from "@/lib/agent";
import { notifyError } from "@/lib/notify";
import { isPdfViewerSource } from "@/lib/paper-metadata";
import {
	createEmptyThread,
	deletePdfAskThread,
	listPdfAskThreads,
	newMessageId,
	popoverScreenPoint,
	toSummaries,
	writePdfAskThread,
} from "@/lib/pdf-ask";
import { buildPdfAskPrompt } from "@/lib/pdf-ask/prompt";
import { threadHasUserQuestion, threadPin } from "@/lib/pdf-ask/schema";
import type { PdfAskAnchor, PdfAskThread } from "@/lib/pdf-ask/types";
import {
	hasAnnotationsFile,
	highlightViewFromObject,
	isHighlightObject,
	loadAnnotationItems,
	saveAnnotationItems,
} from "@/lib/pdf-highlight/annotation-store";
import { migrateHighlightMarks } from "@/lib/pdf-highlight/migrate-marks";
import {
	DEFAULT_HIGHLIGHT_COLOR,
	HIGHLIGHT_HEX,
	HIGHLIGHT_HEX_LIST,
	HIGHLIGHT_OPACITY,
	type HighlightColor,
} from "@/lib/pdf-highlight/palette";
import type { PdfHighlight } from "@/lib/pdf-highlight/types";
import { readReadingPage, writeReadingPage } from "@/lib/pdf-reading-position";
import {
	type ActiveSelectionCard,
	pinFromRects,
	type SelectionPin,
} from "@/lib/pdf-selection";
import {
	createTranslateRecord,
	deletePdfTranslate,
	listPdfTranslates,
	writePdfTranslate,
} from "@/lib/pdf-translate";
import type { PdfTranslateRecord } from "@/lib/pdf-translate/types";
import { writeReadingMetaPageCount } from "@/lib/reading-heatmap";
import {
	buildTranslatePrompt,
	prepareTranslateTask,
	resolveTranslateAgent,
	runTranslate,
} from "@/lib/translate";
import { cn } from "@/lib/utils";
import { loadSettings } from "@/stores/settings-store";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

export type PdfViewerHandle = {
	getHighlights: () => PdfHighlight[];
	scrollToHighlight: (id: string) => void;
	editComment: (id: string) => void;
	deleteHighlight: (id: string) => void;
	/** Jump to an ask pin and reopen its conversation card. */
	scrollToAsk: (id: string) => void;
	deleteAsk: (id: string) => void;
};

export type PdfViewerProps = {
	/**
	 * PDF source: local `blob:` (bytes via fs) or remote https. Prefer local
	 * vault PDF; remote URL is fallback when download fails.
	 */
	source: string | null;
	/** Stable per-tab document id (EmbedPDF documentId + scope key). */
	docId?: string | null;
	/** Absolute path to paper folder for annotations/marks persistence */
	paperAbsPath?: string | null;
	/** Vault-relative paper path stored inside JSON */
	paperRelPath?: string | null;
	/** Current vault root for ACP cwd */
	vaultPath?: string | null;
	/** Immersive full-window reading mode (adapts width + hides app chrome). */
	zen?: boolean;
	/** Toggle immersive mode; when provided a toolbar button is shown. */
	onToggleZen?: () => void;
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
							if (n.target?.type === "destination") {
								onGoToPage(n.target.destination.pageIndex + 1);
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
	const docId =
		props.docId?.trim() ||
		props.paperRelPath ||
		props.paperAbsPath ||
		source ||
		"pdf";

	const plugins = useMemo(() => {
		if (!source) return null;
		return [
			createPluginRegistration(DocumentManagerPluginPackage, {
				initialDocuments: [{ url: source, documentId: docId, name: docId }],
			}),
			createPluginRegistration(ViewportPluginPackage),
			createPluginRegistration(ScrollPluginPackage),
			createPluginRegistration(RenderPluginPackage),
			createPluginRegistration(TilingPluginPackage),
			createPluginRegistration(ZoomPluginPackage, {
				defaultZoomLevel: ZoomMode.FitWidth,
				minZoom: ZOOM_MIN,
				maxZoom: ZOOM_MAX,
			}),
			createPluginRegistration(InteractionManagerPluginPackage),
			createPluginRegistration(SelectionPluginPackage),
			createPluginRegistration(AnnotationPluginPackage, {
				annotationAuthor: "Agentero",
				colorPresets: HIGHLIGHT_HEX_LIST,
				selectAfterCreate: false,
				deactivateToolAfterCreate: true,
			}),
			createPluginRegistration(SearchPluginPackage),
			createPluginRegistration(BookmarkPluginPackage),
		];
	}, [source, docId]);

	const hostClass = cn(
		"relative flex h-full min-h-0 flex-col bg-muted/20",
		props.className,
	);

	if (!source) {
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
			<EmbedPDF key={`${docId}::${source}`} engine={engine} plugins={plugins}>
				<PdfViewerInner {...props} docId={docId} />
			</EmbedPDF>
		</div>
	);
}

type PdfViewerInnerProps = PdfViewerProps & { docId: string };

type SelectionMenuState = {
	screen: { x: number; y: number };
	anchor: PdfAskAnchor;
	pages: FormattedSelection[];
};

type EditorState = {
	screen: { x: number; y: number };
	pageIndex: number;
	id: string;
	quote: string;
	comment: string;
};

function PdfViewerInner({
	docId,
	paperAbsPath = null,
	paperRelPath = null,
	vaultPath = null,
	zen = false,
	onToggleZen,
	onOpenAnnotations,
	onOpenSettings,
	onHandle,
	onHighlightsChange,
	onAsksChange,
}: PdfViewerInnerProps) {
	const { t } = useTranslation("viewer");
	const { provides: zoom, state: zoomState } = useZoom(docId);
	const { provides: scroll, state: scrollState } = useScroll(docId);
	const { provides: selectionCap } = useSelectionCapability();
	const { provides: annotationCap } = useAnnotationCapability();
	const { provides: docCap } = useDocumentManagerCapability();
	const { state: searchState, provides: search } = useSearch(docId);
	const { provides: bookmarkCap } = useBookmarkCapability();

	const currentPage = scrollState.currentPage || 1;
	const totalPages = scrollState.totalPages || 0;
	const zoomLevel = zoomState.currentZoomLevel || 1;
	const zoomPct = Math.round(zoomLevel * 100);

	const [pageField, setPageField] = useState("1");
	const [highlights, setHighlights] = useState<PdfHighlight[]>([]);
	const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(
		null,
	);
	const [editor, setEditor] = useState<EditorState | null>(null);

	const [threads, setThreads] = useState<PdfAskThread[]>([]);
	const [translates, setTranslates] = useState<PdfTranslateRecord[]>([]);
	const [activeCard, setActiveCard] = useState<ActiveSelectionCard | null>(
		null,
	);
	const [cardScreen, setCardScreen] = useState<{ x: number; y: number } | null>(
		null,
	);
	const [streaming, setStreaming] = useState(false);
	const [askError, setAskError] = useState<string | null>(null);
	const [translateStreaming, setTranslateStreaming] = useState(false);
	const [translateError, setTranslateError] = useState<string | null>(null);

	const [findOpen, setFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const [outline, setOutline] = useState<PdfBookmarkObject[]>([]);
	const [showOutline, setShowOutline] = useState(false);
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
	const highlightsRef = useRef(highlights);
	highlightsRef.current = highlights;
	const threadsRef = useRef(threads);
	threadsRef.current = threads;
	const translatesRef = useRef(translates);
	translatesRef.current = translates;
	const activeCardRef = useRef<ActiveSelectionCard | null>(null);
	activeCardRef.current = activeCard;
	const activeSessionRef = useRef<string | null>(null);
	const translateSessionRef = useRef<string | null>(null);
	const hidePopoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);

	/** Stable key for resume-reading (null for loose PDFs without a paper path). */
	const paperKey = paperRelPath || paperAbsPath || null;

	const askSummaries = useMemo(
		() => toSummaries(threads.filter(threadHasUserQuestion)),
		[threads],
	);
	const activeThread = useMemo(() => {
		if (activeCard?.kind !== "ask") return null;
		return threads.find((th) => th.id === activeCard.id) ?? null;
	}, [threads, activeCard]);
	const activeTranslate = useMemo(() => {
		if (activeCard?.kind !== "translate") return null;
		return translates.find((tr) => tr.id === activeCard.id) ?? null;
	}, [translates, activeCard]);

	// ---- Highlights (EmbedPDF annotations) ----

	const rebuildHighlights = useCallback(() => {
		if (!annotationCap) return;
		const scope = annotationCap.forDocument(docId);
		const list = scope
			.getAnnotations()
			.map((a) => a.object)
			.filter(isHighlightObject)
			.map((o) => highlightViewFromObject(o, paperKey ?? ""));
		setHighlights(list);
		onHighlightsChange?.(list);
	}, [annotationCap, docId, paperKey, onHighlightsChange]);

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
			setTranslateStreaming(false);
			setTranslateError(message);
		},
		[upsertTranslate],
	);

	// Load persisted ask threads + translate records once.
	useEffect(() => {
		if (marksLoadedRef.current || !paperAbsPath) return;
		marksLoadedRef.current = true;
		void (async () => {
			const [ts, trs] = await Promise.all([
				listPdfAskThreads(paperAbsPath),
				listPdfTranslates(paperAbsPath),
			]);
			if (ts.length) setThreads(ts);
			if (trs.length) setTranslates(trs);
		})();
	}, [paperAbsPath]);

	// Publish ask threads (with a real question) to the annotations panel.
	useEffect(() => {
		onAsksChange?.(threads.filter(threadHasUserQuestion));
	}, [threads, onAsksChange]);

	const placeActiveCard = useCallback((card: ActiveSelectionCard) => {
		const host = hostRef.current;
		if (!host) return;
		let page = 1;
		let rects: PdfAskAnchor["rects"] = [];
		let pin: { x: number; y: number } | null = null;
		if (card.kind === "ask") {
			const thread = threadsRef.current.find((th) => th.id === card.id);
			if (!thread) return;
			page = thread.anchor.page;
			rects = thread.anchor.rects;
			pin = threadPin(thread);
		} else if (card.kind === "translate") {
			const tr = translatesRef.current.find((r) => r.id === card.id);
			if (!tr) return;
			page = tr.page;
			rects = tr.rects;
			pin = pinFromRects(tr.rects);
		} else {
			return;
		}
		const pageEl = pageElByIndex(host, page - 1);
		const pt = popoverScreenPoint(pageEl, rects, pin);
		setCardScreen(pt ?? { x: 80, y: 120 });
	}, []);

	const cancelHoverHide = useCallback(() => {
		if (hidePopoverTimerRef.current) {
			clearTimeout(hidePopoverTimerRef.current);
			hidePopoverTimerRef.current = null;
		}
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
		setActiveCard(null);
		setCardScreen(null);
	}, [discardIfEmptyDraft]);

	const scheduleHoverHide = useCallback(() => {
		cancelHoverHide();
		hidePopoverTimerRef.current = setTimeout(() => {
			hidePopoverTimerRef.current = null;
			hideActiveCard();
		}, 1000);
	}, [cancelHoverHide, hideActiveCard]);

	const stopTranslateSession = useCallback(() => {
		const sid = translateSessionRef.current;
		if (sid) {
			void cancelAgentRun(sid).catch(() => undefined);
			if (activeSessionRef.current === sid) activeSessionRef.current = null;
			translateSessionRef.current = null;
		}
		setTranslateStreaming(false);
	}, []);

	const openCard = useCallback(
		(card: ActiveSelectionCard) => {
			cancelHoverHide();
			if (
				activeCardRef.current?.kind === "translate" &&
				(card.kind !== "translate" || card.id !== activeCardRef.current.id)
			) {
				stopTranslateSession();
			}
			setActiveCard(card);
			if (card.kind === "ask") setAskError(null);
			if (card.kind === "translate") setTranslateError(null);
			placeActiveCard(card);
		},
		[cancelHoverHide, placeActiveCard, stopTranslateSession],
	);

	const openThread = useCallback(
		(thread: PdfAskThread) => openCard({ kind: "ask", id: thread.id }),
		[openCard],
	);

	const startFromAnchor = useCallback(
		(anchor: PdfAskAnchor) => {
			const paperPath = paperRelPath || paperAbsPath || "paper";
			const thread = createEmptyThread({ paperPath, anchor });
			setThreads((prev) => [thread, ...prev.filter(threadHasUserQuestion)]);
			openThread(thread);
		},
		[paperAbsPath, paperRelPath, openThread],
	);

	const sendToThread = useCallback(
		async (
			thread: PdfAskThread,
			question: string,
			agentOpts?: { agentId?: string; modelId?: string },
		) => {
			const threadId = thread.id;
			if (!question.trim()) return;
			const userMsg = {
				id: newMessageId(),
				role: "user" as const,
				content: question,
				createdAt: new Date().toISOString(),
			};
			const withUser: PdfAskThread = {
				...thread,
				status: "open",
				messages: [...thread.messages, userMsg],
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

	const handleSend = useCallback(
		(question: string) => {
			const card = activeCardRef.current;
			const threadId = card?.kind === "ask" ? card.id : null;
			if (!threadId) return;
			const thread = threadsRef.current.find((th) => th.id === threadId);
			if (!thread) return;
			void (async () => {
				try {
					const registry = await listAgents().catch(() => null);
					const resolved = resolveTranslateAgent(
						loadSettings().pdfAsk,
						registry,
					);
					if (!resolved.agentId) {
						const msg = t("pdfAsk.noAgent");
						notifyError(msg);
						setAskError(msg);
						return;
					}
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
		[sendToThread, t],
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
		},
		[upsertThread, openThread, openCard],
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
		openCard({ kind: "translate", id: rec.id });
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
			})();
		});
		const offChange = scope.onSelectionChange((sel) => {
			if (!sel) setSelectionMenu(null);
		});
		return () => {
			offEnd();
			offChange();
		};
	}, [selectionCap, docCap, docId]);

	// Re-anchor the active ask/translate card on scroll + zoom. zoomLevel is an
	// intentional dep: it forces re-placement after a zoom (body reads live zoom).
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-anchor after zoom
	useEffect(() => {
		if (!activeCard) return;
		placeActiveCard(activeCard);
		if (!scroll) return;
		const off = scroll.onScroll(() => {
			if (activeCardRef.current) placeActiveCard(activeCardRef.current);
		});
		return () => off();
	}, [activeCard, scroll, placeActiveCard, zoomLevel]);

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
				if (!cancelled) setOutline(res?.bookmarks ?? []);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [bookmarkCap, docId, totalPages]);

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

	const openEditorForAnnotation = useCallback(
		(id: string) => {
			const obj = annotationCap
				?.forDocument(docId)
				.getAnnotationById(id)?.object;
			if (!obj || !isHighlightObject(obj)) return;
			const pageEl = pageElByIndex(hostRef.current, obj.pageIndex);
			if (!pageEl) return;
			setEditor({
				screen: rectRightScreen(pageEl, obj.rect, zoomRef.current),
				pageIndex: obj.pageIndex,
				id,
				quote: ((obj.custom ?? {}) as { quote?: string }).quote?.trim() ?? "",
				comment: obj.contents?.trim() ?? "",
			});
		},
		[annotationCap, docId],
	);

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

	// Register the imperative handle for the annotations panel.
	useEffect(() => {
		if (!onHandle) return;
		const handle: PdfViewerHandle = {
			getHighlights: () => highlightsRef.current,
			scrollToHighlight: (id) => {
				const obj = annotationCap
					?.forDocument(docId)
					.getAnnotationById(id)?.object;
				if (!obj || !isHighlightObject(obj)) return;
				scroll?.scrollToPage({ pageNumber: obj.pageIndex + 1 });
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
				scroll?.scrollToPage({ pageNumber: thread.anchor.page });
				openThread({ ...thread, status: "open" });
			},
			deleteAsk: (id) => {
				setThreads((prev) => prev.filter((th) => th.id !== id));
				if (paperAbsPath) void deletePdfAskThread(paperAbsPath, id);
			},
		};
		onHandle(handle);
		return () => onHandle(null);
	}, [
		onHandle,
		annotationCap,
		scroll,
		docId,
		paperAbsPath,
		openEditorForAnnotation,
		openThread,
	]);

	// Keep the page-number input in sync with the observed current page.
	useEffect(() => {
		if (!pageFocusedRef.current) setPageField(String(currentPage));
	}, [currentPage]);

	// On first load: record page count (reading heatmap) and restore last page.
	useEffect(() => {
		if (restoredRef.current || totalPages <= 0 || !scroll) return;
		restoredRef.current = true;
		if (paperAbsPath) {
			void writeReadingMetaPageCount(paperAbsPath, totalPages).catch(
				() => undefined,
			);
		}
		if (paperKey) {
			const saved = readReadingPage(paperKey);
			if (saved && saved > 1 && saved <= totalPages) {
				scroll.scrollToPage({ pageNumber: saved });
			}
		}
	}, [totalPages, scroll, paperAbsPath, paperKey]);

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
		if (r && scroll) scroll.scrollToPage({ pageNumber: r.pageIndex + 1 });
	};

	const closeFind = () => {
		setFindOpen(false);
		setFindQuery("");
		search?.stopSearch();
	};

	const goToPage = (n: number) => {
		if (!scroll || totalPages <= 0) return;
		const clamped = Math.min(totalPages, Math.max(1, Math.floor(n)));
		scroll.scrollToPage({ pageNumber: clamped });
	};

	const commitPageField = () => {
		const n = Number.parseInt(pageField, 10);
		if (Number.isFinite(n)) goToPage(n);
		else setPageField(String(currentPage));
	};

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
					<div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-border/80 bg-background/95 p-0.5 shadow-sm backdrop-blur-sm">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									aria-label={t("pdf.zoomOut")}
									disabled={zoomLevel <= ZOOM_MIN}
									onClick={() => zoom?.zoomOut()}
								>
									<Minus className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">{t("pdf.zoomOut")}</TooltipContent>
						</Tooltip>
						<button
							type="button"
							className="min-w-11 px-1 text-center font-medium text-muted-foreground text-xs tabular-nums hover:text-foreground"
							aria-label={t("pdf.zoomReset")}
							title={t("pdf.zoomReset")}
							onClick={() => zoom?.requestZoom(ZoomMode.FitWidth)}
						>
							{zoomPct}%
						</button>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									aria-label={t("pdf.zoomIn")}
									disabled={zoomLevel >= ZOOM_MAX}
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
									variant="ghost"
									aria-label={t("pdf.zoomFit")}
									onClick={() => zoom?.requestZoom(ZoomMode.FitWidth)}
								>
									<RotateCcw className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">{t("pdf.zoomFit")}</TooltipContent>
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
							<TooltipContent side="bottom">
								{t("pdf.zoomFitPage")}
							</TooltipContent>
						</Tooltip>
						{onToggleZen ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										size="icon-xs"
										variant="ghost"
										aria-label={zen ? t("pdf.zenExit") : t("pdf.zenEnter")}
										aria-pressed={zen}
										onClick={onToggleZen}
									>
										{zen ? (
											<Minimize2 className="size-3.5" />
										) : (
											<Maximize2 className="size-3.5" />
										)}
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">
									{zen ? t("pdf.zenExit") : t("pdf.zenEnter")}
								</TooltipContent>
							</Tooltip>
						) : null}
						{onOpenAnnotations ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										size="icon-xs"
										variant="ghost"
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

			<Viewport
				documentId={docId}
				className="agentero-scroll-both min-h-0 flex-1"
			>
				<GlobalPointerProvider documentId={docId}>
					<Scroller
						documentId={docId}
						renderPage={({ pageIndex, width, height }) => {
							const pageNumber = pageIndex + 1;
							const activeTranslateOnPage =
								activeTranslate?.page === pageNumber ? activeTranslate : null;
							const pins: SelectionPin[] = [
								...askSummaries
									.filter((s) => s.page === pageNumber)
									.map(
										(s): SelectionPin => ({
											id: s.id,
											kind: "ask",
											x: s.x,
											y: s.y,
											preview: s.preview,
											ended: s.status === "ended",
										}),
									),
								...translates
									.filter((tr) => tr.page === pageNumber && !tr.error)
									.map((tr): SelectionPin => {
										const pin = pinFromRects(tr.rects);
										return {
											id: tr.id,
											kind: "translate",
											x: pin.x,
											y: pin.y,
											preview: tr.result?.trim() || tr.quote?.trim() || tr.id,
										};
									}),
							];
							return (
								<div
									className="relative overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-black/5 dark:ring-white/10"
									style={{ width, height }}
									{...{ [EMBED_PAGE_ATTR]: pageIndex }}
								>
									<RenderLayer
										documentId={docId}
										pageIndex={pageIndex}
										style={{ position: "absolute", inset: 0 }}
									/>
									<TilingLayer
										documentId={docId}
										pageIndex={pageIndex}
										style={{ position: "absolute", inset: 0 }}
									/>
									<SearchLayer
										documentId={docId}
										pageIndex={pageIndex}
										style={{ position: "absolute", inset: 0 }}
									/>
									<PagePointerProvider
										documentId={docId}
										pageIndex={pageIndex}
										style={{ position: "absolute", inset: 0 }}
									>
										<SelectionLayer documentId={docId} pageIndex={pageIndex} />
										<AnnotationLayer documentId={docId} pageIndex={pageIndex} />
										{activeTranslateOnPage
											? activeTranslateOnPage.rects.map((rect) => (
													<div
														key={`${activeTranslateOnPage.id}-source-${rect.x}-${rect.y}-${rect.w}-${rect.h}`}
														className="pointer-events-none absolute z-[1] rounded-[2px] bg-yellow-300/40 dark:bg-yellow-400/35"
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
											onEnter={cancelHoverHide}
											onLeave={scheduleHoverHide}
										/>
									</PagePointerProvider>
								</div>
							);
						}}
					/>
				</GlobalPointerProvider>
			</Viewport>

			{selectionMenu ? (
				<SelectionMenu
					screen={selectionMenu.screen}
					onHighlight={handleHighlight}
					onCopy={handleCopy}
					onNote={handleNote}
					onAsk={handleMenuAsk}
					onTranslate={handleMenuTranslate}
					onClose={closeSelectionMenu}
				/>
			) : null}

			{activeThread && cardScreen ? (
				<AskPopover
					thread={activeThread}
					screen={cardScreen}
					streaming={streaming}
					error={askError}
					onSend={handleSend}
					onHide={handleHide}
					onDelete={handleDelete}
					onPointerEnter={cancelHoverHide}
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

			{activeTranslate && cardScreen ? (
				<TranslateCard
					screen={cardScreen}
					result={activeTranslate.result ?? ""}
					streaming={translateStreaming}
					error={translateError ?? activeTranslate.error ?? null}
					onOpenSettings={() => onOpenSettings?.()}
					onHide={hideActiveCard}
					onDelete={deleteTranslateCard}
					onPointerEnter={cancelHoverHide}
					onPointerLeave={scheduleHoverHide}
				/>
			) : null}

			{editor ? (
				<AnnotationEditor
					screen={editor.screen}
					quote={editor.quote}
					initialComment={editor.comment}
					onSave={saveEditor}
					onClose={() => setEditor(null)}
				/>
			) : null}

			{totalPages > 0 ? (
				<div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
					<TooltipProvider delayDuration={200}>
						<div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-border/80 bg-background/95 p-0.5 shadow-sm backdrop-blur-sm">
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										size="icon-xs"
										variant="ghost"
										aria-label={t("pdf.prevPage")}
										disabled={currentPage <= 1}
										onClick={() => goToPage(currentPage - 1)}
									>
										<ChevronLeft className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="top">{t("pdf.prevPage")}</TooltipContent>
							</Tooltip>
							<input
								type="text"
								inputMode="numeric"
								className="w-8 rounded bg-transparent text-center font-medium text-foreground text-xs tabular-nums outline-none focus:bg-muted"
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
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										size="icon-xs"
										variant="ghost"
										aria-label={t("pdf.nextPage")}
										disabled={currentPage >= totalPages}
										onClick={() => goToPage(currentPage + 1)}
									>
										<ChevronRight className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="top">{t("pdf.nextPage")}</TooltipContent>
							</Tooltip>
						</div>
					</TooltipProvider>
				</div>
			) : null}
		</div>
	);
}
