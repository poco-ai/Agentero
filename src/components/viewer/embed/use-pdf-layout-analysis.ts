/**
 * Layout analysis for the EmbedPDF viewer: running PP-DocLayoutV3 (or loading its
 * `layout.json` sidecar), bucketing the resulting regions per page for the hover
 * hit targets and the debug Eye overlay, the figure / formula hover cards, and
 * the progressive bulk-translate job over body-text regions.
 *
 * One hook because every one of those reads the same region set and they arbitrate
 * against each other through shared dwell / hide timers: a figure hover opens a
 * region-crop draft card, a formula hover opens the `Annotation.md` glossary
 * card, and the two cards are **mutually exclusive**. That invariant is the
 * reason this hook owns both `visualDraftEditor` and `formulaAnnotationPreview`
 * even though the draft card's *content* belongs to
 * {@link usePdfVisualMarks}: `openVisualDraftEditor` /
 * `closeVisualDraftEditor` / `closeFormulaAnnotationPreview` are the only ways to
 * move either state, so neither can be set without the other's guard.
 *
 * Boundaries:
 * - the crop itself lives in {@link usePdfVisualMarks} (it owns the engine call
 *   and every save path), so the dwell timer calls it through the parent-owned
 *   `beginVisualAnnotationRef` and this hook only hands back the opened draft;
 * - EmbedPDF capability scopes are re-created every render, so `layoutCapRef`
 *   stays in `PdfViewerInner` and is injected;
 * - region *results* live in `layoutAnalysisStore` (shared with the Figures rail
 *   and the CLI-written sidecar); only the per-page buckets are memoized here.
 */

import type { useLayoutAnalysisCapability } from "@embedpdf/plugin-layout-analysis/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { pageElByIndex } from "@/components/viewer/embed/geometry";
import { EMPTY_LAYOUT_REGIONS_BY_PAGE } from "@/components/viewer/embed/pdf-page-constants";
import type {
	FormulaAnnotationPreviewState,
	SelectionMenuState,
	VisualDraftEditorState,
} from "@/components/viewer/embed/pdf-viewer-types";
import type { BeginVisualAnnotationOptions } from "@/components/viewer/embed/use-pdf-visual-marks";
import i18n from "@/i18n";
import {
	BackgroundTaskCancelledError,
	enqueueBackgroundTask,
	isBackgroundTaskCancelledError,
} from "@/lib/core/background-tasks";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import {
	type EquationSymbol,
	equationAnnotationPath,
	loadEquationAnnotation,
} from "@/lib/pdf/equation-annotation";
import {
	enqueuePaperLayoutAnalysis,
	getLayoutDocumentResult,
	hoverableLayoutRegionsByPage,
	isFormulaLayoutKind,
	LAYOUT_FORMULA_HOVER_DWELL_MS,
	LAYOUT_FORMULA_HOVER_HIDE_MS,
	LAYOUT_HOVER_DWELL_MS,
	LAYOUT_HOVER_HIDE_MS,
	type LayoutTranslateItem,
	type LayoutTranslateJobStatus,
	layoutAnalysisStore,
	listTranslatableLayoutRegions,
	type PdfLayoutRegion,
	rawLayoutRegionsByPage,
	readLayoutSidecar,
	runDocumentLayoutAnalysis,
	runLayoutRegionTranslate,
	setFocusedLayoutRegion,
	setLayoutOverlayVisible,
	toLayoutTranslateItems,
} from "@/lib/pdf/layout";
import {
	VAULT_FILE_CHANGED_EVENT,
	type VaultFileChangedPayload,
} from "@/lib/vault/fs-watch";
import { normalizePathKey } from "@/lib/vault/path";

/** In-flight EmbedPDF layout task (abortable, at most one per document). */
export type LayoutAnalysisTask = Awaited<
	ReturnType<typeof runDocumentLayoutAnalysis>
>;

