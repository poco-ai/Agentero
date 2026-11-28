import { normalizeVisualTraceImagePath } from "@/lib/pdf/agent-trace/image";
import type {
	PdfVisualAgent,
	PdfVisualSessionTrace,
	PdfVisualTraceElement,
	PdfVisualTraceImage,
	PdfVisualTraceMessage,
	PdfVisualTraceStatus,
} from "@/lib/pdf/agent-trace/types";
import {
	isVisualMarkKind,
	LEGACY_VISUAL_MARK_KIND,
	VISUAL_MARK_KIND,
	visualMarkHasContent,
} from "@/lib/pdf/agent-trace/types";
import { isRecord, isRect, shorten } from "@/lib/pdf/marks/schema";
import { pinFromRects } from "@/lib/pdf/selection/pin";
import type { PdfVisualNormalizedRect } from "@/lib/pdf-visual/types";

function isStatus(v: unknown): v is PdfVisualTraceStatus {
	return v === "running" || v === "completed" || v === "failed";
}

function parseImage(v: unknown): PdfVisualTraceImage | undefined {
	if (!isRecord(v)) return undefined;
	const path = normalizeVisualTraceImagePath(v.path);
	if (!path) return undefined;
	const mimeType =
		typeof v.mimeType === "string" && v.mimeType.trim()
			? v.mimeType.trim()
			: "image/png";
	return { path, mimeType };
}

function parseMessages(v: unknown): PdfVisualTraceMessage[] | undefined {
	if (!Array.isArray(v) || v.length === 0) return undefined;
	const out: PdfVisualTraceMessage[] = [];
	for (const item of v) {
		if (!isRecord(item)) continue;
		if (typeof item.id !== "string" || !item.id) continue;
		if (item.role !== "user" && item.role !== "assistant") continue;
		if (typeof item.content !== "string") continue;
		if (typeof item.createdAt !== "string" || !item.createdAt) continue;
		const msg: PdfVisualTraceMessage = {
			id: item.id,
			role: item.role,
			content: item.content,
			createdAt: item.createdAt,
		};
		if (typeof item.agentSessionId === "string" && item.agentSessionId) {
			msg.agentSessionId = item.agentSessionId;
		}
		out.push(msg);
	}
	return out.length ? out : undefined;
}

function parseElements(v: unknown): PdfVisualTraceElement[] | undefined {
	if (!Array.isArray(v) || v.length === 0) return undefined;
	const out: PdfVisualTraceElement[] = [];
	for (const item of v) {
		if (!isRecord(item) || typeof item.kind !== "string" || !item.kind) {
			continue;
		}
		const element: PdfVisualTraceElement = { kind: item.kind };
		if (typeof item.quote === "string" && item.quote.trim()) {
			element.quote = item.quote.trim();
		}
		out.push(element);
	}
	return out.length ? out : undefined;
}

function parseAgentBlock(raw: Record<string, unknown>): PdfVisualAgent | null {
	if (typeof raw.agentId !== "string" || !raw.agentId) return null;
	if (typeof raw.runtimeSessionId !== "string" || !raw.runtimeSessionId) {
		return null;
	}
	if (typeof raw.messageId !== "string" || !raw.messageId) return null;
	if (!isStatus(raw.status)) return null;

	const agent: PdfVisualAgent = {
		agentId: raw.agentId,
		runtimeSessionId: raw.runtimeSessionId,
		messageId: raw.messageId,
		status: raw.status,
	};
	if (typeof raw.providerSessionId === "string" && raw.providerSessionId) {
		agent.providerSessionId = raw.providerSessionId;
	}
	if (typeof raw.answerSnapshot === "string") {
		agent.answerSnapshot = raw.answerSnapshot;
	}
	const messages = parseMessages(raw.messages);
	if (messages) agent.messages = messages;
	if (Array.isArray(raw.sources)) {
		agent.sources = raw.sources.filter(
			(s): s is string => typeof s === "string",
		);
	}
	if (typeof raw.error === "string") {
		agent.error = raw.error;
	}
	if (typeof raw.index === "number" && Number.isFinite(raw.index)) {
		agent.index = Math.max(1, Math.floor(raw.index));
	}
	return agent;
}

