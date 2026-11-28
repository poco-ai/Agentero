/**
 * PDF visual-region mark (area crop + optional user note + optional Agent thread).
 *
 * Disk shape (v2):
 *   papers/<id>/marks/<id>.json  kind: "visual"
 *   papers/<id>/marks/assets/<id>.png
 *
 * Legacy v1 used kind "agent-trace" with flat agent fields; parse normalizes to v2.
 */

import type { PdfVisualNormalizedRect } from "@/lib/pdf-visual/types";

export type PdfVisualTraceStatus = "running" | "completed" | "failed";

/**
 * Crop snapshot. `data` exists only before the first write or after an explicit
 * asset load; persisted marks contain `path` relative to `marks/`.
 */
export type PdfVisualTraceImage = {
	data?: string;
	path?: string;
	mimeType: string;
};

export type PdfVisualTraceMessageRole = "user" | "assistant";

/** Local multi-turn transcript for pin hover / in-place continue. */
export type PdfVisualTraceMessage = {
	id: string;
	role: PdfVisualTraceMessageRole;
	content: string;
	createdAt: string;
	agentSessionId?: string;
};

/** One selected member in a grouped visual annotation. */
export type PdfVisualTraceElement = {
	kind: string;
	quote?: string;
};

/**
 * Optional Agent conversation bound to a visual mark.
 * Absent when the user saved a note-only annotation (#196).
 */
export type PdfVisualAgent = {
	agentId: string;
	/** Agentero runtime/event session id from runOnce. */
	runtimeSessionId: string;
	messageId: string;
	/** ACP provider session id when available after completion. */
	providerSessionId?: string;
	status: PdfVisualTraceStatus;
	/** Local multi-turn chat for pin hover / Cmd+Enter modal. */
	messages?: PdfVisualTraceMessage[];
	/** Local answer text when provider history is unavailable. */
	answerSnapshot?: string;
	sources?: string[];
	error?: string;
	/** 1-based order within a multi-crop Agent batch. */
	index?: number;
};

export const VISUAL_MARK_KIND = "visual" as const;
export const LEGACY_VISUAL_MARK_KIND = "agent-trace" as const;

export type PdfVisualMarkKind =
	| typeof VISUAL_MARK_KIND
	| typeof LEGACY_VISUAL_MARK_KIND;

/** True for current and legacy visual mark discriminators. */
export function isVisualMarkKind(
	kind: string | null | undefined,
): kind is PdfVisualMarkKind {
	return kind === VISUAL_MARK_KIND || kind === LEGACY_VISUAL_MARK_KIND;
}

/**
 * One visual pin on a paper (crop + optional comment + optional Agent thread).
 * In-memory always uses kind "visual" + version 2 after parse.
 */
export type PdfVisualSessionTrace = {
	version: 2;
	kind: typeof VISUAL_MARK_KIND;
	id: string;
	/** Vault-relative paper folder when known; else absolute hint. */
	paperPath: string;
	/** 1-based PDF page number. */
	page: number;
	rects: PdfVisualNormalizedRect[];
	/** User note; may be empty when an agent thread is attached. */
	comment: string;
	/** Text members merged into a grouped visual annotation. */
	quote?: string;
	/** Selected members for grouped annotations; absent on simple crops. */
	elements?: PdfVisualTraceElement[];
	/** Crop image for pin hover preview. */
	image?: PdfVisualTraceImage;
	/** Present only when the user has started (or finished) an Agent turn. */
	agent?: PdfVisualAgent;
	createdAt: string;
	updatedAt: string;
};

/**
 * Note-only marks have no agent; agent marks may omit comment.
 * A crop image alone is enough to keep a visual pin (like a highlight without note).
 */
export function visualMarkHasContent(mark: {
	comment: string;
	agent?: PdfVisualAgent | null;
	image?: PdfVisualTraceImage | null;
}): boolean {
	return Boolean(
		mark.comment.trim() || mark.agent || mark.image?.path || mark.image?.data,
	);
}
