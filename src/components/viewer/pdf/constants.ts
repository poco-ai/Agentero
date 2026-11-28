/**
 * Raster caps and stable identities shared by every rendered PDF page.
 *
 * The empty collections and the layer style must be module-level singletons:
 * page subtrees are memoized, and a fresh literal per render would defeat the
 * bail-out for every mounted page on every scroll frame.
 */

import type { PdfLinkAnnoObject } from "@embedpdf/models";
import type { CSSProperties } from "react";
import type { PageAnnotationComment } from "@/components/viewer/pdf/types";
import type { PdfLayoutRegion } from "@/lib/pdf/layout";
import type { SelectionPin } from "@/lib/pdf/selection";

/**
 * The TilingLayer is the layer users actually read: tiles cover only the
 * viewport, so letting them rasterize at (near-)native dpr
 * keeps small text sharp on HiDPI screens at a bounded cost. Capped at 2 so
 * 3× displays don't explode per-tile WASM work.
 */
const PDF_TILE_DPR_CAP = 2;

export function pdfTileDpr(): number {
	const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
	return Math.min(dpr, PDF_TILE_DPR_CAP);
}

/**
 * A page must stay in view this long before glyph extraction is queued.
 * The raster, the tile, `getPageGeometry`, and `getPageTextRects` share one
 * PDFium worker. A fling moves a page through the viewport faster than this,
 * so those pages never join the glyph queue. Pointer entry still arms
 * selection immediately.
 */
export const PDF_WORKER_SETTLE_MS = 180;

export const EMPTY_LAYOUT_REGIONS_BY_PAGE: ReadonlyMap<
	number,
	PdfLayoutRegion[]
> = new Map();

export const EMPTY_LAYOUT_REGIONS: PdfLayoutRegion[] = [];

export const EMPTY_PINS: SelectionPin[] = [];

export const EMPTY_COMMENTS: PageAnnotationComment[] = [];

export const EMPTY_CITATION_LINKS: PdfLinkAnnoObject[] = [];

export const PAGE_LAYER_STYLE: CSSProperties = {
	position: "absolute",
	inset: 0,
};
