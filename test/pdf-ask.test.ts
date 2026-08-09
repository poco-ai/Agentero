import { describe, expect, it } from "vitest";

import {
	appendAskAssistantMessage,
	createAskThreadFromAgentSelection,
	createEmptyThread,
	parsePdfAskThread,
	rememberPendingAskThreads,
	resetPendingAskThreadsForTests,
	takePendingAskThreads,
	threadHasUserQuestion,
	threadPin,
	threadPreview,
	threadTitle,
} from "@/lib/pdf/ask";
import { buildPdfAskPrompt } from "@/lib/pdf/ask/prompt";

describe("pdf-ask schema", () => {
	it("parses a valid thread", () => {
		const raw = {
			version: 1,
			kind: "ask",
			id: "t1",
			paperPath: "papers/1706.03762",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			status: "open",
			anchor: {
				page: 2,
				rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.05 }],
				quote: "attention is all you need",
				trigger: "selection",
			},
			messages: [
				{
					id: "m1",
					role: "user",
					content: "What does this mean?",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
		};
		const t = parsePdfAskThread(raw);
		expect(t).not.toBeNull();
		if (!t) return;
		expect(t.id).toBe("t1");
		expect(t.anchor.page).toBe(2);
		expect(threadPreview(t)).toContain("What does this mean");
		expect(threadTitle(t, "New")).toContain("What does this mean");
		const pin = threadPin(t);
		expect(pin.y).toBeCloseTo(0.225, 3);
		expect(pin.x).toBeGreaterThan(0.3);
	});

	it("uses empty fallback title when no messages", () => {
		const t = createEmptyThread({
			paperPath: "papers/x",
			anchor: {
				page: 1,
				rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }],
				trigger: "selection",
			},
		});
		expect(threadTitle(t, "新提问")).toBe("新提问");
		expect(threadHasUserQuestion(t)).toBe(false);
	});

	it("detects user question after a user turn", () => {
		const t = createEmptyThread({
			paperPath: "papers/x",
			anchor: {
				page: 1,
				rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }],
				trigger: "selection",
			},
		});
		t.messages.push({
			id: "m1",
			role: "user",
			content: "hello",
			createdAt: new Date().toISOString(),
		});
		expect(threadHasUserQuestion(t)).toBe(true);
	});

	it("rejects bad version", () => {
		expect(parsePdfAskThread({ version: 2, id: "x" })).toBeNull();
	});

	it("builds an ask conversation card from Agent-panel selection turn", () => {
		const thread = createAskThreadFromAgentSelection({
			paperPath: "papers/transformer",
			page: 2,
			rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.05 }],
			quote: "attention is all you need",
			userContent: "What does this phrase mean?",
			agentSessionId: "sess-1",
		});
		expect(thread.kind).toBe("ask");
		expect(thread.anchor.trigger).toBe("selection");
		expect(thread.anchor.quote).toBe("attention is all you need");
		expect(thread.messages).toHaveLength(1);
		expect(thread.messages[0]?.role).toBe("user");
		expect(thread.messages[0]?.content).toBe("What does this phrase mean?");
		expect(thread.messages[0]?.agentSessionId).toBe("sess-1");
		expect(threadHasUserQuestion(thread)).toBe(true);

		const withAnswer = appendAskAssistantMessage(thread, {
			content: "It is the title of the Transformer paper.",
			agentSessionId: "sess-1",
			sources: [{ uri: "https://example.com" }],
		});
		expect(withAnswer.messages).toHaveLength(2);
		expect(withAnswer.messages[1]?.role).toBe("assistant");
		expect(withAnswer.messages[1]?.content).toContain("Transformer");
		expect(withAnswer.messages[1]?.sources?.[0]?.uri).toBe(
			"https://example.com",
		);
	});

	it("tracks pending ask finalizers by runtime session", () => {
		resetPendingAskThreadsForTests();
		rememberPendingAskThreads("rt-1", [
			{ paperAbsPath: "/vault/p", threadId: "t1" },
			{ paperAbsPath: "/vault/p", threadId: "t2" },
		]);
		expect(takePendingAskThreads("rt-1")).toEqual([
			{ paperAbsPath: "/vault/p", threadId: "t1" },
			{ paperAbsPath: "/vault/p", threadId: "t2" },
		]);
		expect(takePendingAskThreads("rt-1")).toEqual([]);
	});

	it("preserves visual region semantics", () => {
		const raw = {
			version: 1,
			kind: "ask",
			id: "visual-1",
			paperPath: "papers/visual",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			status: "open",
			anchor: {
				page: 4,
				rects: [{ x: 0.1, y: 0.2, w: 0.6, h: 0.4 }],
				trigger: "region",
				visualKind: "figure",
			},
			messages: [],
		};
		const thread = parsePdfAskThread(raw);
		expect(thread?.anchor.trigger).toBe("region");
		expect(thread?.anchor.visualKind).toBe("figure");
	});
});

describe("pdf-ask prompt", () => {
	it("includes page, quote, and question", () => {
		const thread = createEmptyThread({
			paperPath: "papers/x",
			anchor: {
				page: 3,
				rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }],
				quote: "Transformer",
				trigger: "selection",
			},
		});
		thread.messages.push({
			id: "u1",
			role: "user",
			content: "Explain",
			createdAt: new Date().toISOString(),
		});
		const p = buildPdfAskPrompt(thread, "Explain");
		expect(p).toContain("Page: 3");
		expect(p).toContain("Transformer");
		expect(p).toContain("Explain");
	});

	it("adds bounded visual instructions for a figure crop", () => {
		const thread = createEmptyThread({
			paperPath: "papers/x",
			anchor: {
				page: 5,
				rects: [{ x: 0.1, y: 0.2, w: 0.7, h: 0.5 }],
				trigger: "region",
				visualKind: "figure",
			},
		});
		thread.messages.push({
			id: "u1",
			role: "user",
			content: "Explain this figure",
			createdAt: new Date().toISOString(),
		});
		const prompt = buildPdfAskPrompt(thread, "Explain this figure");
		expect(prompt).toContain("figure, chart, table");
		expect(prompt).toContain("Do not invent unreadable values");
	});
});
