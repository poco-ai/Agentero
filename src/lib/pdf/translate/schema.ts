import { isRecord, isRect } from "@/lib/pdf/marks/schema";
import type {
	PdfTranslateRecord,
	PdfTranslateRect,
} from "@/lib/pdf/translate/types";

/** Validate and normalize a translate JSON payload. Returns null if invalid. */
export function parsePdfTranslateRecord(
	raw: unknown,
): PdfTranslateRecord | null {
	if (!isRecord(raw)) return null;
	if (raw.version !== 1) return null;
	if (raw.kind !== "translate") return null;
	if (typeof raw.id !== "string" || !raw.id) return null;
	if (typeof raw.paperPath !== "string") return null;
	if (typeof raw.createdAt !== "string") return null;
	if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return null;
	if (!Array.isArray(raw.rects) || !raw.rects.every(isRect)) return null;

	const rec: PdfTranslateRecord = {
		version: 1,
		kind: "translate",
		id: raw.id,
		paperPath: raw.paperPath,
		createdAt: raw.createdAt,
		page: Math.max(1, Math.floor(raw.page)),
		rects: raw.rects as PdfTranslateRect[],
		// Legacy results had a persistent reopen marker; keep that behavior.
		pinned: raw.pinned === undefined || raw.pinned === true,
	};
	if (typeof raw.quote === "string") rec.quote = raw.quote;
	if (Array.isArray(raw.selectionPages)) {
		const pages = raw.selectionPages.flatMap((page) =>
			isRecord(page) &&
			typeof page.page === "number" &&
			Number.isInteger(page.page) &&
			page.page >= 1 &&
			Array.isArray(page.rects) &&
			page.rects.length > 0 &&
			page.rects.every(isRect)
				? [{ page: page.page, rects: page.rects as PdfTranslateRect[] }]
				: [],
		);
		if (pages.length) rec.selectionPages = pages;
	}
	if (typeof raw.updatedAt === "string") rec.updatedAt = raw.updatedAt;
	if (typeof raw.result === "string") rec.result = raw.result;
	if (typeof raw.error === "string") rec.error = raw.error;
	return rec;
}
