/**
 * Page navigation and reading position.
 *
 * Grouped because they are one user-visible behaviour: the page field, jumping
 * to a page, and the "reopen where I left off" pair (restore once the document
 * reports its page count, then persist debounced as the user scrolls). The
 * restore must run exactly once per document, which is why it owns
 * `restoredRef` rather than reading it from the shell.
 */

import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import {
	type useScroll,
	useScrollCapability,
} from "@embedpdf/plugin-scroll/react";
import type { useZoom } from "@embedpdf/plugin-zoom/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type PdfNavigationRegion,
	type PdfNavigationTarget,
	registerPdfNavigationOwner,
} from "@/lib/pdf/pending-pdf-page";
import { readReadingPage, writeReadingPage } from "@/lib/pdf/reading-position";
import { scrollToPdfRegion } from "@/lib/pdf/region-navigation";
import {
	capturePdfReloadPosition,
	type PdfReloadPosition,
	pdfReloadScrollTarget,
} from "@/lib/pdf/reload-position";
import { getScrollSyncElement } from "@/lib/pdf/scroll-sync";

/** Debounce for persisting the last read page while scrolling. */
const READING_POSITION_SAVE_MS = 400;

type ScrollCapability = ReturnType<typeof useScroll>["provides"];

export type UsePdfNavigationOptions = {
	docId: string;
	/** Stable workspace tab id; distinct from split/translation panes. */
	baseDocId: string;
	embeddedTarget?: PdfNavigationTarget | null;
	embeddedTargetRequest?: number;
	docCapRef: RefObject<
		ReturnType<typeof useDocumentManagerCapability>["provides"]
	>;
	/** Stable per-paper key for the stored reading position (null = no memory). */
	paperKey: string | null;
	currentPage: number;
	totalPages: number;
	scroll: ScrollCapability;
	/** Capability ref: the restore effect must not depend on a fresh scope. */
	scrollRef: RefObject<ScrollCapability>;
	zoomRef?: RefObject<ReturnType<typeof useZoom>["provides"]>;
	reloadPositionRef?: RefObject<PdfReloadPosition | null>;
};

export type PdfNavigation = {
	/** Toolbar input value (page text, not a number). */
	pageField: string;
	setPageField: (value: string) => void;
	/** True while the input has focus; blocks the observed-page sync. */
	pageFocusedRef: RefObject<boolean>;
	/** Clamp and jump; also the outline / citation jump target. */
	goToPage: (page: number) => void;
	goToRegion: (region: PdfNavigationRegion) => void;
	/** Explicit jumps, including repeated targets on the current page. */
	navigationTarget: PdfNavigationTarget | null;
	/** Apply the typed page (falls back to the current page). */
	commitPageField: () => void;
};

