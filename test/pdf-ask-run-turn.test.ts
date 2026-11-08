import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyThread } from "@/lib/pdf/ask";
import {
	type AskTurnPatch,
	resendBaseMessages,
	runAskTurn,
	stopAskRun,
} from "@/lib/pdf/ask/run-turn";
import type { PdfAskThread } from "@/lib/pdf/ask/types";

const runOnce = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const attachAgentRun = vi.fn<(...args: unknown[]) => Promise<void>>();
const cancelAgentRun = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock("@/lib/agent", () => ({
	runOnce: (...args: unknown[]) => runOnce(...args),
	attachAgentRun: (...args: unknown[]) => attachAgentRun(...args),
	cancelAgentRun: (...args: unknown[]) => cancelAgentRun(...args),
}));

vi.mock("@/lib/core/notify", () => ({
	notifyError: () => undefined,
}));

vi.mock("@/lib/settings", () => ({
	loadSettings: () => ({ pdfAsk: { agentId: "", modelId: "" } }),
}));

vi.mock("@/lib/translate", () => ({
	resolveTranslateAgent: () => ({ agentId: undefined, modelId: undefined }),
}));

type AttachOptions = {
	onArmed?: (sessionId: string) => void;
	onStream: (ev: { chunk: string }) => void;
	onCompleted: (ev: { content: string; sources?: string[] }) => void;
	onFailed: (ev: { error: string }) => void;
	onSettled?: () => void;
};

/** In-memory container double: one live thread per id, like the hook adapters. */
function container() {
	const threads = new Map<string, PdfAskThread>();
	const persisted: PdfAskThread[] = [];
	const upsertThread = (thread: PdfAskThread) => {
		threads.set(thread.id, thread);
	};
	const patchThread: AskTurnPatch = (threadId, transform, onApplied) => {
		const prev = threads.get(threadId);
		if (!prev) return;
		const done = transform(prev);
		if (done === prev) return;
		onApplied?.(done);
		threads.set(threadId, done);
	};
	return {
		threads,
		persisted,
		upsertThread,
		patchThread,
		persist: (thread: PdfAskThread) => {
			persisted.push(thread);
		},
	};
}

function fixture(): PdfAskThread {
	return createEmptyThread({
		paperPath: "papers/x",
		anchor: {
			page: 1,
			rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }],
			trigger: "selection",
		},
	});
}

function runOptions(c: ReturnType<typeof container>) {
	const errors: (string | null)[] = [];
	const streaming: boolean[] = [];
	return {
		errors,
		streaming,
		options: {
			buildPrompt: (thread: PdfAskThread, question: string) =>
				`P:${thread.id}:${question}`,
			upsertThread: c.upsertThread,
			patchThread: c.patchThread,
			persist: c.persist,
			setAskError: (message: string | null) => errors.push(message),
			setStreaming: (value: boolean) => streaming.push(value),
			failureText: () => "agent failed",
			disposedRef: { current: false },
			unsubsRef: { current: null },
			sessionRef: { current: null },
			activeSessionRef: { current: null },
		},
	};
}

