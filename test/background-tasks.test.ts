import { afterEach, describe, expect, it, vi } from "vitest";
import {
	backgroundTasksStore,
	clearFinishedBackgroundTasks,
	completeBackgroundTask,
	FAILED_TASK_VISIBLE_MS,
	FINISHED_TASK_VISIBLE_MS,
	failBackgroundTask,
	mapDownloadProgress,
	retireFinishedBackgroundTasks,
	startBackgroundTask,
	updateBackgroundTask,
} from "@/lib/core/background-tasks";

function task(id: string) {
	return backgroundTasksStore.getState().tasks.find((item) => item.id === id);
}

describe("background task download progress", () => {
	it("passes the Host-merged byte progress through", () => {
		// PDF and TeX download concurrently and the Host sums their bytes, so
		// a finished TeX stream must not pin the shared row at 100%.
		expect(mapDownloadProgress("assets", 0)).toBe(0);
		expect(mapDownloadProgress("assets", 60)).toBe(60);
		expect(mapDownloadProgress("assets", 100)).toBe(100);
		expect(mapDownloadProgress("pdf", 80)).toBe(80);
		expect(mapDownloadProgress("tex", 100)).toBe(100);
		expect(mapDownloadProgress("assets", null)).toBeNull();
		expect(mapDownloadProgress("parse", null)).toBe(90);
	});

	it("clamps out-of-range byte progress", () => {
		expect(mapDownloadProgress("assets", 140)).toBe(100);
		expect(mapDownloadProgress("assets", -20)).toBe(0);
	});

	it("never regresses a task when a late phase event arrives", () => {
		const id = startBackgroundTask({
			kind: "downloadAssets",
			title: "test",
			progress: 40,
		});

		updateBackgroundTask(id, { progress: 20 });

		expect(
			backgroundTasksStore.getState().tasks.find((task) => task.id === id)
				?.progress,
		).toBe(40);

		backgroundTasksStore.setState({ tasks: [], expanded: false });
	});

	it("dismisses a finished task after its visible window", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const firstFinishedAt = Date.now();
		const done = startBackgroundTask({
			kind: "layoutAnalyze",
			title: "parse",
		});
		completeBackgroundTask(done);
		const secondFinishedAt = firstFinishedAt + 1;
		vi.setSystemTime(secondFinishedAt);
		const alsoDone = startBackgroundTask({ kind: "import", title: "import" });
		completeBackgroundTask(alsoDone);

		// Still visible inside the window (the ring's green check).
		retireFinishedBackgroundTasks(firstFinishedAt + 1000);
		expect(task(done)).toBeDefined();
		expect(task(alsoDone)).toBeDefined();

		// Past the window the rows go away without any acknowledgement.
		retireFinishedBackgroundTasks(firstFinishedAt + FINISHED_TASK_VISIBLE_MS);
		expect(task(done)).toBeUndefined();
		expect(task(alsoDone)).toBeDefined();
		retireFinishedBackgroundTasks(secondFinishedAt + FINISHED_TASK_VISIBLE_MS);
		expect(task(alsoDone)).toBeUndefined();
	});

	it("keeps a failed row visible longer than a completed one", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const finishedAt = Date.now();
		const done = startBackgroundTask({ kind: "parseRefs", title: "refs" });
		completeBackgroundTask(done);
		const failed = startBackgroundTask({ kind: "parseBody", title: "body" });
		failBackgroundTask(failed, "boom");

		// A success is gone after its window, but the error stays readable.
		retireFinishedBackgroundTasks(finishedAt + FINISHED_TASK_VISIBLE_MS);
		expect(task(done)).toBeUndefined();
		expect(task(failed)?.status).toBe("failed");

		retireFinishedBackgroundTasks(finishedAt + FAILED_TASK_VISIBLE_MS);
		expect(task(failed)).toBeUndefined();

		backgroundTasksStore.setState({ tasks: [], expanded: false });
	});

	it("still supports clearing finished rows immediately", () => {
		const id = startBackgroundTask({ kind: "layoutAnalyze", title: "parse" });
		completeBackgroundTask(id);
		clearFinishedBackgroundTasks();
		expect(task(id)).toBeUndefined();
	});
});

afterEach(() => {
	vi.useRealTimers();
	backgroundTasksStore.setState({ tasks: [], expanded: false });
});
