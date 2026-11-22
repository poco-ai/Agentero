import { afterEach, describe, expect, it, vi } from "vitest";

type FakeListener = (event: {
	event: string;
	id: number;
	payload: unknown;
}) => void;

const mocks = vi.hoisted(() => {
	type CommandSpy = ReturnType<typeof vi.fn>;
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
	isTauri: () => true,
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

import {
	startJobCenterExecutorListener,
	stopJobCenterExecutorListener,
} from "@/lib/core/job-center";
import { registerTaskExecutor } from "@/lib/core/tasks";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("task executor abort", () => {
	afterEach(async () => {
		stopJobCenterExecutorListener();
		vi.clearAllMocks();
		await flush();
		for (const binding of mocks.eventBindings.values()) {
			binding.listeners.length = 0;
			binding.unlistens.length = 0;
		}
	});

	it("aborts when the host marks the job failed and drops a late success", async () => {
		mocks.commandSpy("jobRendererClaim").mockResolvedValueOnce({
			status: "ok",
			data: { ok: true, data: true },
		});
		let finished = false;
		registerTaskExecutor("layoutAnalyze", async (ctx) => {
			await new Promise<void>((resolve) => {
				if (ctx.signal.aborted) {
					resolve();
					return;
				}
				ctx.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			await ctx.report({ progress: 100, state: "succeeded" });
			finished = true;
		});
		startJobCenterExecutorListener();

		mocks.emit("jobOffer", {
			jobId: "job-failed",
			kind: "layoutAnalyze",
			vaultPath: "/vault",
			paperPath: "papers/a",
			force: false,
			params: null,
		});
		await vi.waitFor(() =>
			expect(mocks.bindingFor("jobChanged").listeners).toHaveLength(1),
		);
		mocks.emit("jobChanged", {
			job: { id: "job-failed", state: "failed" },
		});
		await vi.waitFor(() => expect(finished).toBe(true));

		const reports = mocks
			.commandSpy("jobReport")
			.mock.calls.map(
				([args]) => args as { jobId?: string; state?: string | null },
			)
			.filter((args) => args.jobId === "job-failed");
		expect(reports.some((args) => args.state === "succeeded")).toBe(false);
	});
});