/** Options for the manual Figures button, the handle, and the silent auto-run. */
export type StartLayoutAnalysisOptions = {
	/** Re-run PP-DocLayoutV3 (PDF→JSON) even when `source/layout.json` exists. */
	force?: boolean;
	openFigures?: boolean;
	showOverlay?: boolean;
	/** Surface progress in the IDE background-tasks panel. */
	asBackgroundTask?: boolean;
	/** When false, skip notifyError (auto-run reports through the tasks panel). */
	notifyOnError?: boolean;
};

type LayoutCapability = ReturnType<
	typeof useLayoutAnalysisCapability
>["provides"];

export type UsePdfLayoutAnalysisOptions = {
	docId: string;
	/** Paper folder: `layout.json` sidecar + `Annotation.md` glossary root. */
	paperAbsPath: string | null;
	/** Vault-relative path, used as the background-task label. */
	paperRelPath: string | null;
	/**
	 * Workspace active tab. Dock may keep inactive PDFs mounted; only the active
	 * viewer pulls the sidecar into the tab store.
	 */
	isActive: boolean;
	totalPages: number;
	hostRef: RefObject<HTMLDivElement | null>;
	/** Current zoom: the open formula legend re-anchors when it changes. */
	zoomLevel: number;
	/**
	 * EmbedPDF layout capability. The value gates the auto-run effect; the ref is
	 * owned by `PdfViewerInner` because `forDocument()` returns a fresh scope every
	 * render and must never become an effect dependency.
	 */
	layoutCap: LayoutCapability;
	layoutCapRef: RefObject<LayoutCapability>;
	/** Text-selection cluster: an open menu blocks layout hover. */
	selectionMenuRef: RefObject<SelectionMenuState | null>;
	/**
	 * Visual-mark cluster mirrors (parent-owned): region framing or an in-flight
	 * crop blocks layout hover.
	 */
	regionSelectingRef: RefObject<boolean>;
	visualCropPendingRef: RefObject<boolean>;
	/**
	 * Latest `beginVisualAnnotation`. Parent-owned because
	 * {@link usePdfVisualMarks} consumes this hook's draft-card API and is
	 * therefore declared after it.
	 */
	beginVisualAnnotationRef: RefObject<
		(
			page: number,
			region: PdfAskNormalizedRect,
			opts?: BeginVisualAnnotationOptions,
		) => void
	>;
};

export type PdfLayoutAnalysis = {
	/** Figures rail header toggle; also drives the debug Eye overlay. */
	layoutOverlayVisible: boolean;
	/** Post-merge hover hit targets, bucketed by 0-based page index. */
	hoverableRegionsByPage: ReadonlyMap<number, PdfLayoutRegion[]>;
	/** Pre-merge detections for the debug Eye overlay, bucketed by page. */
	rawRegionsByPage: ReadonlyMap<number, PdfLayoutRegion[]>;
	/** Parsed rows from `{paper}/Annotation.md` (empty when missing). */
	equationSymbols: EquationSymbol[];
	/** Region-crop draft card. Mutually exclusive with the formula legend. */
	visualDraftEditor: VisualDraftEditorState | null;
	/** Formula glossary card. Mutually exclusive with the draft card. */
	formulaAnnotationPreview: FormulaAnnotationPreviewState | null;
	/** Sole entry point for the draft card; closes the formula legend first. */
	openVisualDraftEditor: (draft: VisualDraftEditorState) => void;
	closeVisualDraftEditor: () => void;
	closeFormulaAnnotationPreview: () => void;
	/** Screen anchor beside a page-normalized region (hover card placement). */
	screenPointForRegion: (
		pageIndex0: number,
		region: PdfAskNormalizedRect,
	) => { x: number; y: number };
	/** Bumped on leave / supersede so a late crop cannot open the draft. */
	layoutHoverSeqRef: RefObject<number>;
	/** Pointer entered a layout hit target → start the dwell timer. */
	scheduleLayoutHoverOpen: (region: PdfLayoutRegion) => void;
	handleLayoutHoverLeave: (regionId: string) => void;
	markLayoutDraftHoverEnter: () => void;
	scheduleLayoutDraftHide: () => void;
	markFormulaHoverEnter: () => void;
	scheduleFormulaHide: () => void;
	/** Re-anchor the open formula legend after the page moved under it. */
	rePlaceFormulaAnnotationOnScroll: () => void;
	/** Latest `startLayoutAnalysis`, for the imperative handle. */
	startLayoutAnalysisRef: RefObject<
		(opts?: StartLayoutAnalysisOptions) => void
	>;
	/** In-flight layout task; the handle aborts it on unregister. */
	layoutTaskRef: RefObject<LayoutAnalysisTask | null>;
	/** Progressive bulk-translate overlays (body text / abstract / header). */
	layoutTranslateJob: {
		status: LayoutTranslateJobStatus;
		items: LayoutTranslateItem[];
	};
	layoutTranslateRunning: boolean;
	/** Running, or finished with overlays still painted. */
	layoutTranslateActive: boolean;
	/** Toolbar button label for the current job phase. */
	layoutTranslateLabel: string;
	/** Toolbar button: start → stop → clear → start. */
	toggleLayoutTranslate: () => void;
};

