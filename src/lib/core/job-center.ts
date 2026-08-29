/**
 * Renderer-side executor registry for Rust JobCenter jobs.
 *
 * Rust emits `job:offer` when a renderer-executed job (e.g. layout analysis)
 * starts. This module routes offers to the matching frontend executor and
 * provides helpers to report progress / completion back via `job_report`.
 */

import i18n from "@/i18n";
import {
	type BackgroundTaskKind,
	cancelBackgroundTask,
	completeBackgroundTask,
	failBackgroundTask,
	getBackgroundTasksSnapshot,
	isFinishedBackgroundTask,
	registerBackgroundTaskCancelHandler,
	registerBackgroundTaskCancellation,
	releaseBackgroundTaskCancellation,
	startBackgroundTask,
	updateBackgroundTask,
} from "@/lib/core/background-tasks";
import type {
	JobChangedPayload,
	JobKind,
	JobOfferPayload,
	JobReportArgs,
	JobSnapshot,
	JobState,
} from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { invokeApi } from "@/lib/core/ipc";
import { logger } from "@/lib/core/logger";
import { listenSafe } from "@/lib/core/tauri-events";

export type { JobKind, JobOfferPayload, JobState };

export type JobExecutor = (offer: JobOfferPayload) => Promise<void>;

const executors = new Map<JobKind, JobExecutor>();
const inFlightOffers = new Set<string>();
let offerSubscription: (() => void) | null = null;

export function registerJobExecutor(
	kind: JobKind,
	executor: JobExecutor,
): void {
	executors.set(kind, executor);
}

/**
 * Run one offer, at most once per job id. A throwing executor is reported as
 * `failed` so Rust frees the kind's concurrency slot now instead of waiting out
 * its report timeout.
 */
function dispatchJobOffer(offer: JobOfferPayload): void {
	const executor = executors.get(offer.kind);
	if (!executor) {
		logger.warn("no executor registered for job offer", {
			kind: offer.kind,
			jobId: offer.jobId,
		});
		return;
	}
	if (inFlightOffers.has(offer.jobId)) return;
	inFlightOffers.add(offer.jobId);
	void executor(offer)
		.catch(async (error) => {
			const message = errorText(error);
			logger.error("job executor failed", {
				kind: offer.kind,
				jobId: offer.jobId,
				error: message,
			});
			await jobReport({
				jobId: offer.jobId,
				state: "failed",
				error: message,
			}).catch(() => undefined);
		})
		.finally(() => {
			inFlightOffers.delete(offer.jobId);
		});
}

/**
 * Re-claim renderer-executed jobs Rust already moved to `running`: their
 * `job:offer` was emitted while no listener was attached (first paint, webview
 * reload), and Rust is still blocking on a report for them.
 */
async function claimRunningJobOffers(): Promise<void> {
	try {
		const jobs = await invokeApi<JobChangedSnapshot[]>(
			"job_list",
			{ args: {} },
			{ fallback: "job list failed" },
		);
		for (const job of jobs ?? []) {
			if (job.state !== "running" || !executors.has(job.kind)) continue;
			dispatchJobOffer({
				jobId: job.id,
				kind: job.kind,
				vaultPath: job.vaultPath,
				paperPath: job.paperPath ?? null,
				force: job.force ?? false,
			});
		}
	} catch (error) {
		logger.warn("claiming running job offers failed", {
			error: errorText(error),
		});
	}
}

export function startJobCenterExecutorListener(): void {
	if (offerSubscription) return;
	offerSubscription = listenSafe<JobOfferPayload>("job:offer", (payload) => {
		dispatchJobOffer(payload);
	});
	void claimRunningJobOffers();
}

export function stopJobCenterExecutorListener(): void {
	offerSubscription?.();
	offerSubscription = null;
}

export async function jobReport(args: {
	jobId: string;
	progress?: number | null;
	phase?: string | null;
	error?: string | null;
	state?: JobState | null;
}): Promise<void> {
	await invokeApi(
		"job_report",
		{
			args: {
				jobId: args.jobId,
				progress: args.progress ?? undefined,
				phase: args.phase ?? undefined,
				error: args.error ?? undefined,
				state: args.state ?? undefined,
			} satisfies JobReportArgs,
		},
		{ allowVoid: true },
	);
}

/**
 * Snapshot shape shared by the `job:changed` payload and `job_list`.
 * Bridge alias: the generated Rust type is `JobSnapshot`.
 */
export type JobChangedSnapshot = JobSnapshot;

