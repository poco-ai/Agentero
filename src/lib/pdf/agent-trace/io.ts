import { nanoid } from "nanoid";

import { isTauri } from "@/lib/core/tauri";
import {
	preparePdfVisualTraceImageWrite,
	visualTraceImageAssetPath,
} from "@/lib/pdf/agent-trace/image";
import { isVisualTraceSessionPending } from "@/lib/pdf/agent-trace/pending";
import { parsePdfVisualSessionTrace } from "@/lib/pdf/agent-trace/schema";
import type {
	PdfVisualAgent,
	PdfVisualNormalizedRect,
	PdfVisualSessionTrace,
	PdfVisualTraceImage,
	PdfVisualTraceMessage,
} from "@/lib/pdf/agent-trace/types";
import { VISUAL_MARK_KIND } from "@/lib/pdf/agent-trace/types";
import { createMarkStore } from "@/lib/pdf/marks/io";
import { markSelfWrite } from "@/lib/pdf/selection/marks-io";
import { removeVaultPath, writeVaultBytes } from "@/lib/vault";

const store = createMarkStore<PdfVisualSessionTrace>({
	parse: parsePdfVisualSessionTrace,
	sort: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
	prepareWrite: (trace) => ({
		...trace,
		version: 2,
		kind: VISUAL_MARK_KIND,
		updatedAt: new Date().toISOString(),
	}),
});

export function newTraceId(): string {
	return nanoid(10);
}

export function newTraceMessageId(): string {
	return nanoid(10);
}

export type CreateNoteTraceInput = {
	id?: string;
	paperPath: string;
	page: number;
	rects: PdfVisualNormalizedRect[];
	/** Required non-empty user note for note-only marks. */
	comment: string;
	image?: PdfVisualTraceImage;
	createdAt?: string;
};

/**
 * Note-only visual mark (no Agent). Comment may be empty when a crop image is
 * provided (same as a plain highlight without a note).
 */
export function createNoteTrace(
	input: CreateNoteTraceInput,
): PdfVisualSessionTrace {
	const comment = input.comment.trim();
	const now = input.createdAt ?? new Date().toISOString();
	const trace: PdfVisualSessionTrace = {
		version: 2,
		kind: VISUAL_MARK_KIND,
		id: input.id ?? newTraceId(),
		paperPath: input.paperPath,
		page: Math.max(1, Math.floor(input.page)),
		rects: input.rects,
		comment,
		createdAt: now,
		updatedAt: now,
	};
	if (input.image?.data) {
		trace.image = {
			data: input.image.data,
			mimeType: input.image.mimeType || "image/png",
		};
	} else if (input.image?.path) {
		trace.image = {
			path: input.image.path,
			mimeType: input.image.mimeType || "image/png",
		};
	}
	if (!comment && !trace.image) {
		throw new Error("createNoteTrace requires a comment or crop image");
	}
	return trace;
}

export type CreateRunningTraceItemInput = {
	id?: string;
	page: number;
	rects: PdfVisualNormalizedRect[];
	comment: string;
	image?: PdfVisualTraceImage;
	/** Seed transcript (e.g. first user turn for Cmd+Enter). */
	messages?: PdfVisualTraceMessage[];
};

export type CreateRunningTracesInput = {
	paperPath: string;
	items: CreateRunningTraceItemInput[];
	agentId: string;
	runtimeSessionId: string;
	messageId: string;
	createdAt?: string;
};

/** One mark file per crop; shared session fields when submitted together. */
export function createRunningTraces(
	input: CreateRunningTracesInput,
): PdfVisualSessionTrace[] {
	const now = input.createdAt ?? new Date().toISOString();
	if (!input.items.length) {
		throw new Error("createRunningTraces requires at least one item");
	}
	return input.items.map((item, offset) => {
		const comment = item.comment.trim();
		const agent: PdfVisualAgent = {
			agentId: input.agentId,
			runtimeSessionId: input.runtimeSessionId,
			messageId: input.messageId,
			status: "running",
			index: offset + 1,
		};
		if (item.messages?.length) {
			agent.messages = item.messages.map((m) => ({ ...m }));
		} else if (comment) {
			// Composer-path marks get a seed user turn so pin hover shows a list.
			agent.messages = [
				{
					id: newTraceMessageId(),
					role: "user",
					content: comment,
					createdAt: now,
				},
			];
		}
		const trace: PdfVisualSessionTrace = {
			version: 2,
			kind: VISUAL_MARK_KIND,
			id: item.id ?? newTraceId(),
			paperPath: input.paperPath,
			page: Math.max(1, Math.floor(item.page)),
			rects: item.rects,
			comment,
			agent,
			createdAt: now,
			updatedAt: now,
		};
		if (item.image?.data) {
			trace.image = {
				data: item.image.data,
				mimeType: item.image.mimeType || "image/png",
			};
		} else if (item.image?.path) {
			trace.image = {
				path: item.image.path,
				mimeType: item.image.mimeType || "image/png",
			};
		}
		return trace;
	});
}

