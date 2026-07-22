/**
 * Lightweight background-task store (IDE-style progress / queue).
 *
 * Backed by a Zustand store; React reads go through `useBackgroundTasks`
 * (`@/hooks/use-background-tasks`), while non-React callers drive it through
 * the exported action functions.
 */

import { listen } from "@tauri-apps/api/event";
import i18n from "@/i18n";
import { logger } from "@/lib/logger";
import { isTauri } from "@/lib/tauri";
import { createAppStore } from "@/stores/create";

export type BackgroundTaskKind =
	| "download"
	| "downloadAll"
	| "lookup"
	| "import"
	| "export"
	| "parse"
	| "paperRead"
	| "connector"
	| "other";

export type BackgroundTaskStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed";

export type BackgroundTask = {
	id: string;
	kind: BackgroundTaskKind;
	/** Short label shown in the panel */
	title: string;
	/** Secondary line (path, phase, …) */
	detail?: string;
	status: BackgroundTaskStatus;
	/** 0–100; null = indeterminate */
	progress: number | null;
	/** 1-based order among active (queued + running) tasks */
	queueIndex: number;
	error?: string;
	createdAt: number;
	updatedAt: number;
};

export type BackgroundTasksState = {
	tasks: BackgroundTask[];
	expanded: boolean;
};

type BackgroundTaskProgressEvent = {
	taskId: string;
	phase: string;
	downloadedBytes: number;
	totalBytes?: number;
	progress: number | null;
};

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes;
	let unit = -1;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function phaseLabel(phase: string): string {
	if (phase === "pdf") return i18n.t("app:tasks.downloadPhasePdf");
	if (phase === "tex") return i18n.t("app:tasks.downloadPhaseTex");
	return i18n.t("app:tasks.downloadPhaseAsset");
}

export const backgroundTasksStore = createAppStore<BackgroundTasksState>(
	() => ({
		tasks: [],
		expanded: false,
	}),
);

function getState(): BackgroundTasksState {
	return backgroundTasksStore.store.getState();
}

function reindexQueue(tasks: BackgroundTask[]): BackgroundTask[] {
	let i = 1;
	return tasks.map((t) => {
		if (t.status === "queued" || t.status === "running") {
			return { ...t, queueIndex: i++ };
		}
		return { ...t, queueIndex: 0 };
	});
}

/** Apply a full store update, renumbering the active-task queue indices. */
function setStore(next: BackgroundTasksState): void {
	backgroundTasksStore.store.setState({
		...next,
		tasks: reindexQueue(next.tasks),
	});
}

function uid(): string {
	return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Keep completed/failed for a short while, then drop them. */
const COMPLETED_TTL_MS = 4000;
const MAX_HISTORY = 12;

function schedulePrune(id: string) {
	window.setTimeout(() => {
		const tasks = getState().tasks.filter((t) => t.id !== id);
		if (tasks.length !== getState().tasks.length) {
			setStore({ ...getState(), tasks });
		}
		// Collapse when nothing left
		if (
			tasks.every((t) => t.status === "completed" || t.status === "failed") ||
			tasks.length === 0
		) {
			const stillActive = tasks.some(
				(t) => t.status === "queued" || t.status === "running",
			);
			if (!stillActive && tasks.length === 0) {
				setStore({ ...getState(), tasks: [], expanded: false });
			}
		}
	}, COMPLETED_TTL_MS);
}

export function startBackgroundTask(input: {
	kind: BackgroundTaskKind;
	title: string;
	detail?: string;
	/** Start as running immediately (default true). */
	running?: boolean;
	progress?: number | null;
}): string {
	const now = Date.now();
	const task: BackgroundTask = {
		id: uid(),
		kind: input.kind,
		title: input.title,
		detail: input.detail,
		status: input.running === false ? "queued" : "running",
		progress: input.progress === undefined ? null : input.progress,
		queueIndex: 0,
		createdAt: now,
		updatedAt: now,
	};
	const current = getState();
	const tasks = [...current.tasks, task].slice(-MAX_HISTORY - 8);
	setStore({ ...current, tasks, expanded: current.expanded });
	return task.id;
}

export function updateBackgroundTask(
	id: string,
	patch: Partial<
		Pick<BackgroundTask, "title" | "detail" | "status" | "progress" | "error">
	>,
): void {
	const current = getState();
	const tasks = current.tasks.map((t) =>
		t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t,
	);
	setStore({ ...current, tasks });
}

export function completeBackgroundTask(id: string, detail?: string): void {
	updateBackgroundTask(id, {
		status: "completed",
		progress: 100,
		...(detail !== undefined ? { detail } : {}),
	});
	schedulePrune(id);
}

export function failBackgroundTask(id: string, error: string): void {
	updateBackgroundTask(id, {
		status: "failed",
		error,
		detail: error,
	});
	schedulePrune(id);
}

export function setBackgroundTasksExpanded(expanded: boolean): void {
	setStore({ ...getState(), expanded });
}

export function clearFinishedBackgroundTasks(): void {
	const current = getState();
	const tasks = current.tasks.filter(
		(t) => t.status === "queued" || t.status === "running",
	);
	setStore({
		...current,
		tasks,
		expanded: tasks.length > 0 ? current.expanded : false,
	});
}

export function getActiveBackgroundTasks(
	tasks: BackgroundTask[],
): BackgroundTask[] {
	return tasks.filter((t) => t.status === "queued" || t.status === "running");
}

/**
 * Run an async job as a background task with automatic complete/fail.
 */
export async function runBackgroundTask<T>(
	input: {
		kind: BackgroundTaskKind;
		title: string;
		detail?: string;
	},
	fn: (ctx: {
		id: string;
		setProgress: (n: number | null) => void;
		setDetail: (d: string) => void;
	}) => Promise<T>,
): Promise<T> {
	const id = startBackgroundTask({
		kind: input.kind,
		title: input.title,
		detail: input.detail,
		running: true,
		progress: null,
	});
	const start = performance.now();
	const unlisten = isTauri()
		? await listen<BackgroundTaskProgressEvent>(
				"background-task:progress",
				(event) => {
					if (event.payload.taskId !== id) return;
					const { downloadedBytes, totalBytes } = event.payload;
					updateBackgroundTask(id, {
						progress: event.payload.progress,
						detail:
							totalBytes == null
								? i18n.t("app:tasks.downloadBytesUnknown", {
										phase: phaseLabel(event.payload.phase),
										downloaded: formatBytes(downloadedBytes),
									})
								: i18n.t("app:tasks.downloadBytes", {
										phase: phaseLabel(event.payload.phase),
										downloaded: formatBytes(downloadedBytes),
										total: formatBytes(totalBytes),
									}),
					});
				},
			)
		: null;
	logger.info(
		`op start background_task kind=${input.kind} task_id=${id} title=${input.title}`,
	);
	try {
		const result = await fn({
			id,
			setProgress: (n) => updateBackgroundTask(id, { progress: n }),
			setDetail: (d) => updateBackgroundTask(id, { detail: d }),
		});
		completeBackgroundTask(id);
		const ms = Math.round(performance.now() - start);
		logger.info(
			`op end background_task ok=true duration_ms=${ms} kind=${input.kind} task_id=${id}`,
		);
		return result;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		failBackgroundTask(id, msg);
		const ms = Math.round(performance.now() - start);
		logger.error(
			`op end background_task ok=false duration_ms=${ms} kind=${input.kind} task_id=${id} error=${msg}`,
		);
		throw e;
	} finally {
		unlisten?.();
	}
}