export function usePdfLayoutAnalysis({
	docId,
	paperAbsPath,
	paperRelPath,
	isActive,
	totalPages,
	hostRef,
	zoomLevel,
	layoutCap,
	layoutCapRef,
	selectionMenuRef,
	regionSelectingRef,
	visualCropPendingRef,
	beginVisualAnnotationRef,
}: UsePdfLayoutAnalysisOptions): PdfLayoutAnalysis {
	const { t } = useTranslation("viewer");
	const [visualDraftEditor, setVisualDraftEditor] =
		useState<VisualDraftEditorState | null>(null);
	/** Formula hover → Annotation.md symbol glossary (when present). */
	const [formulaAnnotationPreview, setFormulaAnnotationPreview] =
		useState<FormulaAnnotationPreviewState | null>(null);
	/** Parsed rows from `{paper}/Annotation.md` (empty when missing). */
	const [equationSymbols, setEquationSymbols] = useState<EquationSymbol[]>([]);
	const visualDraftEditorRef = useRef(visualDraftEditor);
	visualDraftEditorRef.current = visualDraftEditor;
	const formulaAnnotationPreviewRef = useRef(formulaAnnotationPreview);
	formulaAnnotationPreviewRef.current = formulaAnnotationPreview;
	const equationSymbolsRef = useRef(equationSymbols);
	equationSymbolsRef.current = equationSymbols;
	const totalPagesRef = useRef(totalPages);
	totalPagesRef.current = totalPages;

	/** Figures rail header toggles this; mirror into EmbedPDF plugin. */
	const layoutOverlayVisible = useStore(
		layoutAnalysisStore,
		(s) => s.overlayVisible[docId] ?? false,
	);
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
	/**
	 * Hover hit targets and debug boxes, bucketed by page. Both passes are
	 * whole-document (NMS / spurious-detection suppression), so they must not run
	 * inside per-page render — scrolling re-renders every mounted page.
	 */
	const hoverableRegionsByPage = useMemo(
		() =>
			layoutDocRegions
				? hoverableLayoutRegionsByPage(layoutDocRegions)
				: EMPTY_LAYOUT_REGIONS_BY_PAGE,
		[layoutDocRegions],
	);
	const rawRegionsByPage = useMemo(
		() =>
			layoutOverlayVisible && layoutRawRegions
				? rawLayoutRegionsByPage(layoutRawRegions)
				: EMPTY_LAYOUT_REGIONS_BY_PAGE,
		[layoutOverlayVisible, layoutRawRegions],
	);
	/** Progressive layout bulk-translate overlays (body text / abstract / header). */
	const [layoutTranslateJob, setLayoutTranslateJob] = useState<{
		status: LayoutTranslateJobStatus;
		items: LayoutTranslateItem[];
	}>({ status: "idle", items: [] });
	const layoutTranslateAbortRef = useRef<AbortController | null>(null);
	const layoutTaskRef = useRef<LayoutAnalysisTask | null>(null);

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
		[hostRef],
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

	/**
	 * Open the region-crop draft card. Sole entry point for `visualDraftEditor`,
	 * so the「draft ⇄ formula legend are mutually exclusive」invariant lives with
	 * both states instead of in every caller.
	 */
	const openVisualDraftEditor = useCallback(
		(draft: VisualDraftEditorState) => {
			// Visual draft and formula legend are mutually exclusive.
			closeFormulaAnnotationPreview();
			// Pointer is still over the region when hover-open completes; keep
			// the surface active so unmounting hit targets does not auto-hide.
			if (draft.ephemeral) {
				layoutDraftHoverSurfaceRef.current = true;
				cancelLayoutDraftHide();
			}
			setVisualDraftEditor(draft);
			layoutHoverRegionIdRef.current = null;
		},
		[cancelLayoutDraftHide, closeFormulaAnnotationPreview],
	);

	/**
	 * True while another interaction owns the page: region framing, an in-flight
	 * crop, an open visual draft, or the selection menu. Layout hover must not
	 * open on top of any of them.
	 */
	const layoutHoverBlocked = useCallback(
		() =>
			Boolean(
				regionSelectingRef.current ||
					visualCropPendingRef.current ||
					visualDraftEditorRef.current ||
					selectionMenuRef.current,
			),
		[selectionMenuRef, regionSelectingRef, visualCropPendingRef],
	);

	/**
	 * After dwelling on a layout region:
	 * - formula + Annotation.md symbols → 「公式解析」glossary card (light UX)
	 * - otherwise → same visual editor as manual region-select (crop only)
	 */
	const scheduleLayoutHoverOpen = useCallback(
		(region: PdfLayoutRegion) => {
			if (layoutHoverBlocked()) return;

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
					if (layoutHoverBlocked()) return;
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
				if (layoutHoverBlocked() || formulaAnnotationPreviewRef.current) return;
				setFocusedLayoutRegion(docId, region.id);
				const seq = ++layoutHoverSeqRef.current;
				beginVisualAnnotationRef.current(region.pageIndex + 1, region.bbox, {
					seq,
					ephemeral: true,
				});
			}, LAYOUT_HOVER_DWELL_MS);
		},
		[
			beginVisualAnnotationRef,
			cancelFormulaHover,
			cancelLayoutHover,
			docId,
			layoutHoverBlocked,
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
		[
			cancelFormulaHover,
			cancelLayoutHover,
			scheduleFormulaHide,
			visualCropPendingRef,
		],
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

	/**
	 * Run layout analysis for this document.
	 * - force: re-run PP-DocLayoutV3 (PDF→JSON) even when source/layout.json exists
	 * - without force: prefer layout.json → merge → sidebar when paper has a sidecar
	 * - openFigures / showOverlay: UI side-effects for the manual Figures button
	 * - asBackgroundTask: surface progress in the IDE background-tasks panel
	 */
	const startLayoutAnalysis = useCallback(
		(opts?: StartLayoutAnalysisOptions) => {
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
		[docId, paperAbsPath, paperRelPath, t, layoutCapRef],
	);
	const startLayoutAnalysisRef = useRef(startLayoutAnalysis);
	startLayoutAnalysisRef.current = startLayoutAnalysis;

	// Any open paper (active or not) → headless queue so multi-tab can all
	// land in the background-tasks panel. ONNX still serial (concurrency:1).
	useEffect(() => {
		if (!paperAbsPath) return;
		enqueuePaperLayoutAnalysis({ paperAbsPath });
	}, [paperAbsPath]);

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

	const layoutTranslateRunning = layoutTranslateJob.status === "running";
	const layoutTranslateActive =
		layoutTranslateRunning ||
		layoutTranslateJob.items.some((it) => it.translated);
	const layoutTranslateLabel = layoutTranslateRunning
		? t("pdf.layoutTranslate.stop")
		: layoutTranslateActive
			? t("pdf.layoutTranslate.clear")
			: t("pdf.layoutTranslate.start");

	return {
		layoutOverlayVisible,
		hoverableRegionsByPage,
		rawRegionsByPage,
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
		startLayoutAnalysisRef,
		layoutTaskRef,
		layoutTranslateJob,
		layoutTranslateRunning,
		layoutTranslateActive,
		layoutTranslateLabel,
		toggleLayoutTranslate,
	};
}
