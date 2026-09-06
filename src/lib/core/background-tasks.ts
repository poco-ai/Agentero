/**
 * Background-tasks panel store (IDE-style progress rows).
 *
 * Pure view state: row CRUD + panel helpers. Rows are produced by the
 * JobCenter projection (`job-center.ts`) or by local activities (`tasks.ts`
 * `runLocalActivity`); execution orchestration lives in those modules.
 * zustand vanilla store — usable from plain modules; React subscribes
 * via `useStore` in `use-background-tasks`.
 */

import { createStore } from "zustand/vanilla";
import i18n from "@/i18n";
import type { JobKind } from "@/lib/core/bindings";

/** Kinds of pure-frontend rows created by `runLocalActivity`. */
export type LocalActivityKind = "paperRead" | "zoteroMigrate" | "layoutRun";

/** Panel row identity: a projected JobCenter kind, or a local activity. */
export type BackgroundTaskKind = JobKind | LocalActivityKind;

/** Ring/row icon facet. Projection rows whose icon depends on job params
 * (import mode, libraryIo op) carry an explicit hint; the rest derive from
 * the kind. */
export type BackgroundTaskIcon =
	| "download"
	| "search"
	| "fileUp"
	| "package"
	| "layout"
	| "read"
	| "plug"
	| "scan"
	| "list";

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
	/** Params-dependent icon override; defaults derive from `kind`. */
	icon?: BackgroundTaskIcon;
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

export function formatBytes(bytes: number): string {
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

export function phaseLabel(phase: string): string {
	if (phase === "assets") return i18n.t("app:tasks.downloadPhaseAssets");
	if (phase === "pdf") return i18n.t("app:tasks.downloadPhasePdf");
	if (phase === "tex") return i18n.t("app:tasks.downloadPhaseTex");
	if (phase === "parse") return i18n.t("app:tasks.downloadPhaseParse");
	if (phase === "citingFetch") return i18n.t("app:tasks.citingScanPhaseFetch");
	if (phase === "layout-model")
		return i18n.t("app:tasks.downloadPhaseLayoutModel");
	return i18n.t("app:tasks.downloadPhaseAsset");
}

/**
 * Byte progress arrives already merged across the streams sharing a row (the
 * Host downloads PDF and TeX concurrently and sums their bytes), so it only
 * needs clamping.
 */
export function mapDownloadProgress(
	phase: string,
	progress: number | null,
): number | null {
	// Parsing starts after asset downloads and reports no bytes of its own.
	// Keep a determinate overall value until the task completes at 100%.
	if (phase === "parse") return 90;
	return progress == null ? null : Math.max(0, Math.min(100, progress));
}

/** Vanilla store so plain modules can start/patch tasks without React. */
export const backgroundTasksStore = createStore<Store>(() => ({
	tasks: [],
	expanded: false,
}));

const cancelHandlers = new Map<string, () => void>();

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
	icon?: BackgroundTaskIcon;
	/** Start as running immediately (default true). */
	running?: boolean;
	progress?: number | null;
	/** Stable id (e.g. the projected JobCenter job id); default random. */
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
		icon: input.icon,
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
	// Cancel hooks must fire on every click: JobCenter rows route to
	// `job_cancel`, local activities abort their AbortController.
	cancelHandlers.get(id)?.();
	updateBackgroundTask(id, {
		status: "cancelled",
		detail: i18n.t("app:tasks.cancelled"),
	});
	schedulePrune(id);
}

export function registerBackgroundTaskCancelHandler(
	id: string,
	handler: () => void,
): void {
	cancelHandlers.set(id, handler);
}

export function releaseBackgroundTaskCancelHandler(id: string): void {
	cancelHandlers.delete(id);
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
