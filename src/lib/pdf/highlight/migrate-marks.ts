import type {
	PdfHighlightAnnoObject,
	PdfUnderlineAnnoObject,
	Rect,
	Size,
} from "@embedpdf/models";
import { PdfAnnotationSubtype } from "@embedpdf/models";
import type { AnnotationTransferItem } from "@embedpdf/plugin-annotation/react";

import { listPdfHighlights } from "@/lib/pdf/highlight/io";
import {
	HIGHLIGHT_HEX,
	HIGHLIGHT_OPACITY,
	normalizeHighlightColor,
} from "@/lib/pdf/highlight/palette";
import { deleteMarkFile } from "@/lib/pdf/selection/marks-io";
import { unionRectsAll } from "@/lib/pdf/selection-appearance";

/**
 * One-time migration of legacy normalized-rect highlight marks
 * (`papers/<id>/marks/<id>.json`, kind "highlight" | "underline") into
 * EmbedPDF annotation transfer items (later saved as `marks/annotations.json`).
 * Normalized rects (top-left origin, y-down) are scaled by the page size in
 * points. Ask/Translate marks are left untouched.
 *
 * Migrated text-markup mark files are deleted so `marks/annotations.json`
 * becomes the single source of truth for highlights/批注.
 */
export async function migrateHighlightMarks(
	paperAbsPath: string,
	pageSizePoints: (pageIndex: number) => Size | null,
): Promise<AnnotationTransferItem[]> {
	const olds = await listPdfHighlights(paperAbsPath);
	if (!olds.length) return [];

	const items: AnnotationTransferItem[] = [];
	const migratedIds: string[] = [];

	for (const h of olds) {
		const pageIndex = Math.max(0, Math.floor(h.page) - 1);
		const size = pageSizePoints(pageIndex);
		if (!size) continue;
		const segmentRects: Rect[] = h.rects.map((r) => ({
			origin: { x: r.x * size.width, y: r.y * size.height },
			size: { width: r.w * size.width, height: r.h * size.height },
		}));
		const color = normalizeHighlightColor(h.color);
		const underline = h.kind === "underline";
		const base = {
			id: h.id,
			pageIndex,
			rect: unionRectsAll(segmentRects) ?? { origin: { x: 0, y: 0 }, size },
			segmentRects,
			strokeColor: HIGHLIGHT_HEX[color],
			opacity: underline ? 1 : HIGHLIGHT_OPACITY,
			created: new Date(h.createdAt),
			custom: { app: "agentero", paletteKey: color, quote: h.quote },
		};
		const obj: PdfHighlightAnnoObject | PdfUnderlineAnnoObject = underline
			? { ...base, type: PdfAnnotationSubtype.UNDERLINE }
			: { ...base, type: PdfAnnotationSubtype.HIGHLIGHT };
		if (h.comment?.trim()) obj.contents = h.comment.trim();
		items.push({ annotation: obj });
		migratedIds.push(h.id);
	}

	for (const id of migratedIds) {
		try {
			await deleteMarkFile(paperAbsPath, id);
		} catch {
			// leaving a stale mark is harmless; ignore
		}
	}

	return items;
}