/**
 * Validate and normalize a visual mark JSON payload.
 * Accepts v2 (`kind: "visual"`, nested `agent`) and legacy v1
 * (`kind: "agent-trace"`, flat agent fields). Always returns in-memory v2.
 */
export function parsePdfVisualSessionTrace(
	raw: unknown,
): PdfVisualSessionTrace | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.kind !== "string" || !isVisualMarkKind(raw.kind)) return null;
	if (typeof raw.id !== "string" || !raw.id) return null;
	if (typeof raw.paperPath !== "string") return null;
	if (typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string") {
		return null;
	}
	if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return null;
	if (
		!Array.isArray(raw.rects) ||
		raw.rects.length === 0 ||
		!raw.rects.every(isRect)
	) {
		return null;
	}
	if (typeof raw.comment !== "string") return null;

	// Agent: nested v2 first, then flat v1 top-level fields.
	// Incomplete agent blocks are dropped (keep note-only when comment exists).
	let agent: PdfVisualAgent | undefined;
	if (isRecord(raw.agent)) {
		agent = parseAgentBlock(raw.agent) ?? undefined;
	} else if (
		raw.kind === LEGACY_VISUAL_MARK_KIND ||
		typeof raw.agentId === "string"
	) {
		const flat = parseAgentBlock(raw);
		if (flat) {
			// Promote top-level index into agent for v1.
			if (
				flat.index === undefined &&
				typeof raw.index === "number" &&
				Number.isFinite(raw.index)
			) {
				flat.index = Math.max(1, Math.floor(raw.index));
			}
			agent = flat;
		} else if (
			raw.kind === LEGACY_VISUAL_MARK_KIND &&
			!raw.comment?.toString().trim()
		) {
			// Legacy agent-trace without agent or comment cannot be salvaged.
			return null;
		}
	}

	const mark: PdfVisualSessionTrace = {
		version: 2,
		kind: VISUAL_MARK_KIND,
		id: raw.id,
		paperPath: raw.paperPath,
		page: Math.max(1, Math.floor(raw.page)),
		rects: raw.rects as PdfVisualNormalizedRect[],
		comment: raw.comment,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
	};
	const image = parseImage(raw.image);
	if (image) mark.image = image;
	if (typeof raw.quote === "string" && raw.quote.trim()) {
		mark.quote = raw.quote.trim();
	}
	const elements = parseElements(raw.elements);
	if (elements) mark.elements = elements;
	if (agent) mark.agent = agent;

	// At least comment or agent must be present.
	if (!visualMarkHasContent(mark)) return null;

	return mark;
}

/**
 * Disk-safe payload: always version 2 / kind visual, nested agent, no inline image data.
 */
export function serializePdfVisualSessionTrace(
	trace: PdfVisualSessionTrace,
): Record<string, unknown> {
	const out: Record<string, unknown> = {
		version: 2,
		kind: VISUAL_MARK_KIND,
		id: trace.id,
		paperPath: trace.paperPath,
		page: trace.page,
		rects: trace.rects,
		comment: trace.comment,
		createdAt: trace.createdAt,
		updatedAt: trace.updatedAt,
	};
	if (trace.image?.path) {
		out.image = {
			path: trace.image.path,
			mimeType: trace.image.mimeType || "image/png",
		};
	}
	if (trace.quote?.trim()) out.quote = trace.quote.trim();
	if (trace.elements?.length) {
		out.elements = trace.elements.map((element) => ({
			kind: element.kind,
			...(element.quote?.trim() ? { quote: element.quote.trim() } : {}),
		}));
	}
	if (trace.agent) {
		const a = trace.agent;
		const agent: Record<string, unknown> = {
			agentId: a.agentId,
			runtimeSessionId: a.runtimeSessionId,
			messageId: a.messageId,
			status: a.status,
		};
		if (a.providerSessionId) agent.providerSessionId = a.providerSessionId;
		if (typeof a.answerSnapshot === "string") {
			agent.answerSnapshot = a.answerSnapshot;
		}
		if (a.messages?.length) agent.messages = a.messages;
		if (a.sources?.length) agent.sources = a.sources;
		if (a.error) agent.error = a.error;
		if (typeof a.index === "number") agent.index = a.index;
		out.agent = agent;
	}
	return out;
}

