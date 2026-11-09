/**
 * Import-queue ordering: the magic-wand popover lists queued import jobs and
 * lets the user drag / pin them. The Host JobCenter owns the actual FIFO
 * order, so the local row order is only mirrored after the Host accepts it.
 */

import {
	getBackgroundTasksSnapshot,
	isActiveImportTask,
	reorderBackgroundTasks,
} from "@/lib/core/background-tasks";
import { commands } from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";

/**
 * Apply the given order to the queued import rows. Jobs that already started
 * while the command was in flight are dropped from the local mirror instead of
 * being moved among tasks that are still waiting.
 */
export async function reorderImportQueue(
	orderedQueuedIds: readonly string[],
): Promise<void> {
	if (orderedQueuedIds.length < 2) return;
	await callApiResult(
		() => commands.jobReorder({ jobIds: [...orderedQueuedIds] }),
		{ fallback: "job reorder failed" },
	);
	const stillQueued = new Set(
		getBackgroundTasksSnapshot()
			.tasks.filter(
				(task) => isActiveImportTask(task) && task.status === "queued",
			)
			.map((task) => task.id),
	);
	reorderBackgroundTasks(orderedQueuedIds.filter((id) => stillQueued.has(id)));
}