export function usePdfNavigation({
	docId,
	baseDocId,
	embeddedTarget,
	embeddedTargetRequest,
	docCapRef,
	paperKey,
	currentPage,
	totalPages,
	scroll,
	scrollRef,
	zoomRef,
	reloadPositionRef,
}: UsePdfNavigationOptions): PdfNavigation {
	const [pageField, setPageField] = useState("1");
	const pageFocusedRef = useRef(false);
	const [navigationTarget, setNavigationTarget] =
		useState<PdfNavigationTarget | null>(null);
	const restoredRef = useRef(false);
	const embeddedTargetRef = useRef(embeddedTarget);
	embeddedTargetRef.current = embeddedTarget;
	const { provides: scrollCapability } = useScrollCapability();
	const ownerRef = useRef<ReturnType<typeof registerPdfNavigationOwner> | null>(
		null,
	);

	// Keep the page-number input in sync with the observed current page.
	useEffect(() => {
		if (!pageFocusedRef.current) setPageField(String(currentPage));
	}, [currentPage]);

	useEffect(() => {
		if (!scrollCapability) return;
		let restoreFrame: number | null = null;
		let disposed = false;
		restoredRef.current = false;
		const owner = registerPdfNavigationOwner(baseDocId, {
			navigate: (target) => {
				const scope = scrollRef.current ?? scrollCapability.forDocument(docId);
				if (!scope) return false;
				if (restoreFrame != null) {
					cancelAnimationFrame(restoreFrame);
					restoreFrame = null;
				}
				restoredRef.current = true;
				if (target.region) {
					scrollToPdfRegion(
						docId,
						target.region,
						docCapRef.current?.getDocument(docId),
						scope,
						{ embedded: target === embeddedTargetRef.current },
					);
				} else {
					scope.scrollToPage({ pageNumber: target.page, behavior: "instant" });
				}
				setNavigationTarget({ ...target });
				return true;
			},
			restore: (pages) => {
				const scope = scrollRef.current ?? scrollCapability.forDocument(docId);
				if (!scope) return false;
				restoredRef.current = true;
				const snapshot = reloadPositionRef?.current;
				if (snapshot && snapshot.documentId !== docId && zoomRef?.current) {
					restoredRef.current = false;
					zoomRef.current.requestZoom(snapshot.zoom);
					// Zoom changes the virtual page layout. Restore only after the
					// new document has rendered at the requested scale.
					let frames = 0;
					const restore = () => {
						if (disposed) return;
						frames += 1;
						const zoom = zoomRef.current?.getState().currentZoomLevel;
						if (frames < 3 || (zoom !== snapshot.zoom && frames < 20)) {
							restoreFrame = requestAnimationFrame(restore);
							return;
						}
						scrollRef.current?.scrollToPage(
							pdfReloadScrollTarget(snapshot, pages),
						);
						restoredRef.current = true;
					};
					restoreFrame = requestAnimationFrame(restore);
					return true;
				}
				if (!paperKey || scope.getMetrics().currentPage > 1) return true;
				const saved = readReadingPage(paperKey);
				if (saved && saved > 1 && saved <= pages) {
					scope.scrollToPage({ pageNumber: saved, behavior: "instant" });
				}
				return true;
			},
		});
		ownerRef.current = owner;
		// EmbedPDF replays layout-ready to late subscribers; capability existence
		// and the provisional page count do not imply that the scroller is mounted.
		const off = scrollCapability.onLayoutReady((event) => {
			if (event.documentId === docId) owner.layoutReady(event.totalPages);
		});
		return () => {
			disposed = true;
			if (restoreFrame != null) cancelAnimationFrame(restoreFrame);
			off();
			owner.dispose();
			if (ownerRef.current === owner) ownerRef.current = null;
		};
	}, [
		docId,
		baseDocId,
		paperKey,
		scrollCapability,
		scrollRef,
		docCapRef,
		zoomRef,
		reloadPositionRef,
	]);

	// Re-queue on owner/target changes or an explicit return request, never on scroll/zoom renders.
	// biome-ignore lint/correctness/useExhaustiveDependencies: owner dependencies and the return-request counter intentionally re-run navigation.
	useEffect(() => {
		if (embeddedTarget) ownerRef.current?.request(embeddedTarget);
	}, [
		embeddedTarget,
		embeddedTargetRequest,
		scrollCapability,
		docId,
		baseDocId,
		paperKey,
		scrollRef,
		docCapRef,
		zoomRef,
		reloadPositionRef,
	]);

	useEffect(() => {
		if (!reloadPositionRef || !scrollCapability) return;
		const scope = scrollCapability.forDocument(docId);
		if (!scope) return;
		const capture = () => {
			if (!restoredRef.current) return;
			try {
				const metrics = scope.getMetrics();
				const state = docCapRef.current?.getDocumentState(docId);
				const page = state?.document?.pages[metrics.currentPage - 1];
				const snapshot = capturePdfReloadPosition(
					docId,
					metrics,
					zoomRef?.current?.getState().currentZoomLevel ?? 1,
					getScrollSyncElement(docId),
					page
						? {
								size: page.size,
								rotation: page.rotation + (state?.rotation ?? 0),
							}
						: undefined,
				);
				if (snapshot) reloadPositionRef.current = snapshot;
			} catch {
				/* The old document scope can already be gone during replacement. */
			}
		};
		const offScroll = scope.onScroll(capture);
		const offZoom = zoomRef?.current?.onZoomChange(capture);
		return () => {
			capture();
			offScroll();
			offZoom?.();
		};
	}, [docId, scrollCapability, reloadPositionRef, zoomRef, docCapRef]);

	// Persist the last read page (debounced) as the user scrolls.
	useEffect(() => {
		if (!paperKey || !restoredRef.current || currentPage < 1) return;
		const id = setTimeout(() => {
			writeReadingPage(paperKey, currentPage);
		}, READING_POSITION_SAVE_MS);
		return () => clearTimeout(id);
	}, [paperKey, currentPage]);

	const goToPage = (n: number) => {
		if (!scroll || totalPages <= 0) return;
		const clamped = Math.min(totalPages, Math.max(1, Math.floor(n)));
		ownerRef.current?.request({ page: clamped });
	};

	const commitPageField = () => {
		const n = Number.parseInt(pageField, 10);
		if (Number.isFinite(n)) goToPage(n);
		else setPageField(String(currentPage));
	};

	const goToRegion = useCallback((region: PdfNavigationRegion) => {
		ownerRef.current?.request({ page: region.pageIndex + 1, region });
	}, []);

	return {
		pageField,
		setPageField,
		pageFocusedRef,
		goToPage,
		navigationTarget,
		goToRegion,
		commitPageField,
	};
}