/**
 * Job kinds projected into the background-tasks panel (§7.6). Kinds absent
 * here (pageCount / wikiReindex) stay silent to avoid idle-lane noise.
 */
const PROJECTED_JOB_KINDS: Partial<Record<JobKind, BackgroundTaskKind>> = {
	layoutAnalyze: "layout",
	parseRefs: "parse",
	parseBody: "pdfParse",
	downloadAssets: "download",
	recognizeMetadata: "recognize",
};

function projectedTaskKind(kind: JobKind): BackgroundTaskKind | null {
	return PROJECTED_JOB_KINDS[kind] ?? null;
}

function jobPanelTitle(kind: JobKind): string {
	switch (kind) {
		case "parseRefs":
			return i18n.t("app:tasks.parseRefs");
		case "parseBody":
			return i18n.t("app:tasks.pdfParse");
		case "downloadAssets":
			return i18n.t("app:tasks.downloadPaper");
		case "recognizeMetadata":
			return i18n.t("app:tasks.recognizeMeta");
		default:
			return i18n.t("app:tasks.layoutAnalysis");
	}
}

let projectionSubscription: (() => void) | null = null;
const wiredJobCancels = new Set<string>();

/**
 * Single global `job:changed` → background-tasks-panel projection (§7.6).
 * Mirrors projected JobCenter jobs into the task store keyed by job id, and
 * routes panel cancellation to `job_cancel`.
 */
export function startJobTaskProjection(): void {
	if (projectionSubscription) return;
	projectionSubscription = listenSafe<JobChangedPayload>(
		"job:changed",
		({ job }) => {
			projectJobToBackgroundTask(job);
		},
	);
	void (async () => {
		try {
			const jobs = await invokeApi<JobChangedSnapshot[]>(
				"job_list",
				{ args: {} },
				{ fallback: "job list failed" },
			);
			for (const job of jobs ?? []) {
				projectJobToBackgroundTask(job);
			}
		} catch (error) {
			logger.warn("job task projection failed to start", {
				error: errorText(error),
			});
		}
	})();
}

export function stopJobTaskProjection(): void {
	projectionSubscription?.();
	projectionSubscription = null;
}

export function projectJobToBackgroundTask(job: JobChangedSnapshot): void {
	const taskKind = projectedTaskKind(job.kind);
	if (!taskKind) return;
	const title = jobPanelTitle(job.kind);
	const detail = job.paperPath ?? undefined;
	switch (job.state) {
		case "queued":
		case "running": {
			const existing = getBackgroundTasksSnapshot().tasks.find(
				(task) => task.id === job.id,
			);
			// A late progress event must not revive a row the user already
			// cancelled (or that already completed). That made Cancel look
			// like a no-op and hid the real JobCenter slot leak.
			if (existing && isFinishedBackgroundTask(existing)) {
				return;
			}
			startBackgroundTask({
				id: job.id,
				kind: taskKind,
				title,
				detail,
				running: job.state === "running",
				progress: typeof job.progress === "number" ? job.progress : null,
			});
			wireJobCancellation(job.id);
			updateBackgroundTask(
				job.id,
				{
					status: job.state === "running" ? "running" : "queued",
					progress: typeof job.progress === "number" ? job.progress : null,
					...(job.phase ? { detail: job.phase } : {}),
				},
				{ absoluteProgress: true },
			);
			return;
		}
		case "succeeded":
		case "skipped":
			completeBackgroundTask(job.id, detail);
			releaseJobCancellation(job.id);
			return;
		case "failed":
			failBackgroundTask(job.id, job.error?.trim() || title);
			releaseJobCancellation(job.id);
			return;
		case "cancelled":
			cancelBackgroundTask(job.id);
			releaseJobCancellation(job.id);
			return;
	}
}

function requestJobCancel(jobId: string): void {
	void invokeApi<boolean>(
		"job_cancel",
		{ jobId },
		{ fallback: "job cancellation failed" },
	).catch((error) =>
		logger.warn("job cancellation failed", {
			jobId,
			error: errorText(error),
		}),
	);
}

function wireJobCancellation(jobId: string): void {
	if (wiredJobCancels.has(jobId)) return;
	wiredJobCancels.add(jobId);
	registerBackgroundTaskCancellation(jobId);
	registerBackgroundTaskCancelHandler(jobId, () => requestJobCancel(jobId));
}

function releaseJobCancellation(jobId: string): void {
	if (!wiredJobCancels.has(jobId)) return;
	wiredJobCancels.delete(jobId);
	releaseBackgroundTaskCancellation(jobId);
}