/**
 * Attach or rebind an Agent thread on an existing note-only (or prior) mark
 * for a first turn or continue.
 */
export function attachAgentToTrace(
	trace: PdfVisualSessionTrace,
	input: {
		agentId: string;
		runtimeSessionId: string;
		messageId: string;
		userContent?: string;
		userMessageId?: string;
		/** Preserve batch index when re-attaching. */
		index?: number;
		updatedAt?: string;
	},
): PdfVisualSessionTrace {
	const now = input.updatedAt ?? new Date().toISOString();
	const prior = trace.agent;
	const messages = [...(prior?.messages ?? [])];
	const content = input.userContent?.trim() ?? "";
	if (content) {
		const last = messages[messages.length - 1];
		if (!(last?.role === "user" && last.content === content)) {
			messages.push({
				id: input.userMessageId ?? newTraceMessageId(),
				role: "user",
				content,
				createdAt: now,
			});
		}
	}
	const agent: PdfVisualAgent = {
		agentId: input.agentId,
		runtimeSessionId: input.runtimeSessionId,
		messageId: input.messageId,
		status: "running",
		messages: messages.length ? messages : undefined,
		index: input.index ?? prior?.index,
	};
	if (prior?.providerSessionId) {
		agent.providerSessionId = prior.providerSessionId;
	}
	if (typeof prior?.answerSnapshot === "string") {
		agent.answerSnapshot = prior.answerSnapshot;
	}
	if (prior?.sources?.length) {
		agent.sources = [...prior.sources];
	}
	return {
		...trace,
		agent,
		updatedAt: now,
	};
}

/**
 * Mark a pin as running for a follow-up turn: append the user message and
 * rebind runtimeSessionId so complete/fail finalizers and orphan reconcile
 * track the new Agent run (not the first-turn session id).
 */
export function beginTraceContinue(
	trace: PdfVisualSessionTrace,
	input: {
		runtimeSessionId: string;
		messageId?: string;
		userContent: string;
		userMessageId?: string;
		/** When continuing a note-only mark, agentId is required. */
		agentId?: string;
		updatedAt?: string;
	},
): PdfVisualSessionTrace {
	const now = input.updatedAt ?? new Date().toISOString();
	const prior = trace.agent;
	const agentId = input.agentId?.trim() || prior?.agentId;
	if (!agentId) {
		throw new Error(
			"beginTraceContinue requires an agentId on note-only marks",
		);
	}
	return attachAgentToTrace(trace, {
		agentId,
		runtimeSessionId: input.runtimeSessionId,
		messageId: input.messageId?.trim() || prior?.messageId || "pending",
		userContent: input.userContent,
		userMessageId: input.userMessageId,
		index: prior?.index,
		updatedAt: now,
	});
}

export type CompleteTraceInput = {
	providerSessionId?: string;
	answerSnapshot?: string;
	sources?: string[];
	updatedAt?: string;
	/** When set, replace or append the assistant message in the local transcript. */
	assistantMessageId?: string;
};

export function completeTrace(
	trace: PdfVisualSessionTrace,
	input: CompleteTraceInput = {},
): PdfVisualSessionTrace {
	const now = input.updatedAt ?? new Date().toISOString();
	const prior = trace.agent;
	if (!prior) {
		// Completing a note-only mark is a no-op on agent fields.
		return { ...trace, updatedAt: now };
	}
	const runtimeSessionId = prior.runtimeSessionId;
	const agent: PdfVisualAgent = {
		...prior,
		status: "completed",
	};
	if (input.providerSessionId?.trim()) {
		agent.providerSessionId = input.providerSessionId.trim();
	}
	if (typeof input.answerSnapshot === "string") {
		agent.answerSnapshot = input.answerSnapshot;
	}
	if (input.sources) {
		agent.sources = [...input.sources];
	}
	if (typeof input.answerSnapshot === "string") {
		const content = input.answerSnapshot;
		const messages = [...(prior.messages ?? [])];
		const assistantId = input.assistantMessageId;
		const last = messages[messages.length - 1];
		if (assistantId && last?.id === assistantId && last.role === "assistant") {
			messages[messages.length - 1] = {
				...last,
				content,
				createdAt: now,
				agentSessionId: last.agentSessionId ?? runtimeSessionId,
			};
			agent.messages = messages;
		} else if (last?.role === "assistant" && !last.content.trim()) {
			messages[messages.length - 1] = {
				...last,
				content,
				createdAt: now,
				agentSessionId: last.agentSessionId ?? runtimeSessionId,
			};
			agent.messages = messages;
		} else if (content.trim()) {
			messages.push({
				id: assistantId ?? newTraceMessageId(),
				role: "assistant",
				content,
				createdAt: now,
				agentSessionId: runtimeSessionId,
			});
			agent.messages = messages;
		}
	}
	delete agent.error;
	return {
		...trace,
		agent,
		updatedAt: now,
	};
}