describe("runAskTurn", () => {
	beforeEach(() => {
		runOnce.mockReset();
		attachAgentRun.mockReset();
		cancelAgentRun.mockReset();
	});

	it("runs an optimistic turn through stream and completion", async () => {
		const c = container();
		const { errors, streaming, options } = runOptions(c);
		const thread = fixture();
		runOnce.mockResolvedValue({
			sessionId: "sess-1",
			messageId: "m1",
			agentId: "agent-1",
		});
		attachAgentRun.mockImplementation(async (raw: AttachOptions) => {
			raw.onArmed?.("sess-1");
			raw.onStream({ chunk: "Hel" });
			raw.onStream({ chunk: "lo" });
			raw.onCompleted({ content: "Hello!", sources: ["https://a"] });
			raw.onSettled?.();
		});

		await runAskTurn({
			thread,
			question: " hi ",
			agent: { agentId: "agent-1", modelId: "model-1" },
			vaultPath: "/vault",
			...options,
		});

		expect(runOnce).toHaveBeenCalledTimes(1);
		expect(runOnce.mock.calls[0]?.[0]).toMatchObject({
			prompt: `P:${thread.id}: hi `,
			agentId: "agent-1",
			modelId: "model-1",
			vaultPath: "/vault",
			workflow: "free",
			permissionMode: "auto",
			hideFromChatHistory: true,
		});

		const live = c.threads.get(thread.id);
		expect(live?.status).toBe("open");
		expect(live?.messages).toHaveLength(2);
		expect(live?.messages[0]).toMatchObject({
			role: "user",
			content: " hi ",
		});
		expect(live?.messages[1]).toMatchObject({
			role: "assistant",
			content: "Hello!",
			agentSessionId: "sess-1",
			sources: [{ uri: "https://a" }],
		});

		expect(c.persisted).toHaveLength(3);
		expect(c.persisted[0]?.messages).toHaveLength(1);
		expect(c.persisted[1]?.messages[1]).toMatchObject({
			role: "assistant",
			content: "",
			agentSessionId: "sess-1",
		});
		expect(c.persisted[2]?.messages[1]?.content).toBe("Hello!");
		expect(errors).toEqual([null]);
		expect(streaming).toEqual([true, false]);
	});

	it("keeps receiving a reply after a marks refresh reloads the saved thread", async () => {
		const c = container();
		const { options } = runOptions(c);
		const thread = fixture();
		runOnce.mockResolvedValue({
			sessionId: "sess-refresh",
			messageId: "m-refresh",
			agentId: "agent-1",
		});
		attachAgentRun.mockImplementation(async (raw: AttachOptions) => {
			raw.onArmed?.("sess-refresh");
			// subscribeLocalMarkWrites refreshes marks/ after a write. Replace
			// the live state with that disk snapshot before model output.
			const saved = c.persisted.at(-1);
			expect(saved).toBeDefined();
			c.upsertThread(structuredClone(saved as PdfAskThread));
			raw.onStream({ chunk: "Visible" });
			expect(c.threads.get(thread.id)?.messages.at(-1)?.content).toBe(
				"Visible",
			);
			raw.onCompleted({ content: "Visible answer", sources: [] });
			raw.onSettled?.();
		});

		await runAskTurn({ thread, question: "Explain the selection", ...options });

		expect(c.threads.get(thread.id)?.messages).toHaveLength(2);
		expect(c.persisted.at(-1)?.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: "Visible answer",
			agentSessionId: "sess-refresh",
		});
	});

	it("removes the assistant placeholder on failure and persists the filtered thread", async () => {
		const c = container();
		const { errors, streaming, options } = runOptions(c);
		const thread = fixture();
		runOnce.mockResolvedValue({
			sessionId: "sess-2",
			messageId: "m1",
			agentId: "agent-1",
		});
		attachAgentRun.mockImplementation(async (raw: AttachOptions) => {
			raw.onArmed?.("sess-2");
			raw.onStream({ chunk: "partial" });
			raw.onFailed({ error: "boom" });
			raw.onSettled?.();
		});

		await runAskTurn({ thread, question: "why", ...options });

		const live = c.threads.get(thread.id);
		expect(live?.messages).toHaveLength(1);
		expect(live?.messages[0]?.role).toBe("user");
		expect(errors).toEqual([null, "boom"]);
		expect(streaming).toEqual([true, false]);
		expect(c.persisted.at(-1)?.messages).toHaveLength(1);
	});

	it("resends from the truncated base instead of the full history", async () => {
		const c = container();
		const { errors, streaming, options } = runOptions(c);
		const thread = fixture();
		thread.messages.push(
			{
				id: "u1",
				role: "user",
				content: "first",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "a1",
				role: "assistant",
				content: "answer",
				createdAt: "2026-01-01T00:00:01.000Z",
			},
			{
				id: "u2",
				role: "user",
				content: "second",
				createdAt: "2026-01-01T00:00:02.000Z",
			},
			{
				id: "a2",
				role: "assistant",
				content: "answer2",
				createdAt: "2026-01-01T00:00:03.000Z",
			},
		);
		runOnce.mockResolvedValue({
			sessionId: "sess-3",
			messageId: "m1",
			agentId: "agent-1",
		});
		attachAgentRun.mockImplementation(async (raw: AttachOptions) => {
			raw.onArmed?.("sess-3");
			raw.onSettled?.();
		});

		await runAskTurn({
			thread,
			question: "edited",
			baseMessages: resendBaseMessages(thread.messages, "u2"),
			...options,
		});

		const live = c.threads.get(thread.id);
		expect(live?.messages).toHaveLength(4);
		expect(live?.messages.slice(0, 2).map((m) => m.id)).toEqual(["u1", "a1"]);
		expect(live?.messages[2]).toMatchObject({
			role: "user",
			content: "edited",
		});
		expect(live?.messages[3]?.role).toBe("assistant");
		expect(errors).toEqual([null]);
		expect(streaming).toEqual([true, false]);
	});

	it("surfaces runOnce rejection through the ask error chrome", async () => {
		const c = container();
		const { errors, streaming, options } = runOptions(c);
		const thread = fixture();
		runOnce.mockRejectedValue(new Error("nope"));

		await runAskTurn({ thread, question: "q", ...options });

		expect(attachAgentRun).not.toHaveBeenCalled();
		expect(errors).toEqual([null, "nope"]);
		expect(streaming).toEqual([true, false]);
		expect(c.persisted).toHaveLength(1);
	});
});

describe("resendBaseMessages", () => {
	const messages = [
		{ id: "u1", role: "user" as const, content: "a", createdAt: "t" },
		{ id: "a1", role: "assistant" as const, content: "b", createdAt: "t" },
		{ id: "u2", role: "user" as const, content: "c", createdAt: "t" },
	];

	it("slices up to the edited user turn", () => {
		expect(resendBaseMessages(messages, "u2")).toEqual([
			messages[0],
			messages[1],
		]);
		expect(resendBaseMessages(messages, "u1")).toEqual([]);
	});

	it("rejects unknown or non-user ids", () => {
		expect(resendBaseMessages(messages, "missing")).toBeNull();
		expect(resendBaseMessages(messages, "a1")).toBeNull();
	});
});

describe("stopAskRun", () => {
	beforeEach(() => {
		cancelAgentRun.mockReset();
	});

	it("cancels the in-flight session, clears both slots, and stops the chrome", () => {
		const sessionRef = { current: "s1" };
		const activeSessionRef = { current: "s1" };
		const onStopped = vi.fn();
		cancelAgentRun.mockResolvedValue(undefined);

		stopAskRun(sessionRef, activeSessionRef, onStopped);

		expect(cancelAgentRun).toHaveBeenCalledWith("s1");
		expect(sessionRef.current).toBeNull();
		expect(activeSessionRef.current).toBeNull();
		expect(onStopped).toHaveBeenCalledTimes(1);
	});

	it("is a no-op while idle", () => {
		const onStopped = vi.fn();
		stopAskRun({ current: null }, { current: null }, onStopped);
		expect(cancelAgentRun).not.toHaveBeenCalled();
		expect(onStopped).not.toHaveBeenCalled();
	});
});
