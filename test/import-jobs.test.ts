import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundTaskCancelledError } from "@/lib/core/background-tasks";

const globalWithWindow = globalThis as typeof globalThis & {
	window?: { setTimeout: typeof setTimeout };
};
globalWithWindow.window = { setTimeout };

type FakeListener = (e: {
	event: string;
	id: number;
	payload: unknown;
}) => void;

const mocks = vi.hoisted(() => {
	type CommandSpy = ReturnType<typeof vi.fn>;
	type FakeListener = (e: {
		event: string;
		id: number;
		payload: unknown;
	}) => void;
	const commandSpies = new Map<string, CommandSpy>();
	const eventBindings = new Map<
		string,
		{ listeners: FakeListener[]; unlistens: CommandSpy[] }
	>();
	const bindingFor = (name: string) => {
		let binding = eventBindings.get(name);
		if (!binding) {
			binding = { listeners: [], unlistens: [] };
			eventBindings.set(name, binding);
		}
		return binding;
	};
	return {
		tauri: true,
		vaultPath: "/vault",
		commandSpies,
		eventBindings,
		commandSpy: (name: string): CommandSpy => {
			let spy = commandSpies.get(name);
			if (!spy) {
				spy = vi.fn(async () => ({
					status: "ok",
					data: { ok: true, data: null },
				}));
				commandSpies.set(name, spy);
			}
			return spy;
		},
		bindingFor,
		emit: (name: string, payload: unknown) => {
			for (const listener of [...bindingFor(name).listeners]) {
				listener({ event: name, id: 1, payload });
			}
		},
	};
});

vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => mocks.tauri,
}));

vi.mock("@/lib/core/ipc", () => ({
	callApi: vi.fn(async () => undefined),
	callApiResult: vi.fn(
		async (
			fn: () => Promise<{
				status: string;
				error?: string;
				data: { ok: boolean; data: unknown };
			}>,
		) => {
			const res = await fn();
			if (res.status === "error") throw new Error(res.error ?? "ipc error");
			if (!res.data.ok) throw new Error("host error");
			return res.data.data;
		},
	),
	callResult: vi.fn(async () => undefined),
}));

vi.mock("@/lib/core/bindings", () => ({
	commands: new Proxy({} as Record<string, unknown>, {
		get: (_target, prop) =>
			typeof prop === "string" ? mocks.commandSpy(prop) : undefined,
	}),
	events: new Proxy({} as Record<string, unknown>, {
		get: (_target, prop) => {
			if (typeof prop !== "string") return undefined;
			const binding = mocks.bindingFor(prop);
			return {
				listen: (cb: FakeListener) => {
					const unlisten = vi.fn(() => {
						const idx = binding.listeners.indexOf(cb);
						if (idx >= 0) binding.listeners.splice(idx, 1);
					});
					binding.listeners.push(cb);
					binding.unlistens.push(unlisten);
					return Promise.resolve(unlisten);
				},
			};
		},
	}),
}));

vi.mock("@/lib/vault/store", () => ({
	getVaultPath: () => mocks.vaultPath,
}));

const handlers = vi.hoisted(() => ({
	lookup: vi.fn(async () => undefined),
	lookupBatch: vi.fn(async () => undefined),
	skill: vi.fn(async () => undefined),
	localPdf: vi.fn(async () => undefined),
	plaza: vi.fn(async () => undefined),
	coolNotes: vi.fn(async () => undefined),
}));

vi.mock("@/lib/paper/import-actions", () => ({
	runLookupImportJob: handlers.lookup,
	runLookupBatchImportJob: handlers.lookupBatch,
	runSkillImportJob: handlers.skill,
	runLocalPdfImportJob: handlers.localPdf,
}));

vi.mock("@/lib/plaza/import", () => ({
	runPlazaImportJob: handlers.plaza,
}));

vi.mock("@/lib/paper/coolpapers", () => ({
	runCoolNotesImportJob: handlers.coolNotes,
}));

import {
	startJobCenterExecutorListener,
	stopJobCenterExecutorListener,
} from "@/lib/core/job-center";
import {
	registerConnectorTaskExecutor,
	startConnectorProgressRelay,
} from "@/lib/paper/import/connector-tasks";
import { registerImportTaskExecutor } from "@/lib/paper/import/import-tasks";

