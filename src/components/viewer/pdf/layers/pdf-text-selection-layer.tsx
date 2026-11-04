import { useDocumentState } from "@embedpdf/core/react";
import type { Rect } from "@embedpdf/models";
import {
	type FormattedSelection,
	useSelectionCapability,
	useSelectionPlugin,
} from "@embedpdf/plugin-selection/react";
import {
	memo,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import {
	linkPreviewDragActive,
	subscribeLinkPreviewDrag,
} from "@/lib/pdf/link-preview-drag";
import { buildTightSelectionRects } from "@/lib/pdf/selection-appearance";

/**
 * A translation drag hits the English glyphs underneath as well. Those rects
 * sit under the Chinese and show through the gaps, so two characters gain a
 * darker patch once the drag settles into a line. Hide them while the reader
 * is selecting the translation itself.
 */
function translationSelectionCovering(): boolean {
	if (typeof document === "undefined") return false;
	if (linkPreviewDragActive()) return true;
	const selection = document.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
		return false;
	}
	const node = selection.getRangeAt(0).startContainer;
	const el = node instanceof Element ? node : node.parentElement;
	return Boolean(el?.closest("[data-layout-item], [data-reflow-selection]"));
}

function subscribeTranslationCover(onChange: () => void): () => void {
	const unsubscribe = subscribeLinkPreviewDrag(onChange);
	document.addEventListener("selectionchange", onChange);
	return () => {
		unsubscribe();
		document.removeEventListener("selectionchange", onChange);
	};
}

export type PdfTextSelectionLayerProps = {
	documentId: string;
	pageIndex: number;
	background: string;
	/**
	 * Registering with the selection plugin triggers PDFium `getPageGeometry`
	 * for this page. That extraction is O(glyphs) and runs in the single worker
	 * shared with raster/tile rendering, so it is deferred until the pointer
	 * reaches the page (see {@link PdfPageLayers}) instead of firing for every
	 * mounted page on open.
	 */
	armed: boolean;
	draftPages?: FormattedSelection[];
};

/**
 * Zotero-like PDF text selection. Selection behavior stays owned by EmbedPDF;
 * only the visual rectangles are rebuilt from PDFium's tight glyph bounds.
 */
export const PdfTextSelectionLayer = memo(function PdfTextSelectionLayer({
	documentId,
	pageIndex,
	background,
	armed,
	draftPages,
}: PdfTextSelectionLayerProps) {
	const { plugin } = useSelectionPlugin();
	const { provides } = useSelectionCapability();
	const documentState = useDocumentState(documentId);
	const [rects, setRects] = useState<Rect[]>([]);
	const scale = useMemo(
		() => documentState?.scale ?? 1,
		[documentState?.scale],
	);

	useEffect(() => {
		if (!armed) return;
		if (!plugin || !provides) return;

		return plugin.registerSelectionOnPage({
			documentId,
			pageIndex,
			onRectsChange: ({ rects: sourceRects }) => {
				if (sourceRects.length === 0) {
					setRects([]);
					return;
				}

				const state = provides.forDocument(documentId).getState();
				setRects(
					buildTightSelectionRects(
						state.geometry[pageIndex],
						state.selection,
						pageIndex,
					),
				);
			},
		});
	}, [armed, documentId, pageIndex, plugin, provides]);

	const draftRects = useMemo(() => {
		const page = draftPages?.find((p) => p.pageIndex === pageIndex);
		return page?.segmentRects?.length
			? page.segmentRects
			: page?.rect
				? [page.rect]
				: [];
	}, [draftPages, pageIndex]);

	const coveredByTranslation = useSyncExternalStore(
		subscribeTranslationCover,
		translationSelectionCovering,
		() => false,
	);
	const effectiveRects = rects.length > 0 ? rects : draftRects;

	if (coveredByTranslation || effectiveRects.length === 0) return null;

	return (
		<div
			aria-hidden="true"
			style={{
				position: "absolute",
				inset: 0,
				// Above layout-translate paper (z-3) so the tint stays visible, and
				// under the translated glyphs (z-6). An opaque block here would
				// hide the highlight; this tint on top of the glyphs washes them out.
				zIndex: 5,
				isolation: "isolate",
				mixBlendMode: "multiply",
				pointerEvents: "none",
			}}
		>
			{effectiveRects.map((rect) => (
				<div
					key={`${rect.origin.x}:${rect.origin.y}:${rect.size.width}:${rect.size.height}`}
					style={{
						position: "absolute",
						left: rect.origin.x * scale,
						top: rect.origin.y * scale,
						width: rect.size.width * scale,
						height: rect.size.height * scale,
						background,
						borderRadius: 1,
					}}
				/>
			))}
		</div>
	);
});
