import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobSnapshot } from "@/lib/core/bindings";
import {
	createTranslationPublisher,
	observePaperTranslation,
	translationSnapshot,
} from "@/lib/pdf/layout/translation-job";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";

const mocks = vi.hoisted(() => ({
	listeners: new Set<(event: { payload: { job: JobSnapshot } }) => void>(),
	list: vi.fn(),
	enqueue: vi.fn(),
}));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/core/ipc", () => ({
	callApiResult: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/core/bindings", () => ({
	commands: { jobList: mocks.list, jobLayoutTranslateEnqueue: mocks.enqueue },
	events: {
		jobChanged: {
			listen: vi.fn(async (callback) => {
				mocks.listeners.add(callback);
				return () => mocks.listeners.delete(callback);
			}),
		},
	},
}));
const cacheKey = {
	providerId: "tencenttransmart" as const,
	sourceLang: "en",
	targetLang: "zh-CN",
	serviceKey: "test",
};
const item = {
	id: "a",
	pageIndex: 0,
	source: "Source",
	status: "running",
	reflow: { source: "Source" },
} as LayoutTranslateItem;
const job = (patch: Partial<JobSnapshot> = {}) =>
	({
		id: "job-a",
		kind: "layoutTranslate",
		vaultPath: "/vault",
		paperPath: "papers/a",
		state: "running",
		...patch,
	}) as JobSnapshot;
const emit = (snapshot: JobSnapshot) => {
	for (const listener of mocks.listeners)
		listener({ payload: { job: snapshot } });
};
const controllers: AbortController[] = [];
const options = (start = true) => {
	const controller = new AbortController();
	controllers.push(controller);
	return {
		vaultPath: "/vault",
		paperPath: "papers/a",
		start,
		signal: controller.signal,
		onUpdate: vi.fn(),
	};
};
beforeEach(() => {
	mocks.list.mockReset().mockResolvedValue([]);
	mocks.enqueue.mockReset().mockResolvedValue(job());
});
afterEach(() => {
	for (const controller of controllers.splice(0)) controller.abort();
	vi.useRealTimers();
});

it("subscribes to an existing job, renders shared items and detaches independently", async () => {
	mocks.list.mockResolvedValue([job()]);
	const a = options(false),
		b = options(false);
	const first = await observePaperTranslation(a);
	const second = await observePaperTranslation(b);
	expect(first?.jobId).toBe(second?.jobId);
	expect(mocks.enqueue).not.toHaveBeenCalled();
	const report = vi.fn().mockResolvedValue(undefined);
	const publisher = createTranslationPublisher(report, "job-a");
	publisher.publish(cacheKey, [item]);
	expect(a.onUpdate.mock.lastCall?.[1]?.items[0]).toBe(item);
	first?.dispose();
	const calls = a.onUpdate.mock.calls.length;
	publisher.publish(cacheKey, [
		{ ...item, status: "done", translated: "译文" },
	]);
	expect(a.onUpdate).toHaveBeenCalledTimes(calls);
	expect(b.onUpdate.mock.lastCall?.[1]?.items[0].translated).toBe("译文");
	await publisher.flush();
	expect(
		report.mock.lastCall?.[0].params.layoutTranslate.items[0].reflow,
	).toBeUndefined();
	publisher.dispose();
});

it("retains terminal progress received before enqueue responds", async () => {
	const terminal = job({
		state: "succeeded",
		params: {
			layoutTranslate: {
				cacheKey,
				revision: 2,
				items: [
					{ ...item, reflow: undefined, status: "done", translated: "译文" },
				],
			},
		} as never,
	});
	mocks.enqueue.mockImplementation(async () => {
		emit(terminal);
		return job();
	});
	const observer = options();
	await observePaperTranslation(observer);
	expect(observer.onUpdate.mock.lastCall?.[0].state).toBe("succeeded");
	expect(observer.onUpdate.mock.lastCall?.[1]?.items[0].translated).toBe(
		"译文",
	);
});

it("hydrates progress from another window and ignores unrelated vaults", async () => {
	const observer = options();
	await observePaperTranslation(observer);
	const initial = observer.onUpdate.mock.calls.length;
	emit(job({ vaultPath: "/other-vault" }));
	expect(observer.onUpdate).toHaveBeenCalledTimes(initial);
	const remote = job({
		params: {
			layoutTranslate: {
				cacheKey,
				revision: 4,
				items: [{ ...item, reflow: undefined, progress: 0.5 }],
			},
		} as never,
	});
	emit(remote);
	expect(observer.onUpdate.mock.lastCall?.[1]?.items[0].progress).toBe(0.5);
	expect(translationSnapshot(remote)?.revision).toBe(4);
});

it("coalesces Host snapshots and flushes the latest update before completion", async () => {
	vi.useFakeTimers();
	const report = vi.fn().mockResolvedValue(undefined);
	const publisher = createTranslationPublisher(report, "coalesced");
	publisher.publish(cacheKey, [item]);
	publisher.publish(cacheKey, [
		{ ...item, status: "done", translated: "结果" },
	]);
	expect(report).not.toHaveBeenCalled();
	await publisher.flush();
	expect(report).toHaveBeenCalledTimes(1);
	expect(
		report.mock.calls[0][0].params.layoutTranslate.items[0].translated,
	).toBe("结果");
	await vi.runAllTimersAsync();
	expect(report).toHaveBeenCalledTimes(1);
	publisher.dispose();
});

it("disposes an asynchronous subscription when its viewer closes", async () => {
	const observer = options();
	const observing = observePaperTranslation(observer);
	controllers.at(-1)?.abort();
	expect(await observing).toBeNull();
	expect(mocks.listeners.size).toBe(0);
	expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("exposes the enqueued id to a stop requested before the IPC response", async () => {
	let finish: ((job: JobSnapshot) => void) | undefined;
	mocks.enqueue.mockImplementation(
		() =>
			new Promise<JobSnapshot>((resolve) => {
				finish = resolve;
			}),
	);
	const observer = { ...options(), onJob: vi.fn() };
	const observing = observePaperTranslation(observer);
	for (let i = 0; i < 3; i++) await Promise.resolve();
	controllers.at(-1)?.abort();
	finish?.(job());
	expect(await observing).toBeNull();
	expect(observer.onJob).toHaveBeenCalledWith("job-a");
	expect(mocks.listeners.size).toBe(0);
});
