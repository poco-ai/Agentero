/**
 * Lightweight background-task store (IDE-style progress / queue).
 * zustand vanilla store — usable from plain modules; React subscribes
 * via `useStore` in `use-background-tasks`.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createStore } from "zustand/vanilla";
import i18n from "@/i18n";
import { logger } from "@/lib/core/logger";
import { isTauri } from "@/lib/core/tauri";

export type BackgroundTaskKind =
	| "download"
	| "downloadAll"
	| "lookup"
	| "import"
	| "export"
	| "parse"
	| "paperRead"
	| "voiceDefensePreparation"
	| "voiceDefenseReview"
	| "connector"
	| "other";

export type BackgroundTaskStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

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

type Store = {
	tasks: BackgroundTask[];
	expanded: boolean;
};

type BackgroundTaskProgressEvent = {
	taskId: string;
	phase: string;
	downloadedBytes: number;
	totalBytes?: number;
	progress: number | null;
	/** Optional item counters for batch operations (e.g. import 2/5). */
	currentCount?: number;
	totalCount?: number;
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
	if (phase === "parse") return i18n.t("app:tasks.downloadPhaseParse");
	if (phase === "layout-model")
		return i18n.t("app:tasks.downloadPhaseLayoutModel");
	return i18n.t("app:tasks.downloadPhaseAsset");
}

/**
 * Map byte progress from one asset phase into the progress of the whole task.
 * PDF and TeX are sequential, so a new phase must not reset the task to 0%.
 */
export function mapDownloadProgress(
	phase: string,
	progress: number | null,
): number | null {
	const clamped =
		progress == null ? null : Math.max(0, Math.min(100, progress));
	if (phase === "pdf") return clamped == null ? 0 : Math.round(clamped * 0.5);
	if (phase === "tex") {
		return clamped == null ? 50 : 50 + Math.round(clamped * 0.5);
	}
	// Parsing starts after asset downloads. Keep a determinate overall value
	// until the task can be marked complete at 100%.
	if (phase === "parse") return 90;
	return clamped;
}

/** Vanilla store so plain modules can start/patch tasks without React. */
export const backgroundTasksStore = createStore<Store>(() => ({
	tasks: [],
	expanded: false,
}));

const controllers = new Map<string, AbortController>();

/** Stable cancel message; keep in sync with {@link notifyError} filter. */
export const BACKGROUND_TASK_CANCELLED_MESSAGE = "background task cancelled";

export class BackgroundTaskCancelledError extends Error {
	readonly code = "BACKGROUND_TASK_CANCELLED";

	constructor() {
		super(BACKGROUND_TASK_CANCELLED_MESSAGE);
		this.name = "BackgroundTaskCancelledError";
	}
}

