import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	getAgentTranslateSessionId,
	setAgentTranslateSessionId,
} from "@/lib/pdf/translate/agent-session-cache";
import { runSelectionTranslate } from "@/lib/pdf/translate/run-selection";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";

const runOnce = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const attachAgentRun = vi.fn<(...args: unknown[]) => Promise<void>>();
const resolveAgent = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const runTranslate = vi.fn<(...args: unknown[]) => Promise<string>>();
const notifyError = vi.fn<(message: string) => void>();

let providerId = "agent";

vi.mock("@/lib/agent", () => ({
	runOnce: (...args: unknown[]) => runOnce(...args),
	attachAgentRun: (...args: unknown[]) => attachAgentRun(...args),
}));

vi.mock("@/lib/core/notify", () => ({
	notifyError: (message: string) => notifyError(message),
}));

vi.mock("@/lib/translate", () => ({
	buildTranslatePrompt: (opts: { text: string; customPrompt?: string }) =>
		`PROMPT:${opts.customPrompt ?? ""}:${opts.text}`,
	displayTranslateError: (message: string) => `displayed:${message}`,
	prepareTranslateTask: () => ({
		providerId,
		targetLangName: "Chinese",
		customPrompt: "CUSTOM",
		task: {},
	}),
	resolveConfiguredTranslateAgent: () => resolveAgent(),
	runTranslate: (...args: unknown[]) => runTranslate(...args),
}));

type AttachOptions = {
	onStream: (ev: { chunk: string }) => void;
	onCompleted: (ev: {
		content: string;
		providerSessionId?: string;
		stopReason?: string;
	}) => void;
	onFailed: (ev: { error?: string }) => void;
	onSettled?: () => void;
};

function record(id: string): PdfTranslateRecord {
	return {
		version: 1,
		kind: "translate",
		id,
		paperPath: "papers/x",
		createdAt: "2026-01-01T00:00:00.000Z",
		page: 1,
		rects: [],
		quote: "the quick brown text",
	};
}

/** In-memory container double: the persisted-array adapter the PDF hook uses. */
function harness(seed: PdfTranslateRecord) {
	const records = new Map<string, PdfTranslateRecord>([[seed.id, seed]]);
	const persisted: PdfTranslateRecord[] = [];
	const failures: string[] = [];
	const chunks: string[] = [];
	let stops = 0;
	const options = {
		text: seed.quote ?? "the quick brown text",
		context: { page: 1, surface: "pdf-selection" },
		paperKey: `paper:${seed.id}`,
		vaultPath: "/vault",
		noAgentText: () => "no agent",
		agentFailedText: () => "agent failed",
		disposedRef: { current: false },
		unsubsRef: { current: null },
		sessionRef: { current: null },
		activeSessionRef: { current: null },
		appendChunk: (chunk: string) => {
			chunks.push(chunk);
			const latest = records.get(seed.id) ?? seed;
			records.set(seed.id, {
				...latest,
				result: (latest.result ?? "") + chunk,
			});
		},
		commitAgentResult: (ev: { content: string }) => {
			const latest = records.get(seed.id) ?? seed;
			const next = {
				...latest,
				result: (ev.content || latest.result || "").trim(),
			};
			records.set(seed.id, next);
			persisted.push(next);
			return records.has(seed.id);
		},
		commitProviderResult: (result: string) => {
			const latest = records.get(seed.id) ?? seed;
			records.set(seed.id, { ...latest, result });
			persisted.push(records.get(seed.id) as PdfTranslateRecord);
			stops += 1;
		},
		markFailed: (message: string) => {
			failures.push(message);
			const latest = records.get(seed.id);
			if (latest) records.set(seed.id, { ...latest, error: message });
		},
		stopStreaming: () => {
			stops += 1;
		},
	};
	return {
		records,
		persisted,
		failures,
		chunks,
		getStops: () => stops,
		options,
	};
}

const AGENT = { agentId: "agent-1", modelId: "model-1" };

function accepted() {
	return { sessionId: "sess-1", messageId: "m1", agentId: "agent-1" };
}

