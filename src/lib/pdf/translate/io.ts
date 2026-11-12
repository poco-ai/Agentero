import { nanoid } from "nanoid";
import { createMarkStore } from "@/lib/pdf/marks/io";
import { parsePdfTranslateRecord } from "@/lib/pdf/translate/schema";
import type {
	PdfTranslateRecord,
	PdfTranslateRect,
} from "@/lib/pdf/translate/types";

const store = createMarkStore<PdfTranslateRecord>({
	parse: parsePdfTranslateRecord,
	sort: (a, b) => b.createdAt.localeCompare(a.createdAt),
	prepareWrite: (record) => ({
		...record,
		kind: "translate",
		updatedAt: record.updatedAt ?? new Date().toISOString(),
	}),
	requireIdOnDelete: true,
});

export function newTranslateId(): string {
	return nanoid(10);
}

export function createTranslateRecord(input: {
	paperPath: string;
	page: number;
	rects: PdfTranslateRect[];
	selectionPages?: PdfTranslateRecord["selectionPages"];
	quote?: string;
	result?: string;
	error?: string;
	id?: string;
}): PdfTranslateRecord {
	const now = new Date().toISOString();
	const rec: PdfTranslateRecord = {
		version: 1,
		kind: "translate",
		id: input.id ?? newTranslateId(),
		paperPath: input.paperPath,
		createdAt: now,
		updatedAt: now,
		page: Math.max(1, Math.floor(input.page)),
		rects: input.rects,
		pinned: false,
	};
	if (input.quote?.trim()) rec.quote = input.quote.trim();
	if (input.selectionPages?.length) rec.selectionPages = input.selectionPages;
	if (input.result?.trim()) rec.result = input.result.trim();
	if (input.error?.trim()) rec.error = input.error.trim();
	return rec;
}

export const listPdfTranslates = store.list;
export const writePdfTranslate = store.write;
export const deletePdfTranslate = store.remove;
