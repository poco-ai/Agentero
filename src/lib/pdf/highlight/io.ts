import { nanoid } from "nanoid";
import { parsePdfHighlight } from "@/lib/pdf/highlight/schema";
import type {
	PdfHighlight,
	PdfHighlightRect,
	PdfTextMarkupKind,
} from "@/lib/pdf/highlight/types";
import { createMarkStore } from "@/lib/pdf/marks/io";

/**
 * Marks IO for **legacy / read-side** highlight files (`marks/*.json`).
 * Runtime write path is {@link annotation-store} (EmbedPDF annotations);
 * keep only list + factory helpers used by migrate/heatmap/tests.
 */

const store = createMarkStore<PdfHighlight>({
	parse: parsePdfHighlight,
	sort: (a, b) => b.createdAt.localeCompare(a.createdAt),
	noMemory: true,
});

export function newHighlightId(): string {
	return nanoid(10);
}

export function createHighlight(input: {
	paperPath: string;
	page: number;
	rects: PdfHighlightRect[];
	quote: string;
	kind?: PdfTextMarkupKind;
	color?: string;
	comment?: string;
	id?: string;
}): PdfHighlight {
	const now = new Date().toISOString();
	const highlight: PdfHighlight = {
		version: 1,
		kind: input.kind ?? "highlight",
		id: input.id ?? newHighlightId(),
		paperPath: input.paperPath,
		createdAt: now,
		updatedAt: now,
		page: Math.max(1, Math.floor(input.page)),
		rects: input.rects,
		quote: input.quote,
	};
	if (input.color) highlight.color = input.color;
	if (input.comment?.trim()) highlight.comment = input.comment.trim();
	return highlight;
}

/** List legacy mark-file highlights (migration / reading heatmap). */
export const listPdfHighlights = store.list;
