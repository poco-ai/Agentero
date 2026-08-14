import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	backgroundTasksStore,
	cancelBackgroundTask,
	enqueueBackgroundTask,
	isBackgroundTaskCancelledError,
	mapDownloadProgress,
	startBackgroundTask,
	updateBackgroundTask,
} from "@/lib/core/background-tasks";

beforeEach(() => {
	vi.stubGlobal("window", { setTimeout: vi.fn(() => 0) });
});

afterEach(() => {
	backgroundTasksStore.setState({ tasks: [], expanded: false });
	vi.unstubAllGlobals();
});

describe("background task download progress", () => {
	it("maps sequential PDF and TeX phases into one overall progress", () => {
		expect(mapDownloadProgress("pdf", 0)).toBe(0);
		expect(mapDownloadProgress("pdf", 80)).toBe(40);
		expect(mapDownloadProgress("tex", 0)).toBe(50);
		expect(mapDownloadProgress("tex", 60)).toBe(80);
		expect(mapDownloadProgress("tex", 100)).toBe(100);
		expect(mapDownloadProgress("parse", null)).toBe(90);
	});

	it("never regresses a task when a late phase event arrives", () => {
		const id = startBackgroundTask({
			kind: "download",
			title: "test",
			progress: 40,
		});

		updateBackgroundTask(id, { progress: 20 });

		expect(
			backgroundTasksStore.getState().tasks.find((task) => task.id === id)
				?.progress,
		).toBe(40);
	});
});

describe("voice defense preparation queue", () => {
	it("limits preparation runs for different papers to one at a time", async () => {
		let releaseFirst: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let markFirstRunning: (() => void) | undefined;
		const firstRunning = new Promise<void>((resolve) => {
			markFirstRunning = resolve;
		});
		let markSecondRunning: (() => void) | undefined;
		const secondRunning = new Promise<void>((resolve) => {
			markSecondRunning = resolve;
		});

		const first = enqueueBackgroundTask(
			{
				kind: "voiceDefensePreparation",
				title: "Paper A",
			},
			async () => {
				markFirstRunning?.();
				await firstStarted;
			},
			{ concurrency: 1 },
		);
		await firstRunning;

		const second = enqueueBackgroundTask(
			{
				kind: "voiceDefensePreparation",
				title: "Paper B",
			},
			async () => {
				markSecondRunning?.();
			},
			{ concurrency: 1 },
		);
		await Promise.resolve();

		expect(
			backgroundTasksStore
				.getState()
				.tasks.find((task) => task.title === "Paper A")?.status,
		).toBe("running");
		expect(
			backgroundTasksStore
				.getState()
				.tasks.find((task) => task.title === "Paper B")?.status,
		).toBe("queued");

		releaseFirst?.();
		await first;
		await secondRunning;
		await second;

		expect(
			backgroundTasksStore
				.getState()
				.tasks.find((task) => task.title === "Paper B")?.status,
		).toBe("completed");
	});

	it("removes a cancelled queued preparation without starting it", async () => {
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstRunning: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			firstRunning = resolve;
		});
		const first = enqueueBackgroundTask(
			{ kind: "voiceDefensePreparation", title: "Paper A" },
			async () => {
				firstRunning?.();
				await firstGate;
			},
			{ concurrency: 1 },
		);
		await firstStarted;

		const secondWorker = vi.fn();
		const second = enqueueBackgroundTask(
			{ kind: "voiceDefensePreparation", title: "Paper B" },
			async () => secondWorker(),
			{ concurrency: 1 },
		);
		await vi.waitFor(() => {
			expect(
				backgroundTasksStore
					.getState()
					.tasks.find((task) => task.title === "Paper B")?.status,
			).toBe("queued");
		});
		const queuedId = backgroundTasksStore
			.getState()
			.tasks.find((task) => task.title === "Paper B")?.id;
		expect(queuedId).toBeTruthy();
		cancelBackgroundTask(queuedId as string);

		await expect(second).rejects.toSatisfy(isBackgroundTaskCancelledError);
		expect(secondWorker).not.toHaveBeenCalled();
		releaseFirst?.();
		await first;
	});
});
