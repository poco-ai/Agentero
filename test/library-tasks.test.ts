import { afterEach, describe, expect, it, vi } from "vitest";

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

// Renderer jobs are offered to every window; these tests run as the winner.
mocks.commandSpy("jobRendererClaim").mockResolvedValue({
	status: "ok",
	data: { ok: true, data: true },
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
	refreshTree: vi.fn(async () => undefined),
}));

const deps = vi.hoisted(() => ({
	citingScan: vi.fn(),
	exportLibraryToFile: vi.fn(async () => null),
	importLibraryFromFile: vi.fn(),
	resolveIdentifierMetadata: vi.fn(),
	updatePaperMeta: vi.fn(async () => ({})),
	refreshLibrary: vi.fn(async () => undefined),
	scheduleLibraryRefresh: vi.fn(),
	setCitingScanDraft: vi.fn(),
	currentLookupParentDir: vi.fn(() => "papers"),
	resolvedMetaPatch: vi.fn(() => ({ title: "Resolved" })),
	getSettings: vi.fn(() => ({})),
	notifyWarning: vi.fn(),
}));

vi.mock("@/lib/paper/refs", () => ({
	libraryCitingScan: deps.citingScan,
}));

vi.mock("@/lib/paper/api", () => ({
	exportLibraryToFile: deps.exportLibraryToFile,
	importLibraryFromFile: deps.importLibraryFromFile,
	resolveIdentifierMetadata: deps.resolveIdentifierMetadata,
	updatePaperMeta: deps.updatePaperMeta,
}));

vi.mock("@/lib/paper/library-store", () => ({
	refreshLibrary: deps.refreshLibrary,
	scheduleLibraryRefresh: deps.scheduleLibraryRefresh,
	setCitingScanDraft: deps.setCitingScanDraft,
}));

vi.mock("@/lib/paper/library-actions", () => ({
	currentLookupParentDir: deps.currentLookupParentDir,
	resolvedMetaPatch: deps.resolvedMetaPatch,
}));

vi.mock("@/lib/settings/react-store", () => ({
	getSettings: deps.getSettings,
}));

vi.mock("@/lib/core/notify", () => ({
	notifyWarning: deps.notifyWarning,
	notifyError: vi.fn(),
	notifySuccess: vi.fn(),
}));

import {
	startJobCenterExecutorListener,
	stopJobCenterExecutorListener,
} from "@/lib/core/job-center";
import { registerLibraryTaskExecutors } from "@/lib/paper/library-tasks";
import { refreshTree } from "@/lib/vault/store";

const flush = () => new Promise((r) => setTimeout(r, 0));

function offer(jobId: string, kind: string, params: unknown) {
	mocks.emit("jobOffer", {
		jobId,
		kind,
		vaultPath: "/vault",
		paperPath: "",
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

describe("library task executors", () => {
	afterEach(async () => {
		stopJobCenterExecutorListener();
		vi.clearAllMocks();
		await flush();
		for (const binding of mocks.eventBindings.values()) {
			binding.listeners.length = 0;
			binding.unlistens.length = 0;
		}
	});

	it("reports a Host-cancelled citing scan as cancelled", async () => {
		deps.citingScan.mockResolvedValue({
			rawCiting: 0,
			afterFilters: 0,
			gatePassed: 0,
			candidates: [],
			cancelled: true,
			messages: [],
		});
		registerLibraryTaskExecutors();
		startJobCenterExecutorListener();
		await flush();

		offer("job-citing-2", "citingScan", null);
		await flush();
		await flush();

		expect(deps.setCitingScanDraft).not.toHaveBeenCalled();
		const reports = reportCalls("job-citing-2");
		expect(reports.at(-1)).toEqual({
			jobId: "job-citing-2",
			progress: null,
			phase: null,
			error: null,
			state: "cancelled",
			params: null,
		});
		expect(reports.some((r) => r.state === "succeeded")).toBe(false);
	});

	it.each([
		[undefined, "papers"],
		["papers/reading", "papers/reading"],
	])("imports a bibliography with destination %s, refreshes, and warns on partial errors", async (parentDir, expectedParentDir) => {
		deps.importLibraryFromFile.mockResolvedValue({
			imported: 2,
			errors: ["bad entry"],
		});
		registerLibraryTaskExecutors();
		startJobCenterExecutorListener();
		await flush();

		offer("job-lib-import", "libraryIo", { op: "import", parentDir });
		await flush();
		await flush();

		expect(deps.importLibraryFromFile).toHaveBeenCalledWith(
			expect.objectContaining({
				vaultPath: "/vault",
				parentDir: expectedParentDir,
			}),
		);
		expect(refreshTree).toHaveBeenCalledWith("/vault");
		expect(deps.refreshLibrary).toHaveBeenCalledTimes(1);
		expect(deps.notifyWarning).toHaveBeenCalledWith(
			expect.stringContaining("bad entry"),
		);
		expect(reportCalls("job-lib-import").at(-1)).toEqual({
			jobId: "job-lib-import",
			progress: 100,
			phase: null,
			error: null,
			state: "succeeded",
			params: null,
		});
	});

	it("fails a library job with an unknown op", async () => {
		registerLibraryTaskExecutors();
		startJobCenterExecutorListener();
		await flush();

		offer("job-lib-unknown", "libraryIo", { op: "mystery" });
		await flush();
		await flush();

		const [report] = reportCalls("job-lib-unknown");
		expect(report?.state).toBe("failed");
		expect(String(report?.error)).toContain("unknown library op");
	});

	it("refreshes metadata in batch with N/M progress and partial-failure reporting", async () => {
		deps.resolveIdentifierMetadata
			.mockResolvedValueOnce({ title: "A" })
			.mockRejectedValueOnce(new Error("provider down"));
		registerLibraryTaskExecutors();
		startJobCenterExecutorListener();
		await flush();

		offer("job-refresh-1", "metadataRefresh", {
			papers: [
				{ path: "papers/a", query: "10.1/a" },
				{ path: "papers/b", query: "10.1/b" },
			],
		});
		await flush();
		await flush();
		await flush();

		expect(deps.updatePaperMeta).toHaveBeenCalledWith(
			"/vault",
			expect.any(String),
			{ title: "Resolved" },
		);
		const reports = reportCalls("job-refresh-1");
		expect(reports[0]?.progress).toBe(0);
		const last = reports.at(-1);
		expect(last?.state).toBe("failed");
		expect(String(last?.error)).toContain("1 failed");
		expect(deps.refreshLibrary).toHaveBeenCalled();
	});
});