const flush = () => new Promise((r) => setTimeout(r, 0));

function offer(jobId: string, kind: string, params: unknown) {
	mocks.emit("jobOffer", {
		jobId,
		kind,
		vaultPath: "/vault",
		paperPath: "papers",
		force: false,
		params,
	});
}

function reportCalls(jobId: string) {
	return mocks
		.commandSpy("jobReport")
		.mock.calls.map(
			([args]) => args as { jobId: string } & Record<string, unknown>,
		)
		.filter((args) => args.jobId === jobId);
}

describe("import job executor", () => {
	afterEach(async () => {
		stopJobCenterExecutorListener();
		vi.clearAllMocks();
		await flush();
		for (const binding of mocks.eventBindings.values()) {
			binding.listeners.length = 0;
			binding.unlistens.length = 0;
		}
	});

	it("dispatches by params.mode and reports success once", async () => {
		registerImportTaskExecutor();
		startJobCenterExecutorListener();
		await flush();

		offer("job-import-plaza", "import", { mode: "plaza", id: "abc" });
		await flush();

		expect(handlers.plaza).toHaveBeenCalledTimes(1);
		expect(handlers.lookup).not.toHaveBeenCalled();
		const ctx = handlers.plaza.mock.calls[0]?.[0];
		expect(ctx.jobId).toBe("job-import-plaza");
		expect(ctx.paperPath).toBe("papers");
		expect(reportCalls("job-import-plaza")).toEqual([
			{
				jobId: "job-import-plaza",
				progress: 100,
				phase: null,
				error: null,
				state: "succeeded",
			},
		]);
	});

	it("dispatches lookupBatch (chat-review checklist) to the batch executor", async () => {
		registerImportTaskExecutor();
		startJobCenterExecutorListener();
		await flush();

		offer("job-import-chat", "import", {
			mode: "lookupBatch",
			texts: ["arXiv:2603.29080", "https://doi.org/10.1038/nature12373"],
		});
		await flush();

		expect(handlers.lookupBatch).toHaveBeenCalledTimes(1);
		expect(handlers.lookup).not.toHaveBeenCalled();
		const ctx = handlers.lookupBatch.mock.calls[0]?.[0];
		expect(ctx.jobId).toBe("job-import-chat");
		expect(reportCalls("job-import-chat")).toEqual([
			{
				jobId: "job-import-chat",
				progress: 100,
				phase: null,
				error: null,
				state: "succeeded",
			},
		]);
	});

	it("reports a throwing handler as failed with its message", async () => {
		handlers.lookup.mockRejectedValueOnce(new Error("translator offline"));
		registerImportTaskExecutor();
		startJobCenterExecutorListener();
		await flush();

		offer("job-import-lookup", "import", { mode: "lookup", text: "10.1/x" });
		await flush();

		expect(reportCalls("job-import-lookup")).toEqual([
			{
				jobId: "job-import-lookup",
				progress: null,
				phase: null,
				error: "translator offline",
				state: "failed",
			},
		]);
	});

	it("reports cancellation without an error", async () => {
		handlers.localPdf.mockRejectedValueOnce(new BackgroundTaskCancelledError());
		registerImportTaskExecutor();
		startJobCenterExecutorListener();
		await flush();

		offer("job-import-pdf", "import", { mode: "localPdf" });
		await flush();

		expect(reportCalls("job-import-pdf")).toEqual([
			{
				jobId: "job-import-pdf",
				progress: null,
				phase: null,
				error: null,
				state: "cancelled",
			},
		]);
	});

	it("fails an offer whose params carry no known mode", async () => {
		registerImportTaskExecutor();
		startJobCenterExecutorListener();
		await flush();

		offer("job-import-unknown", "import", { mode: "mystery" });
		await flush();

		const [report] = reportCalls("job-import-unknown");
		expect(report?.state).toBe("failed");
		expect(String(report?.error)).toContain("unknown import mode");
	});
});

