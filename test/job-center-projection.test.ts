import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BackgroundTaskIcon,
	backgroundTasksStore,
	updateBackgroundTask,
} from "@/lib/core/background-tasks";
import {
	type JobChangedSnapshot,
	projectJobToBackgroundTask,
	startJobCenterExecutorListener,
	startJobTaskProjection,
	stopJobCenterExecutorListener,
	stopJobTaskProjection,
} from "@/lib/core/job-center";
import {
	registerTaskExecutor,
	type TaskExecutorContext,
} from "@/lib/core/tasks";
import { libraryStore } from "@/lib/paper/library-store";
// Side-effect: register catalog title lookup used by JobCenter subjects.
import "@/lib/paper/task-label";

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
		tauri: false,
		commandSpies,
		eventBindings,
		/** Typed-error envelope (`Result<ApiResult<T>, String>`), as specta wraps. */
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
		/** Fire a wire payload through every captured `events.*` listener. */
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
	// Faithful to the real helper: invoke the bound command and unwrap the
	// typed-error + ApiResult envelope.
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
			// Typed specta binding: `listen(cb)` resolves to the UnlistenFn.
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

const flush = () => new Promise((r) => setTimeout(r, 0));

function layoutJob(
	overrides: Partial<JobChangedSnapshot> = {},
): JobChangedSnapshot {
	return {
		id: "job-layout-1",
		kind: "layoutAnalyze",
		state: "running",
		vaultPath: "/vault",
		paperPath: "papers/a",
		progress: 40,
		phase: "analyzing",
		...overrides,
	};
}

function importJob(
	overrides: Partial<JobChangedSnapshot> = {},
): JobChangedSnapshot {
	return {
		id: "job-import-1",
		kind: "import",
		state: "running",
		vaultPath: "/vault",
		paperPath: "papers",
		progress: null,
		phase: null,
		params: { mode: "lookup", text: "https://arxiv.org/abs/1706.03762" },
		...overrides,
	};
}

function connectorJob(
	overrides: Partial<JobChangedSnapshot> = {},
): JobChangedSnapshot {
	return {
		id: "job-connector-1",
		kind: "connectorSync",
		state: "running",
		vaultPath: "/vault",
		paperPath: "papers/a",
		progress: null,
		phase: null,
		params: {
			key: "session-1:papers/a",
			title: "Attention Is All You Need",
			detail: "Saving browser PDF",
		},
		...overrides,
	};
}

function modelJob(
	overrides: Partial<JobChangedSnapshot> = {},
): JobChangedSnapshot {
	return {
		id: "job-model-1",
		kind: "modelDownload",
		state: "running",
		vaultPath: "",
		paperPath: "",
		progress: null,
		phase: null,
		...overrides,
	};
}

function libraryJob(
	overrides: Partial<JobChangedSnapshot> = {},
): JobChangedSnapshot {
	return {
		id: "job-library-1",
		kind: "libraryIo",
		state: "running",
		vaultPath: "/vault",
		paperPath: "",
		progress: null,
		phase: null,
		params: { op: "export" },
		...overrides,
	};
}

function task(id: string) {
	return backgroundTasksStore.getState().tasks.find((item) => item.id === id);
}

