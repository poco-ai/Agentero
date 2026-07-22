import { nanoid } from "nanoid";

import { parsePdfTranslateRecord } from "@/lib/pdf-translate/schema";
import type {
	PdfTranslateRecord,
	PdfTranslateRect,
} from "@/lib/pdf-translate/types";
import { makeSidecarStore } from "@/lib/sidecar-store";

const store = makeSidecarStore<PdfTranslateRecord>({
	kind: "translate",
	parse: parsePdfTranslateRecord,
	sortKey: "createdAt",
	// Translate records preserve their own updatedAt when present.
	stampUpdatedAt: "preserve",
});

export function newTranslateId(): string {
	return nanoid(10);
}

export function createTranslateRecord(input: {
	paperPath: string;
	page: number;
	rects: PdfTranslateRect[];
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
	};
	if (input.quote?.trim()) rec.quote = input.quote.trim();
	if (input.result?.trim()) rec.result = input.result.trim();
	if (input.error?.trim()) rec.error = input.error.trim();
	return rec;
}

export function listPdfTranslates(
	paperAbsPath: string,
): Promise<PdfTranslateRecord[]> {
	return store.list(paperAbsPath);
}

export function writePdfTranslate(
	paperAbsPath: string,
	record: PdfTranslateRecord,
): Promise<void> {
	return store.write(paperAbsPath, record);
}

export function deletePdfTranslate(
	paperAbsPath: string,
	id: string,
): Promise<void> {
	return store.remove(paperAbsPath, id);
}

export function readPdfTranslate(
	paperAbsPath: string,
	id: string,
): Promise<PdfTranslateRecord | null> {
	return store.read(paperAbsPath, id);
}
