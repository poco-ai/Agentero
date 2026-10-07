/**
 * In-memory layout analysis results keyed by EmbedPDF documentId (tab scope).
 * Step 1 only: bbox collection for UI / console. Sidecar persistence comes later.
 */

import { createStore } from "zustand/vanilla";

import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import { stripEmbedPdfRevision } from "@/lib/pdf/document-id";
import type {
	LayoutAnalysisUiStatus,
	PdfLayoutDocumentResult,
	PdfLayoutKind,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";

/** Inline geometry when focus id is absent from sidebar `regions` (citation jumps). */
export type FocusedLayoutSnapshot = {
	pageIndex: number;
	bbox: PdfAskNormalizedRect;
	kind: PdfLayoutKind;
};

export type FocusedLayoutState = {
	documentId: string;
	regionId: string;
	/**
	 * Stable overlay region built once at focus time. Selectors must return this
	 * reference (not a fresh object) so `useStore` / `useSyncExternalStore`
	 * does not infinite-loop.
	 */
	region?: PdfLayoutRegion;
	/**
	 * Citation-jump attention flash: bright yellow block that auto-clears.
	 * Figures sidebar selection leaves this unset (persistent kind outline).
	 */
	flash?: boolean;
	/** Bumps when the same region is flashed again so the CSS animation restarts. */
	flashToken?: number;
};

/** How long a citation focus flash stays visible before clearing. */
export const CITATION_FOCUS_FLASH_MS = 1600;

let citationFlashClearTimer: ReturnType<typeof setTimeout> | null = null;

type LayoutStoreState = {
	/** Last successful result per document. */
	byDocument: Record<string, PdfLayoutDocumentResult>;
	/** UI progress for the active analysis run (global; one at a time). */
	ui: LayoutAnalysisUiStatus;
	activeDocumentId: string | null;
	/**
	 * Paper folder for the active run (normalized abs path). Headless jobs use a
	 * synthetic documentId (`headless-layout-…`); the Figures sidebar matches on
	 * this path so the open paper still shows progress.
	 */
	activePaperAbsPath: string | null;
	/**
	 * Focused region for PDF overlay + sidebar selection.
	 * `documentId` scopes the highlight to the owning PDF tab.
	 * Optional `region` paints the overlay without a store region lookup
	 * (section headers / page fragments / citation jumps before layout loads).
	 */
	focused: FocusedLayoutState | null;
	/**
	 * Whether the EmbedPDF layout bbox overlay is shown per document.
	 * Figures rail toggles this; PDF viewer mirrors into the plugin.
	 */
	overlayVisible: Record<string, boolean>;
};

/** Normalize paper folder paths for layout progress attribution. */
export function normalizeLayoutPaperKey(path: string): string {
	return path.replace(/[/\\]+$/, "").replace(/\\/g, "/");
}

export const layoutAnalysisStore = createStore<LayoutStoreState>(() => ({
	byDocument: {},
	ui: { stage: "idle" },
	activeDocumentId: null,
	activePaperAbsPath: null,
	focused: null,
	overlayVisible: {},
}));

/**
 * Update analysis UI. Pass `paperAbsPath` on the first `running` tick of a run
 * so headless and viewer-bound jobs attribute progress to the same paper; later
 * progress ticks may omit it and keep the association until a non-running stage.
 */
export function setLayoutAnalysisUi(
	ui: LayoutAnalysisUiStatus,
	documentId?: string | null,
	paperAbsPath?: string | null,
): void {
	layoutAnalysisStore.setState((state) => {
		const nextDocumentId =
			documentId === undefined ? state.activeDocumentId : documentId;
		let nextPaper = state.activePaperAbsPath;
		if (ui.stage === "running") {
			if (paperAbsPath !== undefined) {
				nextPaper = paperAbsPath ? normalizeLayoutPaperKey(paperAbsPath) : null;
			}
		} else {
			nextPaper = null;
		}
		return {
			ui,
			activeDocumentId: nextDocumentId,
			activePaperAbsPath: nextPaper,
		};
	});
}

/**
 * Canonical `byDocument` key. Buffer-backed viewers mount as `tab::r<n>` (one
 * revision per ArrayBuffer read), while cross-pane writers/readers — the
 * source pane's layout run, `openTranslationTab`'s seed, the translation
 * pane's own viewer — each hold a different revision suffix. Strip it so all
 * sides agree on the base id; URL sources and headless synthetic ids pass
 * through unchanged. Selectors that read `s.byDocument` directly must go
 * through this helper too.
 */
export function layoutDocumentKey(docId: string): string {
	return stripEmbedPdfRevision(docId);
}

export function setLayoutDocumentResult(result: PdfLayoutDocumentResult): void {
	const key = layoutDocumentKey(result.documentId);
	const stored =
		key === result.documentId ? result : { ...result, documentId: key };
	layoutAnalysisStore.setState((state) => ({
		byDocument: {
			...state.byDocument,
			[key]: stored,
		},
	}));
}

export function getLayoutDocumentResult(
	documentId: string,
): PdfLayoutDocumentResult | null {
	return (
		layoutAnalysisStore.getState().byDocument[layoutDocumentKey(documentId)] ??
		null
	);
}

/**
 * Source document key for a dual-pane translation pane id (`base::translation`).
 * Returns null when `documentId` is not a translation companion.
 */
export function translationSourceKey(documentId: string): string | null {
	const key = layoutDocumentKey(documentId);
	const suffix = "::translation";
	return key.endsWith(suffix) ? key.slice(0, -suffix.length) : null;
}

/**
 * Keep a translation pane's layout result mirrored from its source document.
 *
 * `openTranslationTab` seeds a one-shot snapshot when the pane opens; if layout
 * analysis was still running then, the source result lands later under the
 * source key and never reaches the pane. Subscribe so the pane's auto-start can
 * still fire once regions are ready (and re-mirror when the source re-analyzes).
 *
 * Returns an unsubscribe function.
 */
export function mirrorLayoutResultToTranslation(
	translationDocId: string,
	sourceKey: string,
): () => void {
	const translationKey = layoutDocumentKey(translationDocId);
	let seededFrom: PdfLayoutDocumentResult | null = null;
	const sync = () => {
		const source = getLayoutDocumentResult(sourceKey);
		if (!source || source === seededFrom) return;
		seededFrom = source;
		setLayoutDocumentResult({ ...source, documentId: translationKey });
	};
	sync();
	return layoutAnalysisStore.subscribe(sync);
}

export function clearLayoutDocumentResult(documentId: string): void {
	const key = layoutDocumentKey(documentId);
	layoutAnalysisStore.setState((state) => {
		if (!(key in state.byDocument)) return state;
		const next = { ...state.byDocument };
		delete next[key];
		// focused/overlayVisible keep the caller's raw id form (same-viewer
		// writers); clear whichever form this entry may have used.
		const focused =
			state.focused?.documentId === documentId ||
			state.focused?.documentId === key
				? null
				: state.focused;
		const overlayVisible = { ...state.overlayVisible };
		delete overlayVisible[documentId];
		delete overlayVisible[key];
		return { byDocument: next, focused, overlayVisible };
	});
}

export function setLayoutOverlayVisible(
	documentId: string,
	visible: boolean,
): void {
	layoutAnalysisStore.setState((state) => {
		if ((state.overlayVisible[documentId] ?? false) === visible) return state;
		return {
			overlayVisible: {
				...state.overlayVisible,
				[documentId]: visible,
			},
		};
	});
}

export function toggleLayoutOverlayVisible(documentId: string): boolean {
	const next = !(
		layoutAnalysisStore.getState().overlayVisible[documentId] ?? false
	);
	setLayoutOverlayVisible(documentId, next);
	return next;
}

export function isLayoutOverlayVisible(documentId: string): boolean {
	return layoutAnalysisStore.getState().overlayVisible[documentId] ?? false;
}

function sameFocusedBbox(
	a: PdfAskNormalizedRect | undefined,
	b: PdfAskNormalizedRect | undefined,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * Section headers from layout OCR are often a ~1% tall title strip. Expand to
 * a readable preview block (title + following body) so citation jumps are visible.
 */
export function expandFocusBboxForOverlay(
	bbox: PdfAskNormalizedRect,
	kind: PdfLayoutKind,
): PdfAskNormalizedRect {
	if (kind !== "header" || bbox.h >= 0.05) return bbox;
	const top = Math.max(0, bbox.y - 0.008);
	const left = Math.min(Math.max(0, bbox.x - 0.02), 0.12);
	const right = 0.92;
	const previewH = 0.28;
	const h = Math.min(previewH, Math.max(0.08, 1 - top));
	const w = Math.max(bbox.w, right - left);
	return {
		x: left,
		y: top,
		w: Math.min(w, 1 - left),
		h,
	};
}

function regionFromSnapshot(
	regionId: string,
	snapshot: FocusedLayoutSnapshot,
): PdfLayoutRegion {
	const bbox = expandFocusBboxForOverlay(snapshot.bbox, snapshot.kind);
	return {
		id: regionId,
		pageIndex: snapshot.pageIndex,
		kind: snapshot.kind,
		label: snapshot.kind,
		score: 1,
		readingOrder: 0,
		rect: { x: 0, y: 0, w: 0, h: 0 },
		bbox,
	};
}

export function setFocusedLayoutRegion(
	documentId: string,
	regionId: string | null,
	snapshot?: FocusedLayoutSnapshot,
	options?: { flash?: boolean },
): void {
	if (citationFlashClearTimer) {
		clearTimeout(citationFlashClearTimer);
		citationFlashClearTimer = null;
	}

	const current = layoutAnalysisStore.getState().focused;
	if (!regionId) {
		if (current == null) return;
		layoutAnalysisStore.setState({ focused: null });
		return;
	}

	const flash = Boolean(options?.flash);
	const region = snapshot ? regionFromSnapshot(regionId, snapshot) : undefined;
	if (
		!flash &&
		current?.documentId === documentId &&
		current.regionId === regionId &&
		!current.flash &&
		current.region?.kind === region?.kind &&
		current.region?.pageIndex === region?.pageIndex &&
		sameFocusedBbox(current.region?.bbox, region?.bbox) &&
		// Both missing region (id-only focus) or both present — treat as no-op.
		Boolean(current.region) === Boolean(region)
	) {
		return;
	}

	const flashToken = flash ? (current?.flashToken ?? 0) + 1 : undefined;
	layoutAnalysisStore.setState({
		focused: {
			documentId,
			regionId,
			...(region ? { region } : {}),
			...(flash ? { flash: true, flashToken } : {}),
		},
	});

	if (flash) {
		citationFlashClearTimer = setTimeout(() => {
			citationFlashClearTimer = null;
			const still = layoutAnalysisStore.getState().focused;
			if (
				still?.documentId === documentId &&
				still.regionId === regionId &&
				still.flash
			) {
				layoutAnalysisStore.setState({ focused: null });
			}
		}, CITATION_FOCUS_FLASH_MS);
	}
}

export function getFocusedLayoutRegion(documentId: string): string | null {
	const focused = layoutAnalysisStore.getState().focused;
	if (!focused || focused.documentId !== documentId) return null;
	return focused.regionId;
}

/** Infer a layout kind for citation / synthetic region ids. */
export function layoutKindFromCitationFragment(
	fragment: string,
): PdfLayoutKind {
	const key = (fragment.split("=")[0] ?? "").toLowerCase();
	switch (key) {
		case "figure":
			return "image";
		case "table":
			return "table";
		case "algorithm":
			return "algorithm";
		case "formula":
			return "formula";
		case "section":
			return "header";
		case "page":
			return "text";
		case "region":
			return layoutKindFromRegionId(fragment.slice("region=".length));
		default:
			return "header";
	}
}

export function layoutKindFromRegionId(regionId: string): PdfLayoutKind {
	const id = regionId.toLowerCase();
	if (
		id.startsWith("figure") ||
		id.startsWith("image") ||
		id.startsWith("chart")
	) {
		return id.startsWith("chart") ? "chart" : "image";
	}
	if (id.startsWith("table")) return "table";
	if (id.startsWith("algorithm")) return "algorithm";
	if (id.startsWith("formula")) return "formula";
	if (id.startsWith("page-")) return "text";
	return "header";
}

/**
 * Drop every document's layout analysis. Keys are tab-scoped documentIds and a
 * vault switch closes all tabs, so these results can never be reused.
 */
export function clearLayoutVaultState(): void {
	layoutAnalysisStore.setState({
		byDocument: {},
		ui: { stage: "idle" },
		activeDocumentId: null,
		activePaperAbsPath: null,
		focused: null,
		overlayVisible: {},
	});
}
