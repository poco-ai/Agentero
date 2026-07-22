import { nanoid } from "nanoid";

import {
	parsePdfAskThread,
	threadPin,
	threadPreview,
} from "@/lib/pdf-ask/schema";
import type {
	PdfAskAnchor,
	PdfAskThread,
	PdfAskThreadSummary,
} from "@/lib/pdf-ask/types";
import { makeSidecarStore } from "@/lib/sidecar-store";

const store = makeSidecarStore<PdfAskThread>({
	kind: "ask",
	parse: parsePdfAskThread,
	sortKey: "updatedAt",
	stampUpdatedAt: "always",
});

export function newThreadId(): string {
	return nanoid(10);
}

export function newMessageId(): string {
	return nanoid(10);
}

export function createEmptyThread(input: {
	paperPath: string;
	anchor: PdfAskAnchor;
	id?: string;
}): PdfAskThread {
	const now = new Date().toISOString();
	return {
		version: 1,
		kind: "ask",
		id: input.id ?? newThreadId(),
		paperPath: input.paperPath,
		createdAt: now,
		updatedAt: now,
		status: "open",
		anchor: input.anchor,
		messages: [],
	};
}

export function listPdfAskThreads(
	paperAbsPath: string,
): Promise<PdfAskThread[]> {
	return store.list(paperAbsPath);
}

export async function listPdfAskSummaries(
	paperAbsPath: string,
): Promise<PdfAskThreadSummary[]> {
	return toSummaries(await listPdfAskThreads(paperAbsPath));
}

export function readPdfAskThread(
	paperAbsPath: string,
	threadId: string,
): Promise<PdfAskThread | null> {
	return store.read(paperAbsPath, threadId);
}

export function writePdfAskThread(
	paperAbsPath: string,
	thread: PdfAskThread,
): Promise<void> {
	return store.write(paperAbsPath, thread);
}

export function deletePdfAskThread(
	paperAbsPath: string,
	threadId: string,
): Promise<void> {
	return store.remove(paperAbsPath, threadId);
}

export function toSummaries(threads: PdfAskThread[]): PdfAskThreadSummary[] {
	return threads.map((t) => {
		const pin = threadPin(t);
		return {
			id: t.id,
			page: t.anchor.page,
			x: pin.x,
			y: pin.y,
			preview: threadPreview(t),
			updatedAt: t.updatedAt,
			status: t.status,
		};
	});
}
