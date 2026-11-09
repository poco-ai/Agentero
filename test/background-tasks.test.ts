import { describe, expect, it } from "vitest";
import {
	backgroundTasksStore,
	mapDownloadProgress,
	reorderBackgroundTasks,
	startBackgroundTask,
	updateBackgroundTask,
} from "@/lib/core/background-tasks";

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
});

describe("background task queue reorder", () => {
	it("moves the listed rows in place and keeps their queue indexes", () => {
		backgroundTasksStore.setState({ tasks: [], expanded: false });
		for (const id of ["a", "b", "c"]) {
			startBackgroundTask({ id, kind: "import", title: id });
		}

		// `b` is not listed, so it keeps the middle slot while `c` and `a`
		// swap around it.
		reorderBackgroundTasks(["c", "a"]);

		const tasks = backgroundTasksStore.getState().tasks;
		expect(tasks.map((task) => task.id)).toEqual(["c", "b", "a"]);
		expect(tasks.map((task) => task.queueIndex)).toEqual([1, 2, 3]);

		backgroundTasksStore.setState({ tasks: [], expanded: false });
	});
});