describe("connector sync relay", () => {
	afterEach(async () => {
		stopJobCenterExecutorListener();
		vi.clearAllMocks();
		await flush();
		for (const binding of mocks.eventBindings.values()) {
			binding.listeners.length = 0;
			binding.unlistens.length = 0;
		}
	});

	function progress(overrides: Record<string, unknown> = {}) {
		mocks.emit("connectorProgress", {
			key: "session-1:papers/a",
			sessionId: "session-1",
			path: "papers/a",
			title: "Attention Is All You Need",
			status: "running",
			progress: null,
			detail: "Saving browser PDF",
			error: null,
			...overrides,
		});
	}

	it("enqueues one job per progress key and relays the stream", async () => {
		registerConnectorTaskExecutor();
		const dispose = startConnectorProgressRelay();
		startJobCenterExecutorListener();
		await flush();

		progress();
		await flush();

		expect(mocks.commandSpy("jobConnectorSyncEnqueue")).toHaveBeenCalledWith({
			vaultPath: "/vault",
			path: "papers/a",
			lane: "normal",
			force: false,
			params: {
				key: "session-1:papers/a",
				title: "Attention Is All You Need",
				detail: "Saving browser PDF",
			},
		});

		offer("job-connector-1", "connectorSync", {
			key: "session-1:papers/a",
			title: "Attention Is All You Need",
			detail: "Saving browser PDF",
		});
		await flush();
		// The event that triggered the enqueue is replayed from the buffer.
		expect(reportCalls("job-connector-1")).toEqual([
			{
				jobId: "job-connector-1",
				progress: null,
				phase: "Saving browser PDF",
				error: null,
				state: null,
			},
		]);

		progress({ status: "completed", detail: "Browser PDF saved" });
		await flush();
		expect(reportCalls("job-connector-1")).toHaveLength(2);
		expect(reportCalls("job-connector-1")[1]).toEqual({
			jobId: "job-connector-1",
			progress: null,
			phase: "Browser PDF saved",
			error: null,
			state: "succeeded",
		});

		// A later save for the same key starts a fresh job.
		progress();
		await flush();
		expect(mocks.commandSpy("jobConnectorSyncEnqueue")).toHaveBeenCalledTimes(
			2,
		);

		dispose();
	});

	it("relays a failure with the Host error", async () => {
		registerConnectorTaskExecutor();
		const dispose = startConnectorProgressRelay();
		startJobCenterExecutorListener();
		await flush();

		progress({
			key: "session-2:papers/b",
			status: "failed",
			detail: "Browser PDF save failed",
			error: "login wall",
		});
		await flush();
		offer("job-connector-2", "connectorSync", { key: "session-2:papers/b" });
		await flush();

		expect(reportCalls("job-connector-2")).toEqual([
			{
				jobId: "job-connector-2",
				progress: null,
				phase: "Browser PDF save failed",
				error: "login wall",
				state: "failed",
			},
		]);

		dispose();
	});

	it("stops relaying a cancelled job and re-enqueues on the next event", async () => {
		registerConnectorTaskExecutor();
		const dispose = startConnectorProgressRelay();
		startJobCenterExecutorListener();
		await flush();

		progress({ key: "session-3:papers/c", path: "papers/c" });
		await flush();
		offer("job-connector-4", "connectorSync", { key: "session-3:papers/c" });
		await flush();
		expect(reportCalls("job-connector-4")).toHaveLength(1);

		mocks.emit("jobChanged", {
			job: { id: "job-connector-4", kind: "connectorSync", state: "cancelled" },
		});
		await flush();

		progress({
			key: "session-3:papers/c",
			path: "papers/c",
			status: "completed",
			detail: "Browser PDF saved",
		});
		await flush();

		// The cancelled job reports nothing more; the key starts a fresh job.
		expect(reportCalls("job-connector-4")).toHaveLength(1);
		expect(mocks.commandSpy("jobConnectorSyncEnqueue")).toHaveBeenCalledTimes(
			2,
		);

		dispose();
	});

	it("settles a re-claimed job whose stream predates this renderer", async () => {
		registerConnectorTaskExecutor();
		startJobCenterExecutorListener();
		await flush();

		offer("job-connector-3", "connectorSync", { key: "session-9:papers/z" });
		await flush();

		expect(reportCalls("job-connector-3")).toEqual([
			{
				jobId: "job-connector-3",
				progress: null,
				phase: null,
				error: null,
				state: "cancelled",
			},
		]);
	});
});