describe("runSelectionTranslate", () => {
	beforeEach(() => {
		runOnce.mockReset();
		attachAgentRun.mockReset();
		resolveAgent.mockReset();
		runTranslate.mockReset();
		notifyError.mockReset();
		providerId = "agent";
	});

	it("streams an agent run, commits the trimmed result, and rewrites the session cache", async () => {
		const h = harness(record("t1"));
		setAgentTranslateSessionId(
			h.options.paperKey,
			"agent-1",
			"model-1",
			"prov-old",
		);
		resolveAgent.mockResolvedValue(AGENT);
		runOnce.mockResolvedValue(accepted());
		attachAgentRun.mockImplementation(async (raw: AttachOptions) => {
			raw.onStream({ chunk: "Hel" });
			raw.onStream({ chunk: "lo" });
			raw.onCompleted({
				content: " Hello ",
				providerSessionId: "prov-new",
				stopReason: "end",
			});
			raw.onSettled?.();
		});

		await runSelectionTranslate(h.options);

		expect(runOnce).toHaveBeenCalledTimes(1);
		expect(runOnce.mock.calls[0]?.[0]).toMatchObject({
			prompt: "PROMPT:CUSTOM:the quick brown text",
			agentId: "agent-1",
			modelId: "model-1",
			sessionId: "prov-old",
			vaultPath: "/vault",
			workflow: "translate",
			permissionMode: "auto",
			hideFromChatHistory: true,
		});
		expect(h.chunks).toEqual(["Hel", "lo"]);
		expect(h.records.get("t1")?.result).toBe("Hello");
		expect(h.persisted).toHaveLength(1);
		expect(
			getAgentTranslateSessionId(h.options.paperKey, "agent-1", "model-1"),
		).toBe("prov-new");
		expect(h.failures).toEqual([]);
		expect(h.getStops()).toBe(1);
	});

	it("keeps the cached session when the run completes cancelled", async () => {
		const h = harness(record("t2"));
		setAgentTranslateSessionId(
			h.options.paperKey,
			"agent-1",
			"model-1",
			"prov-old",
		);
		resolveAgent.mockResolvedValue(AGENT);
		runOnce.mockResolvedValue(accepted());
		attachAgentRun.mockImplementation(async (raw: AttachOptions) => {
			raw.onCompleted({
				content: "partial",
				providerSessionId: "prov-new",
				stopReason: "cancelled",
			});
			raw.onSettled?.();
		});

		await runSelectionTranslate(h.options);

		expect(
			getAgentTranslateSessionId(h.options.paperKey, "agent-1", "model-1"),
		).toBe("prov-old");
	});

	it("skips the cache write when the record is no longer current", async () => {
		const h = harness(record("t3"));
		setAgentTranslateSessionId(
			h.options.paperKey,
			"agent-1",
			"model-1",
			"prov-old",
		);
		resolveAgent.mockResolvedValue(AGENT);
		runOnce.mockResolvedValue(accepted());
		attachAgentRun.mockImplementation(async (raw: AttachOptions) => {
			raw.onCompleted({
				content: "done",
				providerSessionId: "prov-new",
				stopReason: "end",
			});
			raw.onSettled?.();
		});

		await runSelectionTranslate({
			...h.options,
			commitAgentResult: () => false,
		});

		expect(
			getAgentTranslateSessionId(h.options.paperKey, "agent-1", "model-1"),
		).toBe("prov-old");
	});

	it("evicts the session, notifies, and marks the record on agent failure", async () => {
		const h = harness(record("t4"));
		setAgentTranslateSessionId(
			h.options.paperKey,
			"agent-1",
			"model-1",
			"prov-old",
		);
		resolveAgent.mockResolvedValue(AGENT);
		runOnce.mockResolvedValue(accepted());
		attachAgentRun.mockImplementation(async (raw: AttachOptions) => {
			raw.onFailed({ error: "boom" });
			raw.onSettled?.();
		});

		await runSelectionTranslate(h.options);

		expect(
			getAgentTranslateSessionId(h.options.paperKey, "agent-1", "model-1"),
		).toBeUndefined();
		expect(h.failures).toEqual(["boom"]);
		expect(h.records.get("t4")?.error).toBe("boom");
		expect(notifyError).toHaveBeenCalledWith("boom");
		expect(h.getStops()).toBe(1);
	});

	it("falls back to the failure text when the event carries no error", async () => {
		const h = harness(record("t5"));
		resolveAgent.mockResolvedValue(AGENT);
		runOnce.mockResolvedValue(accepted());
		attachAgentRun.mockImplementation(async (raw: AttachOptions) => {
			raw.onFailed({});
			raw.onSettled?.();
		});

		await runSelectionTranslate(h.options);

		expect(h.failures).toEqual(["agent failed"]);
		expect(notifyError).toHaveBeenCalledWith("agent failed");
	});

	it("notifies and never runs when no agent is configured (streaming left to markFailed)", async () => {
		const h = harness(record("t6"));
		resolveAgent.mockResolvedValue({ agentId: undefined, modelId: undefined });

		await runSelectionTranslate(h.options);

		expect(runOnce).not.toHaveBeenCalled();
		expect(attachAgentRun).not.toHaveBeenCalled();
		expect(h.failures).toEqual(["no agent"]);
		expect(notifyError).toHaveBeenCalledWith("no agent");
		expect(h.getStops()).toBe(0);
	});

	it("surfaces runOnce rejection through the catch path", async () => {
		const h = harness(record("t7"));
		resolveAgent.mockResolvedValue(AGENT);
		runOnce.mockRejectedValue(new Error("nope"));

		await runSelectionTranslate(h.options);

		expect(attachAgentRun).not.toHaveBeenCalled();
		expect(h.failures).toEqual(["nope"]);
		expect(notifyError).toHaveBeenCalledWith("nope");
		expect(h.getStops()).toBe(1);
	});

	it("commits the provider result without touching the agent path", async () => {
		const h = harness(record("t8"));
		providerId = "tencenttransmart";
		runTranslate.mockResolvedValue(" 译文 ");

		await runSelectionTranslate(h.options);

		expect(runOnce).not.toHaveBeenCalled();
		expect(runTranslate).toHaveBeenCalledWith(
			{
				text: "the quick brown text",
				context: { page: 1, surface: "pdf-selection" },
			},
			// The engine forwards its chunk sink so free-MT deltas land in the card.
			{ providerId: "tencenttransmart", onDelta: h.options.appendChunk },
		);
		expect(h.records.get("t8")?.result).toBe("译文");
		expect(h.persisted).toHaveLength(1);
		expect(h.failures).toEqual([]);
		expect(h.getStops()).toBe(1);
	});

	it("wraps provider failures and stops streaming", async () => {
		const h = harness(record("t9"));
		providerId = "tencenttransmart";
		runTranslate.mockRejectedValue(new Error("quota"));

		await runSelectionTranslate(h.options);

		expect(h.failures).toEqual(["displayed:quota"]);
		expect(notifyError).toHaveBeenCalledWith("displayed:quota");
		expect(h.records.get("t9")?.error).toBe("displayed:quota");
		expect(h.getStops()).toBe(1);
	});
});
