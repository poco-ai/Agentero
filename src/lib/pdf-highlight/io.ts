import { nanoid } from "nanoid";

import { parsePdfHighlight } from "@/lib/pdf-highlight/schema";
import type { PdfHighlight, PdfHighlightRect } from "@/lib/pdf-highlight/types";
import { makeSidecarStore } from "@/lib/sidecar-store";

const store = makeSidecarStore<PdfHighlight>({
	kind: "highlight",
	parse: parsePdfHighlight,
	sortKey: "createdAt",
	stampUpdatedAt: "always",
});

export function newHighlightId(): string {
	return nanoid(10);
}

export function createHighlight(input: {
	paperPath: string;
	page: number;
	rects: PdfHighlightRect[];
	quote: string;
	color?: string;
	comment?: string;
	id?: string;
}): PdfHighlight {
	const now = new Date().toISOString();
	const highlight: PdfHighlight = {
		version: 1,
		kind: "highlight",
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

export function listPdfHighlights(
	paperAbsPath: string,
): Promise<PdfHighlight[]> {
	return store.list(paperAbsPath);
}

export function writePdfHighlight(
	paperAbsPath: string,
	highlight: PdfHighlight,
): Promise<void> {
	return store.write(paperAbsPath, highlight);
}

export function deletePdfHighlight(
	paperAbsPath: string,
	id: string,
): Promise<void> {
	return store.remove(paperAbsPath, id);
}

export function readPdfHighlight(
	paperAbsPath: string,
	id: string,
): Promise<PdfHighlight | null> {
	return store.read(paperAbsPath, id);
}