export function isBackgroundTaskCancelledError(error: unknown): boolean {
	return (
		error instanceof BackgroundTaskCancelledError ||
		(error instanceof Error &&
			(error.name === "AbortError" ||
				error.message === BACKGROUND_TASK_CANCELLED_MESSAGE))
	);
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

function setStore(next: Store) {
	backgroundTasksStore.setState(
		{
			...next,
			tasks: reindexQueue(next.tasks),
		},
		true,
	);
}

function store(): Store {
	return backgroundTasksStore.getState();
}

export function getBackgroundTasksSnapshot(): Store {
	return backgroundTasksStore.getState();
}

function uid(): string {
	return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Keep completed/failed for a short while, then drop them. */
const COMPLETED_TTL_MS = 4000;
const MAX_HISTORY = 12;

function schedulePrune(id: string) {
	window.setTimeout(() => {
		const snapshot = getBackgroundTasksSnapshot();
		const tasks = snapshot.tasks.filter((t) => t.id !== id);
		if (tasks.length !== snapshot.tasks.length) {
			const active = tasks.some(
				(t) => t.status === "queued" || t.status === "running",
			);
			setStore({
				...snapshot,
				tasks,
				expanded: active ? snapshot.expanded : false,
			});
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
	/** Stable id (e.g. Host-driven `layout-model`); default random. */
	id?: string;
}): string {
	const now = Date.now();
	const id = input.id?.trim() || uid();
	const existing = store().tasks.find((t) => t.id === id);
	if (
		existing &&
		(existing.status === "queued" || existing.status === "running")
	) {
		return id;
	}
	const task: BackgroundTask = {
		id,
		kind: input.kind,
		title: input.title,
		detail: input.detail,
		status: input.running === false ? "queued" : "running",
		progress: input.progress === undefined ? null : input.progress,
		queueIndex: 0,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
	const without = store().tasks.filter((t) => t.id !== id);
	const tasks = [...without, task].slice(-MAX_HISTORY - 8);
	setStore({ ...store(), tasks, expanded: store().expanded });
	return id;
}

export function updateBackgroundTask(
	id: string,
	patch: Partial<
		Pick<BackgroundTask, "title" | "detail" | "status" | "progress" | "error">
	>,
	opts?: {
		/**
		 * When true, apply `progress` as-is (layout analysis overall %).
		 * Default clamps with Math.max so out-of-order download events cannot
		 * move the bar backwards.
		 */
		absoluteProgress?: boolean;
	},
): void {
	const tasks = store().tasks.map((t) =>
		t.id === id && (t.status !== "cancelled" || patch.status === "cancelled")
			? {
					...t,
					...patch,
					progress:
						patch.progress === undefined
							? t.progress
							: opts?.absoluteProgress ||
									typeof patch.progress !== "number" ||
									t.progress == null
								? patch.progress
								: Math.max(t.progress, patch.progress),
					updatedAt: Date.now(),
				}
			: t,
	);
	setStore({ ...store(), tasks });
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
	// Panel expands on failure only while the pointer is over it / briefly;
	// see background-tasks-panel (hover leave always returns to the ring).
	setBackgroundTasksExpanded(true);
	schedulePrune(id);
}

export function cancelBackgroundTask(id: string): void {
	const task = store().tasks.find((item) => item.id === id);
	if (!task || (task.status !== "queued" && task.status !== "running")) return;
	controllers.get(id)?.abort();
	updateBackgroundTask(id, {
		status: "cancelled",
		detail: i18n.t("app:tasks.cancelled"),
	});
	if (isTauri()) {
		void invoke("background_task_cancel", { taskId: id }).catch((error) =>
			logger.warn(
				`background task cancellation signal failed: ${String(error)}`,
			),
		);
	}
	schedulePrune(id);
}

export function registerBackgroundTaskCancellation(id: string): AbortSignal {
	const controller = new AbortController();
	controllers.set(id, controller);
	return controller.signal;
}

export function releaseBackgroundTaskCancellation(id: string): void {
	controllers.delete(id);
}

type BackgroundTaskFn<T> = (ctx: {
	id: string;
	signal: AbortSignal;
	setProgress: (n: number | null) => void;
	setDetail: (d: string) => void;
}) => Promise<T>;

type BackgroundTaskInput = {
	kind: BackgroundTaskKind;
	title: string;
	detail?: string;
};

function isTaskCancelled(id: string, signal: AbortSignal): boolean {
	return (
		signal.aborted ||
		getBackgroundTasksSnapshot().tasks.find((t) => t.id === id)?.status ===
			"cancelled"
	);
}

function throwIfTaskCancelled(id: string, signal: AbortSignal): void {
	if (isTaskCancelled(id, signal)) {
		throw new BackgroundTaskCancelledError();
	}
}

async function attachProgressListener(id: string): Promise<UnlistenFn | null> {
	if (!isTauri()) return null;
	return listen<BackgroundTaskProgressEvent>(
		"background-task:progress",
		(event) => {
			if (event.payload.taskId !== id) return;
			const { downloadedBytes, totalBytes, currentCount, totalCount } =
				event.payload;
			if (event.payload.phase === "parse") {
				updateBackgroundTask(id, {
					progress: mapDownloadProgress(
						event.payload.phase,
						event.payload.progress,
					),
					detail: phaseLabel(event.payload.phase),
				});
				return;
			}
			if (currentCount != null && totalCount != null) {
				updateBackgroundTask(id, {
					progress: event.payload.progress,
					detail: i18n.t("app:tasks.batchProgress", {
						phase: phaseLabel(event.payload.phase),
						current: currentCount,
						total: totalCount,
					}),
				});
				return;
			}
			updateBackgroundTask(id, {
				progress: mapDownloadProgress(
					event.payload.phase,
					event.payload.progress,
				),
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
	);
}

class Semaphore {
	private running = 0;
	private queue: Array<() => void> = [];

	constructor(private max: number) {}

	setMax(max: number): void {
		this.max = Math.max(1, Math.floor(max));
		this.drain();
	}

	private drain(): void {
		while (this.queue.length > 0 && this.running < this.max) {
			this.running++;
			this.queue.shift()?.();
		}
	}

	async acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new BackgroundTaskCancelledError();
		if (this.running < this.max) {
			this.running++;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const start = () => {
				signal?.removeEventListener("abort", cancel);
				resolve();
			};
			const cancel = () => {
				const index = this.queue.indexOf(start);
				if (index >= 0) this.queue.splice(index, 1);
				reject(new BackgroundTaskCancelledError());
			};
			this.queue.push(start);
			signal?.addEventListener("abort", cancel, { once: true });
		});
	}

	release(): void {
		this.running = Math.max(0, this.running - 1);
		this.drain();
	}
}

const semaphores = new Map<BackgroundTaskKind, Semaphore>();

function getSemaphore(
	kind: BackgroundTaskKind,
	concurrency: number,
): Semaphore {
	let sem = semaphores.get(kind);
	if (!sem) {
		sem = new Semaphore(concurrency);
		semaphores.set(kind, sem);
	} else {
		sem.setMax(concurrency);
	}
	return sem;
}

/**
 * Enqueue an async job as a background task.
 *
 * With `concurrency`, tasks of the same kind share a semaphore and are shown
 * immediately as queued/running. Without it, the task starts immediately.
 */
export async function enqueueBackgroundTask<T>(
	input: BackgroundTaskInput,
	fn: BackgroundTaskFn<T>,
	options?: { concurrency?: number; signal?: AbortSignal },
): Promise<T> {
	const concurrency = options?.concurrency;
	const id = startBackgroundTask({
		kind: input.kind,
		title: input.title,
		detail: input.detail,
		running: concurrency == null,
	});
	const controller = new AbortController();
	controllers.set(id, controller);
	const abortFromExternal = () => controller.abort();
	if (options?.signal?.aborted) controller.abort();
	else
		options?.signal?.addEventListener("abort", abortFromExternal, {
			once: true,
		});
	const unlisten = await attachProgressListener(id);
	logger.info(
		`op enqueue background_task kind=${input.kind} task_id=${id} title=${input.title} concurrency=${concurrency ?? "unlimited"}`,
	);
	let acquired = false;
	try {
		throwIfTaskCancelled(id, controller.signal);
		if (concurrency != null) {
			await getSemaphore(input.kind, concurrency).acquire(controller.signal);
			acquired = true;
		}
		throwIfTaskCancelled(id, controller.signal);
		if (concurrency != null) {
			updateBackgroundTask(id, { status: "running" });
		}
		const result = await fn({
			id,
			signal: controller.signal,
			// Absolute: callers (e.g. layout analysis) publish overall document %.
			setProgress: (n) =>
				updateBackgroundTask(id, { progress: n }, { absoluteProgress: true }),
			setDetail: (d) => updateBackgroundTask(id, { detail: d }),
		});
		throwIfTaskCancelled(id, controller.signal);
		completeBackgroundTask(id);
		return result;
	} catch (e) {
		if (
			isTaskCancelled(id, controller.signal) ||
			isBackgroundTaskCancelledError(e)
		) {
			if (
				getBackgroundTasksSnapshot().tasks.find((t) => t.id === id)?.status !==
				"cancelled"
			) {
				cancelBackgroundTask(id);
			}
			throw new BackgroundTaskCancelledError();
		}
		const msg = e instanceof Error ? e.message : String(e);
		failBackgroundTask(id, msg);
		throw e;
	} finally {
		if (acquired) {
			getSemaphore(input.kind, concurrency as number).release();
		}
		controllers.delete(id);
		options?.signal?.removeEventListener("abort", abortFromExternal);
		unlisten?.();
	}
}

export function setBackgroundTasksExpanded(expanded: boolean): void {
	setStore({ ...store(), expanded });
}

export function clearFinishedBackgroundTasks(): void {
	const tasks = store().tasks.filter(
		(t) => t.status === "queued" || t.status === "running",
	);
	setStore({
		...store(),
		tasks,
		expanded: tasks.length > 0 ? store().expanded : false,
	});
}

export function getActiveBackgroundTasks(
	tasks: BackgroundTask[],
): BackgroundTask[] {
	return tasks.filter((t) => t.status === "queued" || t.status === "running");
}

const FINISHED_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set([
	"completed",
	"failed",
	"cancelled",
]);

export function isFinishedBackgroundTask(task: BackgroundTask): boolean {
	return FINISHED_STATUSES.has(task.status);
}
