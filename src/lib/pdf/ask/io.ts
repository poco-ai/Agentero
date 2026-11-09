import { nanoid } from "nanoid";
import { parsePdfAskThread } from "@/lib/pdf/ask/schema";
import type {
	PdfAskAnchor,
	PdfAskMessage,
	PdfAskNormalizedRect,
	PdfAskThread,
} from "@/lib/pdf/ask/types";
import { createMarkStore } from "@/lib/pdf/marks/io";

const store = createMarkStore<PdfAskThread>({
	parse: parsePdfAskThread,
	sort: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
	prepareWrite: (thread) => ({
		...thread,
		// Composer drafts are session-only; never write unsent text to marks/.
		draft: undefined,
		kind: "ask",
		updatedAt: new Date().toISOString(),
	}),
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

/**
 * Conversation card from a PDF selection that was sent into the Agent panel.
 * Stores as kind `ask` (not agent-trace / visual annotation): pin + AskPopover.
 */
export function createAskThreadFromAgentSelection(input: {
	paperPath: string;
	page: number;
	rects: PdfAskNormalizedRect[];
	quote: string;
	userContent: string;
	agentSessionId?: string;
	id?: string;
	createdAt?: string;
}): PdfAskThread {
	const now = input.createdAt ?? new Date().toISOString();
	const quote = input.quote.trim();
	const userContent = input.userContent.trim();
	const userMsg: PdfAskMessage = {
		id: newMessageId(),
		role: "user",
		content: userContent,
		createdAt: now,
	};
	if (input.agentSessionId?.trim()) {
		userMsg.agentSessionId = input.agentSessionId.trim();
	}
	return {
		version: 1,
		kind: "ask",
		id: input.id ?? newThreadId(),
		paperPath: input.paperPath,
		createdAt: now,
		updatedAt: now,
		status: "open",
		anchor: {
			page: Math.max(1, Math.floor(input.page)),
			rects: input.rects.map((r) => ({ ...r })),
			...(quote ? { quote } : {}),
			trigger: "selection",
		},
		messages: userContent ? [userMsg] : [],
	};
}

/** Append (or replace trailing empty) assistant turn after an Agent panel reply. */
export function appendAskAssistantMessage(
	thread: PdfAskThread,
	input: {
		content: string;
		agentSessionId?: string;
		sources?: { title?: string; uri?: string }[];
		updatedAt?: string;
	},
): PdfAskThread {
	const now = input.updatedAt ?? new Date().toISOString();
	const content = input.content;
	const messages = [...thread.messages];
	const last = messages[messages.length - 1];
	const msg: PdfAskMessage = {
		id: newMessageId(),
		role: "assistant",
		content,
		createdAt: now,
	};
	if (input.agentSessionId?.trim()) {
		msg.agentSessionId = input.agentSessionId.trim();
	}
	if (input.sources?.length) {
		msg.sources = input.sources.map((s) => ({ ...s }));
	}
	if (last?.role === "assistant" && !last.content.trim()) {
		messages[messages.length - 1] = { ...msg, id: last.id };
	} else if (content.trim() || last?.role !== "assistant") {
		messages.push(msg);
	}
	return {
		...thread,
		status: "open",
		messages,
		updatedAt: now,
	};
}

export const listPdfAskThreads = store.list;
export const readPdfAskThread = store.read;
export const writePdfAskThread = store.write;
export const deletePdfAskThread = store.remove;
