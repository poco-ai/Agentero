import type { PdfHighlight, PdfHighlightRect } from "@/lib/pdf/highlight/types";
import { isRecord, isRect } from "@/lib/pdf/marks/schema";

/** Validate and normalize a text-markup JSON payload. Returns null if invalid. */
export function parsePdfHighlight(raw: unknown): PdfHighlight | null {
	if (!isRecord(raw)) return null;
	if (raw.version !== 1) return null;
	if (typeof raw.id !== "string" || !raw.id) return null;
	if (typeof raw.paperPath !== "string") return null;
	if (typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string") {
		return null;
	}
	if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return null;
	if (!Array.isArray(raw.rects) || !raw.rects.every(isRect)) return null;
	if (typeof raw.quote !== "string") return null;

	const highlight: PdfHighlight = {
		version: 1,
		// Unknown shapes from a newer client render as highlights instead of
		// dropping the annotation and its note.
		kind: raw.kind === "underline" ? "underline" : "highlight",
		id: raw.id,
		paperPath: raw.paperPath,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
		page: Math.max(1, Math.floor(raw.page)),
		rects: raw.rects as PdfHighlightRect[],
		quote: raw.quote,
	};
	if (typeof raw.color === "string") highlight.color = raw.color;
	if (typeof raw.comment === "string" && raw.comment.trim()) {
		highlight.comment = raw.comment.trim();
	}
	return highlight;
}