/**
 * True when on-disk JSON is legacy v1 agent-trace (or flat agent fields)
 * and should be rewritten to nested visual v2 by Doctor / migrate.
 */
export function isLegacyVisualMarkRaw(raw: unknown): boolean {
	if (!isRecord(raw)) return false;
	if (raw.kind === LEGACY_VISUAL_MARK_KIND) return true;
	if (raw.kind !== VISUAL_MARK_KIND) return false;
	// kind visual but flat agent fields / wrong version without nested agent
	if (raw.version === 2 && isRecord(raw.agent)) return false;
	if (typeof raw.agentId === "string" && raw.agentId) return true;
	if (raw.version === 1) return true;
	return false;
}

/**
 * Messages for hover chat UI. Prefer stored transcript; otherwise synthesize
 * from comment + answerSnapshot so legacy marks still show a message list.
 */
export function traceMessages(
	trace: PdfVisualSessionTrace,
): PdfVisualTraceMessage[] {
	const agent = trace.agent;
	if (agent?.messages?.length) return agent.messages;
	const synthesized: PdfVisualTraceMessage[] = [];
	const comment = trace.comment.trim();
	if (comment) {
		synthesized.push({
			id: `${trace.id}-user`,
			role: "user",
			content: comment,
			createdAt: trace.createdAt,
		});
	}
	const answer = agent?.answerSnapshot?.trim();
	if (answer) {
		synthesized.push({
			id: `${trace.id}-assistant`,
			role: "assistant",
			content: answer,
			createdAt: trace.updatedAt,
			agentSessionId: agent?.runtimeSessionId,
		});
	} else if (agent?.status === "failed" && agent.error?.trim()) {
		synthesized.push({
			id: `${trace.id}-error`,
			role: "assistant",
			content: agent.error.trim(),
			createdAt: trace.updatedAt,
		});
	}
	return synthesized;
}

/**
 * Conversation turns for wiki embed projection.
 *
 * Unlike {@link traceMessages}, never promotes `comment` into a "user" turn —
 * the embed shows the note as icon+text above the crop. Empty when there is no
 * real agent dialogue (note-only marks).
 */
export function traceMessagesForEmbed(
	trace: PdfVisualSessionTrace,
): PdfVisualTraceMessage[] {
	const agent = trace.agent;
	const note = trace.comment.trim();
	let messages: PdfVisualTraceMessage[] = [];
	if (agent?.messages?.length) {
		messages = agent.messages;
	} else {
		const answer = agent?.answerSnapshot?.trim();
		if (answer) {
			messages = [
				{
					id: `${trace.id}-assistant`,
					role: "assistant",
					content: answer,
					createdAt: trace.updatedAt,
					agentSessionId: agent?.runtimeSessionId,
				},
			];
		} else if (agent?.status === "failed" && agent.error?.trim()) {
			messages = [
				{
					id: `${trace.id}-error`,
					role: "assistant",
					content: agent.error.trim(),
					createdAt: trace.updatedAt,
				},
			];
		}
	}
	// Legacy Cmd+Enter stored the prompt in both comment and messages — drop
	// the user turn that only repeats the note so the embed does not double it.
	if (note) {
		messages = messages.filter(
			(m) => !(m.role === "user" && m.content.trim() === note),
		);
	}
	return messages;
}

/** Tooltip / list preview for one mark. */
export function tracePreview(
	trace: PdfVisualSessionTrace,
	fallback = "Visual annotation",
	max = 80,
): string {
	const comment = trace.comment.trim();
	if (comment) return shorten(comment, max) || fallback;
	const firstUser = trace.agent?.messages?.find((m) => m.role === "user");
	if (firstUser?.content.trim()) {
		return shorten(firstUser.content, max) || fallback;
	}
	const index = trace.agent?.index;
	return index ? `${fallback} ${index}` : fallback;
}

/** Pin geometry for a mark (prefer right side of the crop). */
export function tracePin(trace: PdfVisualSessionTrace) {
	return pinFromRects(trace.rects);
}
