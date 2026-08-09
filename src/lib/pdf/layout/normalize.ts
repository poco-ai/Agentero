import type {
	DocumentLayout,
	LayoutBlock,
	PageLayout,
} from "@embedpdf/plugin-layout-analysis";

import { clamp01 } from "@/lib/core/math";
import { layoutLabelToKind } from "@/lib/pdf/layout/labels";
import { mergeCaptionsIntoHosts } from "@/lib/pdf/layout/merge-captions";
import type {
	PdfLayoutDocumentResult,
	PdfLayoutKind,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";

function emptyCounts(): Record<PdfLayoutKind, number> {
	return {
		image: 0,
		table: 0,
		algorithm: 0,
		formula: 0,
		formula_number: 0,
		chart: 0,
		figure_title: 0,
		header: 0,
		abstract: 0,
		text: 0,
	};
}

function blockToRegion(
	block: LayoutBlock,
	pageIndex: number,
	pageWidth: number,
	pageHeight: number,
): PdfLayoutRegion | null {
	const kind = layoutLabelToKind(block.label);
	if (!kind) return null;
	if (pageWidth <= 0 || pageHeight <= 0) return null;

	const x = block.rect.origin.x;
	const y = block.rect.origin.y;
	const w = block.rect.size.width;
	const h = block.rect.size.height;
	if (!(w > 0 && h > 0)) return null;

	return {
		id: block.id,
		pageIndex,
		kind,
		label: block.label,
		score: block.score,
		readingOrder: block.readingOrder,
		rect: { x, y, w, h },
		bbox: {
			x: clamp01(x / pageWidth),
			y: clamp01(y / pageHeight),
			w: clamp01(w / pageWidth),
			h: clamp01(h / pageHeight),
		},
	};
}

/** All mapped blocks including caption candidates (pre-merge). */
export function pageLayoutToRegions(layout: PageLayout): PdfLayoutRegion[] {
	const pageWidth = layout.pageSize.width;
	const pageHeight = layout.pageSize.height;
	const out: PdfLayoutRegion[] = [];
	for (const block of layout.blocks) {
		const region = blockToRegion(
			block,
			layout.pageIndex,
			pageWidth,
			pageHeight,
		);
		if (region) out.push(region);
	}
	out.sort(
		(a, b) => a.readingOrder - b.readingOrder || a.kind.localeCompare(b.kind),
	);
	return out;
}

/** Flatten document layout to raw regions (no caption merge). */
export function regionsFromDocumentLayout(
	layout: DocumentLayout,
): PdfLayoutRegion[] {
	return layout.pages.flatMap((page) => pageLayoutToRegions(page));
}

export function buildLayoutDocumentResult(
	documentId: string,
	regions: PdfLayoutRegion[],
	/** Pre-merge detections; defaults to `regions` when not provided. */
	rawRegions: PdfLayoutRegion[] = regions,
): PdfLayoutDocumentResult {
	const counts = emptyCounts();
	for (const region of regions) {
		counts[region.kind] += 1;
	}
	return {
		documentId,
		updatedAt: Date.now(),
		regions,
		rawRegions,
		counts,
	};
}

/**
 * Sync path: geometric merge only (no PDF text). Prefer
 * `runDocumentLayoutAnalysis` for text-aware Table/Figure roles.
 */
export function documentLayoutToResult(
	documentId: string,
	layout: DocumentLayout,
): PdfLayoutDocumentResult {
	const raw = regionsFromDocumentLayout(layout);
	const regions = mergeCaptionsIntoHosts(raw);
	return buildLayoutDocumentResult(documentId, regions, raw);
}

export function summarizeLayoutResult(result: PdfLayoutDocumentResult): string {
	const { counts } = result;
	const titled = result.regions.filter((r) => Boolean(r.title?.trim())).length;
	const formulaPart = counts.formula > 0 ? `, formula ${counts.formula}` : "";
	return `image ${counts.image}, chart ${counts.chart}, table ${counts.table}, algorithm ${counts.algorithm}${formulaPart}${titled ? `, titled ${titled}` : ""}`;
}
