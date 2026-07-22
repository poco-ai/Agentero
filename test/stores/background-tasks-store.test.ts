// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	backgroundTasksStore,
	clearFinishedBackgroundTasks,
	completeBackgroundTask,
	failBackgroundTask,
	getActiveBackgroundTasks,
	setBackgroundTasksExpanded,
	startBackgroundTask,
	updateBackgroundTask,
} from "@/stores/background-tasks-store";

function reset() {
	backgroundTasksStore.store.setState({ tasks: [], expanded: false });
}

beforeEach(reset);
afterEach(() => {
	vi.useRealTimers();
	reset();
});

describe("background-tasks-store", () => {
	it("starts tasks running and numbers the active queue", () => {
		const a = startBackgroundTask({ kind: "download", title: "A" });
		const b = startBackgroundTask({ kind: "import", title: "B" });

		const { tasks } = backgroundTasksStore.store.getState();
		expect(tasks.map((t) => t.id)).toEqual([a, b]);
		expect(tasks.every((t) => t.status === "running")).toBe(true);
		expect(tasks.map((t) => t.queueIndex)).toEqual([1, 2]);
	});

	it("queues tasks started with running:false", () => {
		startBackgroundTask({ kind: "other", title: "Q", running: false });
		expect(backgroundTasksStore.store.getState().tasks[0]?.status).toBe(
			"queued",
		);
	});

	it("updates task fields and bumps updatedAt", () => {
		const id = startBackgroundTask({ kind: "other", title: "A" });
		const before = backgroundTasksStore.store.getState().tasks[0];
		updateBackgroundTask(id, { detail: "half", progress: 50 });
		const after = backgroundTasksStore.store.getState().tasks[0];
		expect(after?.detail).toBe("half");
		expect(after?.progress).toBe(50);
		expect(after?.updatedAt).toBeGreaterThanOrEqual(before?.updatedAt ?? 0);
	});

	it("getActiveBackgroundTasks keeps only queued/running", () => {
		const done = startBackgroundTask({ kind: "other", title: "done" });
		startBackgroundTask({ kind: "other", title: "live" });
		completeBackgroundTask(done);
		const active = getActiveBackgroundTasks(
			backgroundTasksStore.store.getState().tasks,
		);
		expect(active.map((t) => t.title)).toEqual(["live"]);
	});

	it("toggles panel expansion", () => {
		setBackgroundTasksExpanded(true);
		expect(backgroundTasksStore.store.getState().expanded).toBe(true);
		setBackgroundTasksExpanded(false);
		expect(backgroundTasksStore.store.getState().expanded).toBe(false);
	});

	it("completes then prunes after the TTL", () => {
		vi.useFakeTimers();
		const id = startBackgroundTask({ kind: "other", title: "A" });
		completeBackgroundTask(id, "ok");

		const done = backgroundTasksStore.store.getState().tasks[0];
		expect(done?.status).toBe("completed");
		expect(done?.progress).toBe(100);
		expect(done?.detail).toBe("ok");
		expect(done?.queueIndex).toBe(0);

		vi.advanceTimersByTime(4000);
		expect(backgroundTasksStore.store.getState().tasks).toHaveLength(0);
	});

	it("fails with an error message then prunes", () => {
		vi.useFakeTimers();
		const id = startBackgroundTask({ kind: "other", title: "A" });
		failBackgroundTask(id, "boom");

		const failed = backgroundTasksStore.store.getState().tasks[0];
		expect(failed?.status).toBe("failed");
		expect(failed?.error).toBe("boom");
		expect(failed?.detail).toBe("boom");

		vi.advanceTimersByTime(4000);
		expect(backgroundTasksStore.store.getState().tasks).toHaveLength(0);
	});

	it("clearFinished drops completed/failed but keeps active", () => {
		const done = startBackgroundTask({ kind: "other", title: "done" });
		const live = startBackgroundTask({ kind: "other", title: "live" });
		completeBackgroundTask(done);
		clearFinishedBackgroundTasks();

		const { tasks } = backgroundTasksStore.store.getState();
		expect(tasks.map((t) => t.id)).toEqual([live]);
	});
});
