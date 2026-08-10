/**
 * Figure / formula hover for layout regions, and the two cards it opens.
 *
 * Dwelling on a figure, table or algorithm opens a region-crop draft card;
 * dwelling on a formula opens the `{paper}/Annotation.md` glossary card. The two
 * cards are **mutually exclusive**, which is why this hook owns both
 * `visualDraftEditor` and `formulaAnnotationPreview` even though the draft
 * card's *content* belongs to {@link usePdfVisualMarks}: the setters stay
 * private and `openVisualDraftEditor` / `closeVisualDraftEditor` /
 * `closeFormulaAnnotationPreview` are the only transitions, so neither state can
 * move without the other's guard.
 *
 * The crop itself belongs to the visual-mark cluster (it owns the engine call
 * and every save path), so the dwell timer reaches it through the parent-owned
 * `beginVisualAnnotationRef` and this hook only receives the opened draft.
 */

import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { pageElByIndex } from "@/components/viewer/pdf/coords";
import type { BeginVisualAnnotationOptions } from "@/components/viewer/pdf/hooks/use-pdf-region-framing";
import type {
	FormulaAnnotationPreviewState,
	ScreenPoint,
	SelectionMenuState,
	VisualDraftEditorState,
} from "@/components/viewer/pdf/types";
import { isTauri } from "@/lib/core/tauri";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import {
	type EquationSymbol,
	equationAnnotationPath,
	loadEquationAnnotation,
} from "@/lib/pdf/equation-annotation";
import {
	isFormulaLayoutKind,
	LAYOUT_FORMULA_HOVER_DWELL_MS,
	LAYOUT_FORMULA_HOVER_HIDE_MS,
	LAYOUT_HOVER_DWELL_MS,
	LAYOUT_HOVER_HIDE_MS,
	type PdfLayoutRegion,
	setFocusedLayoutRegion,
} from "@/lib/pdf/layout";
import {
	VAULT_FILE_CHANGED_EVENT,
	type VaultFileChangedPayload,
} from "@/lib/vault/fs-watch";
import { normalizePathKey } from "@/lib/vault/path";

export type UsePdfLayoutHoverOptions = {
	docId: string;
	/** Paper folder: `Annotation.md` glossary root (null for loose PDFs). */
	paperAbsPath: string | null;
	hostRef: RefObject<HTMLDivElement | null>;
	/** Current zoom: the open formula legend re-anchors when it changes. */
	zoomLevel: number;
	/** Text-selection cluster: an open menu blocks layout hover. */
	selectionMenuRef: RefObject<SelectionMenuState | null>;
	/**
	 * Visual-mark cluster mirrors (parent-owned): region framing or an in-flight
	 * crop blocks layout hover.
	 */
	regionSelectingRef: RefObject<boolean>;
	visualCropPendingRef: RefObject<boolean>;
	/**
	 * Latest `beginVisualAnnotation`. Parent-owned because the visual-mark hook
	 * consumes this hook's draft-card API and is therefore declared after it.
	 */
	beginVisualAnnotationRef: RefObject<
		(
			page: number,
			region: PdfAskNormalizedRect,
			opts?: BeginVisualAnnotationOptions,
		) => void
	>;
};

export type PdfLayoutHover = {
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
	) => ScreenPoint;
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
};

export function usePdfLayoutHover({
	docId,
	paperAbsPath,
	hostRef,
	zoomLevel,
	selectionMenuRef,
	regionSelectingRef,
	visualCropPendingRef,
	beginVisualAnnotationRef,
}: UsePdfLayoutHoverOptions): PdfLayoutHover {
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

	return {
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
	};
}