export type FailTraceInput = {
	error: string;
	/** Preserve a resumable provider session when a running turn is cancelled. */
	providerSessionId?: string;
	answerSnapshot?: string;
	updatedAt?: string;
	assistantMessageId?: string;
};

export function failTrace(
	trace: PdfVisualSessionTrace,
	input: FailTraceInput,
): PdfVisualSessionTrace {
	const now = input.updatedAt ?? new Date().toISOString();
	const prior = trace.agent;
	if (!prior) {
		return { ...trace, updatedAt: now };
	}
	const agent: PdfVisualAgent = {
		...prior,
		status: "failed",
		error: input.error.trim() || "Agent failed",
	};
	if (input.providerSessionId?.trim()) {
		agent.providerSessionId = input.providerSessionId.trim();
	}
	if (typeof input.answerSnapshot === "string") {
		agent.answerSnapshot = input.answerSnapshot;
	}
	// Drop only an empty (or still-streaming) assistant bubble on failure.
	// Never drop user turns — multi-turn history must survive a failed continue.
	if (prior.messages?.length) {
		const messages = [...prior.messages];
		const last = messages[messages.length - 1];
		const dropId = input.assistantMessageId;
		const isTargetAssistant =
			last?.role === "assistant" &&
			(!dropId || last.id === dropId) &&
			!last.content.trim();
		if (isTargetAssistant) {
			messages.pop();
			agent.messages = messages;
		} else {
			agent.messages = messages;
		}
	}
	return {
		...trace,
		agent,
		updatedAt: now,
	};
}

/**
 * Persist a failed outcome for running marks that no longer have an in-flight
 * Agent finalizer (app restart, dropped stream, panel unmount mid-run, …).
 * Skips sessions still in the pending map or within the post-take grace window
 * so list/refresh cannot race a normal complete/fail write.
 */
export async function reconcileOrphanRunningVisualTraces(
	paperAbsPath: string,
	traces: PdfVisualSessionTrace[],
	errorMessage = "Agent session interrupted",
): Promise<PdfVisualSessionTrace[]> {
	if (!paperAbsPath || !traces.length) return traces;
	const out: PdfVisualSessionTrace[] = [];
	for (const trace of traces) {
		if (trace.agent?.status !== "running") {
			out.push(trace);
			continue;
		}
		if (isVisualTraceSessionPending(trace.agent.runtimeSessionId)) {
			out.push(trace);
			continue;
		}
		// Provisional in-memory pins use "pending" before a real session id exists;
		// they are not disk-backed long-term, but if one lands on disk, fail it too.
		const failed = failTrace(trace, { error: errorMessage });
		try {
			await writePdfVisualTrace(paperAbsPath, failed);
		} catch {
			// Best-effort: still surface the reconciled status in memory.
		}
		out.push(failed);
	}
	return out;
}

/** List marks and fold orphaned `running` pins into `failed` when safe. */
export async function listPdfVisualTraces(
	paperAbsPath: string,
): Promise<PdfVisualSessionTrace[]> {
	const traces = await store.list(paperAbsPath);
	return reconcileOrphanRunningVisualTraces(paperAbsPath, traces);
}

export const readPdfVisualTrace = store.read;

export async function writePdfVisualTrace(
	paperAbsPath: string,
	trace: PdfVisualSessionTrace,
): Promise<void> {
	if (!isTauri()) {
		// Memory path keeps runtime object (may include image.data for previews).
		await store.write(paperAbsPath, {
			...trace,
			version: 2,
			kind: VISUAL_MARK_KIND,
		});
		return;
	}
	const prepared = preparePdfVisualTraceImageWrite(trace);
	if (prepared.asset) {
		const assetPath = visualTraceImageAssetPath(
			paperAbsPath,
			prepared.asset.path,
		);
		if (!assetPath) throw new Error("invalid visual trace asset path");
		markSelfWrite(assetPath);
		await writeVaultBytes(assetPath, prepared.asset.bytes);
	}
	await store.write(paperAbsPath, {
		...prepared.trace,
		version: 2,
		kind: VISUAL_MARK_KIND,
	});
}

export async function deletePdfVisualTrace(
	paperAbsPath: string,
	id: string,
): Promise<void> {
	if (!isTauri()) {
		await store.remove(paperAbsPath, id);
		return;
	}
	const trace = await store.read(paperAbsPath, id);
	await store.remove(paperAbsPath, id);
	const assetPath =
		trace?.image?.path &&
		visualTraceImageAssetPath(paperAbsPath, trace.image.path);
	if (!assetPath) return;
	markSelfWrite(assetPath);
	try {
		await removeVaultPath(assetPath);
	} catch {
		// Mark deletion remains successful when an owned asset is already missing.
	}
}