describe("job task projection", () => {
	afterEach(async () => {
		stopJobTaskProjection();
		stopJobCenterExecutorListener();
		mocks.tauri = false;
		vi.clearAllMocks();
		await flush();
		for (const binding of mocks.eventBindings.values()) {
			binding.listeners.length = 0;
			binding.unlistens.length = 0;
		}
		backgroundTasksStore.setState({ tasks: [], expanded: false });
		libraryStore.setState({ paperMetaByRelPath: new Map() });
	});

	it("mirrors a running layout job into the background-task panel", () => {
		projectJobToBackgroundTask(layoutJob());
		const task = backgroundTasksStore
			.getState()
			.tasks.find((item) => item.id === "job-layout-1");
		expect(task?.kind).toBe("layoutAnalyze");
		expect(task?.status).toBe("running");
		expect(task?.progress).toBe(40);
	});

	it("does not resurrect a cancelled layout job from a late running event", async () => {
		mocks.tauri = true;
		startJobTaskProjection();
		expect(mocks.bindingFor("jobChanged").listeners).toHaveLength(1);

		// Inject `job:changed` wire payloads through the captured typed binding.
		mocks.emit("jobChanged", { job: layoutJob({ state: "running" }) });
		mocks.emit("jobChanged", { job: layoutJob({ state: "cancelled" }) });
		mocks.emit("jobChanged", {
			job: layoutJob({ state: "running", progress: 80, phase: "analyzing" }),
		});

		const task = backgroundTasksStore
			.getState()
			.tasks.find((item) => item.id === "job-layout-1");
		expect(task?.status).toBe("cancelled");
		// The panel cancellation still reaches the Host JobCenter.
		expect(mocks.commandSpy("jobCancel")).toHaveBeenCalledWith("job-layout-1");

		// Stopping disposes the typed binding's pending-safe unlisten.
		stopJobTaskProjection();
		await flush();
		expect(mocks.bindingFor("jobChanged").unlistens[0]).toHaveBeenCalledTimes(
			1,
		);
		expect(mocks.bindingFor("jobChanged").listeners).toHaveLength(0);
	});

	it("does not resurrect a completed layout job from a late running event", () => {
		projectJobToBackgroundTask(layoutJob({ state: "running" }));
		projectJobToBackgroundTask(
			layoutJob({ state: "succeeded", progress: 100 }),
		);
		projectJobToBackgroundTask(
			layoutJob({ state: "running", progress: 55, phase: "analyzing" }),
		);

		const task = backgroundTasksStore
			.getState()
			.tasks.find((item) => item.id === "job-layout-1");
		expect(task?.status).toBe("completed");
	});

	it("drives the facade executor: offer ctx, cancel aborts signal, report injects job id", async () => {
		mocks.tauri = true;
		const contexts: TaskExecutorContext[] = [];
		let resolveAborted: () => void = () => undefined;
		const aborted = new Promise<void>((resolve) => {
			resolveAborted = resolve;
		});
		registerTaskExecutor("layoutAnalyze", async (ctx) => {
			contexts.push(ctx);
			ctx.signal.addEventListener("abort", resolveAborted);
			await aborted;
			await ctx.report({ state: "cancelled" });
		});
		startJobCenterExecutorListener();
		await flush();

		mocks.emit("jobOffer", {
			jobId: "job-exec-1",
			kind: "layoutAnalyze",
			vaultPath: "/vault",
			paperPath: "papers/a",
			force: false,
			params: null,
		});
		await flush();
		expect(contexts[0]?.jobId).toBe("job-exec-1");
		expect(contexts[0]?.signal.aborted).toBe(false);
		// The facade attaches exactly one per-offer cancel listener.
		expect(mocks.bindingFor("jobChanged").listeners).toHaveLength(1);

		mocks.emit("jobChanged", {
			job: layoutJob({ id: "job-exec-1", state: "cancelled" }),
		});
		await aborted;
		expect(contexts[0]?.signal.aborted).toBe(true);
		expect(mocks.commandSpy("jobReport")).toHaveBeenCalledWith({
			jobId: "job-exec-1",
			progress: null,
			phase: null,
			error: null,
			state: "cancelled",
		});

		// Settling the executor disposes its per-offer listener.
		await flush();
		await flush();
		expect(mocks.bindingFor("jobChanged").listeners).toHaveLength(0);
	});

	it("projects an import job from its params and keeps the reported status text", () => {
		projectJobToBackgroundTask(importJob({ state: "queued", phase: "queued" }));
		expect(task("job-import-1")?.kind).toBe("import");
		expect(task("job-import-1")?.icon).toBe("search");
		expect(task("job-import-1")?.title).toBe("Add paper");
		// Lookup rows no longer surface the raw identifier / URL as detail.
		expect(task("job-import-1")?.detail).toBeUndefined();
		expect(task("job-import-1")?.status).toBe("queued");
		// No numeric progress yet → the ring stays indeterminate.
		expect(task("job-import-1")?.progress).toBeNull();

		projectJobToBackgroundTask(
			importJob({ phase: "Fetching metadata & assets…" }),
		);
		expect(task("job-import-1")?.detail).toBe("Fetching metadata & assets…");

		// Host byte progress owns the bar; a job:changed without progress must
		// not reset it.
		updateBackgroundTask("job-import-1", { progress: 42 });
		projectJobToBackgroundTask(importJob({ phase: "Downloading PDF" }));
		expect(task("job-import-1")?.progress).toBe(42);

		projectJobToBackgroundTask(
			importJob({
				state: "succeeded",
				phase: "Imported 1 PDFs",
				progress: 100,
			}),
		);
		expect(task("job-import-1")?.status).toBe("completed");
		expect(task("job-import-1")?.detail).toBe("Imported 1 PDFs");
	});

	it("maps every import mode onto the panel identity its legacy row had", () => {
		const cases: Array<
			[Record<string, unknown>, BackgroundTaskIcon, string, string | undefined]
		> = [
			[
				{ mode: "lookup", text: "10.1234/xyz" },
				"search",
				"Add paper",
				undefined,
			],
			[
				{ mode: "plaza", id: "abc", title: "A Paper" },
				"search",
				"Import into library",
				"A Paper",
			],
			[
				{ mode: "coolNotes", title: "A Paper" },
				"layout",
				"Fetch Cool Papers notes",
				"A Paper",
			],
			[
				{ mode: "localPdf", entries: [{ filePath: "/tmp/a.pdf" }] },
				"fileUp",
				"Import PDF",
				"a.pdf",
			],
			[{ mode: "skill" }, "fileUp", "Install Skills", undefined],
		];
		for (const [params, icon, title, detail] of cases) {
			backgroundTasksStore.setState({ tasks: [], expanded: false });
			projectJobToBackgroundTask(
				importJob({ id: `job-${icon}-${title}`, params }),
			);
			const row = task(`job-${icon}-${title}`);
			expect(row?.kind).toBe("import");
			expect(row?.icon).toBe(icon);
			expect(row?.title).toBe(title);
			expect(row?.detail).toBe(detail);
		}
	});

	it("shows catalog paper titles instead of papers/<id> on paper-scoped jobs", () => {
		libraryStore.setState({
			paperMetaByRelPath: new Map([
				[
					"papers/a",
					{
						id: "a",
						path: "papers/a",
						title: "Attention Is All You Need",
					} as never,
				],
			]),
		});
		projectJobToBackgroundTask(layoutJob({ phase: "queued" }));
		expect(task("job-layout-1")?.detail).toBe("Attention Is All You Need");

		projectJobToBackgroundTask(layoutJob({ phase: "analyzing" }));
		expect(task("job-layout-1")?.detail).toBe(
			"Attention Is All You Need · analyzing",
		);
	});

	it("shows the extra local PDFs as a count on the import row", () => {
		projectJobToBackgroundTask(
			importJob({
				id: "job-import-many",
				params: {
					mode: "localPdf",
					entries: [{ filePath: "/tmp/a.pdf" }, { filePath: "/tmp/b.pdf" }],
				},
			}),
		);
		expect(task("job-import-many")?.detail).toBe("a.pdf +1");
	});

	it("projects a connector save as its own row and relays the terminal detail", () => {
		projectJobToBackgroundTask(
			connectorJob({ state: "queued", phase: "queued" }),
		);
		expect(task("job-connector-1")?.kind).toBe("connectorSync");
		expect(task("job-connector-1")?.title).toBe("Attention Is All You Need");
		expect(task("job-connector-1")?.detail).toBe("Saving browser PDF");
		expect(task("job-connector-1")?.progress).toBeNull();

		projectJobToBackgroundTask(connectorJob({ phase: "Browser PDF saved" }));
		expect(task("job-connector-1")?.detail).toBe("Browser PDF saved");

		projectJobToBackgroundTask(
			connectorJob({ state: "succeeded", phase: "Browser PDF saved" }),
		);
		expect(task("job-connector-1")?.status).toBe("completed");
		expect(task("job-connector-1")?.detail).toBe("Browser PDF saved");
	});

	it("falls back to the generic connector title and surfaces save failures", () => {
		projectJobToBackgroundTask(
			connectorJob({ id: "job-connector-2", params: { key: "s:papers/b" } }),
		);
		expect(task("job-connector-2")?.title).toBe("Saving Connector attachment");

		projectJobToBackgroundTask(
			connectorJob({ id: "job-connector-3", phase: "Saving browser PDF" }),
		);
		projectJobToBackgroundTask(
			connectorJob({
				id: "job-connector-3",
				state: "failed",
				error: "Browser PDF save failed",
			}),
		);
		expect(task("job-connector-3")?.status).toBe("failed");
		expect(task("job-connector-3")?.error).toBe("Browser PDF save failed");
	});

	it("projects the model download as the legacy layout-model row", () => {
		projectJobToBackgroundTask(modelJob({ state: "queued", phase: "queued" }));
		expect(task("job-model-1")?.kind).toBe("modelDownload");
		expect(task("job-model-1")?.title).toBe("Download layout model");
		expect(task("job-model-1")?.detail).toBe(
			"ModelScope → HuggingFace · PP-DocLayoutV3",
		);

		projectJobToBackgroundTask(
			modelJob({ state: "succeeded", phase: "modelscope · 130 bytes" }),
		);
		expect(task("job-model-1")?.status).toBe("completed");
		expect(task("job-model-1")?.detail).toBe("modelscope · 130 bytes");
	});

	it("projects the library-scope kinds onto their legacy rows", () => {
		projectJobToBackgroundTask(
			libraryJob({ id: "job-lib-export", params: { op: "export" } }),
		);
		expect(task("job-lib-export")?.kind).toBe("libraryIo");
		expect(task("job-lib-export")?.icon).toBe("package");
		expect(task("job-lib-export")?.title).toBe("Export library");
		expect(task("job-lib-export")?.detail).toBeUndefined();

		projectJobToBackgroundTask(
			libraryJob({ id: "job-lib-import", params: { op: "import" } }),
		);
		expect(task("job-lib-import")?.kind).toBe("libraryIo");
		expect(task("job-lib-import")?.icon).toBe("fileUp");
		expect(task("job-lib-import")?.title).toBe("Import bibliography");

		projectJobToBackgroundTask({
			id: "job-citing-1",
			kind: "citingScan",
			state: "running",
			vaultPath: "/vault",
			paperPath: "",
			progress: null,
			phase: "Reading library metadata…",
		} as JobChangedSnapshot);
		expect(task("job-citing-1")?.kind).toBe("citingScan");
		expect(task("job-citing-1")?.title).toBe("Find papers citing your library");
		expect(task("job-citing-1")?.detail).toBe("Reading library metadata…");
	});

	it("projects a metadata refresh batch with its N/M counter", () => {
		projectJobToBackgroundTask({
			id: "job-refresh-1",
			kind: "metadataRefresh",
			state: "queued",
			vaultPath: "/vault",
			paperPath: "",
			progress: null,
			phase: "queued",
			params: { papers: [{ path: "papers/a" }, { path: "papers/b" }] },
		} as JobChangedSnapshot);
		expect(task("job-refresh-1")?.kind).toBe("metadataRefresh");
		expect(task("job-refresh-1")?.title).toBe("Sync publication info");
		expect(task("job-refresh-1")?.detail).toContain("0 / 2");

		projectJobToBackgroundTask({
			id: "job-refresh-1",
			kind: "metadataRefresh",
			state: "running",
			vaultPath: "/vault",
			paperPath: "",
			progress: 50,
			phase: "1 / 2 · 1 updated · 0 failed · 0 not found",
			params: { papers: [{ path: "papers/a" }, { path: "papers/b" }] },
		} as JobChangedSnapshot);
		expect(task("job-refresh-1")?.progress).toBe(50);
		expect(task("job-refresh-1")?.detail).toBe(
			"1 / 2 · 1 updated · 0 failed · 0 not found",
		);
	});
});
