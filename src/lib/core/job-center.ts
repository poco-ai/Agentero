/**
 * Renderer-side executor registry + task-panel projection for Rust JobCenter
 * jobs.
 *
 * Rust emits `job:offer` when a renderer-executed job (e.g. layout analysis)
 * starts. This module routes offers to the matching frontend executor,
 * provides helpers to report progress / completion back via `job_report`,
 * mirrors `job:changed` into the background-tasks panel and renders
 * byte/count `job:progress` events onto the projected rows.
 *
 * Internal bridge: the public facade for background work is `tasks.ts`.
 */

import i18n from "@/i18n";
import {
	type BackgroundTaskIcon,
	cancelBackgroundTask,
	completeBackgroundTask,
	failBackgroundTask,
	formatBytes,
	getBackgroundTasksSnapshot,
	isFinishedBackgroundTask,
	mapDownloadProgress,
	phaseLabel,
	registerBackgroundTaskCancelHandler,
	releaseBackgroundTaskCancelHandler,
	startBackgroundTask,
	updateBackgroundTask,
} from "@/lib/core/background-tasks";
import {
	commands,
	events,
	type JobKind,
	type JobOfferPayload,
	type JobProgressEvent,
	type JobReportArgs,
	type JobSnapshot,
	type JobState,
} from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { logger } from "@/lib/core/logger";
import { joinTaskDetail, paperTaskLabel } from "@/lib/core/task-label";
import { isTauri } from "@/lib/core/tauri";
import { toSafeDisposer } from "@/lib/core/tauri-events";

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
		const jobs = await callApiResult(() => commands.jobList({}), {
			fallback: "job list failed",
		});
		for (const job of jobs ?? []) {
			if (job.state !== "running" || !executors.has(job.kind)) continue;
			dispatchJobOffer({
				jobId: job.id,
				kind: job.kind,
				vaultPath: job.vaultPath,
				paperPath: job.paperPath ?? null,
				force: job.force ?? false,
				params: job.params ?? null,
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
	if (isTauri()) {
		offerSubscription = toSafeDisposer(
			events.jobOffer.listen((event) => {
				dispatchJobOffer(event.payload);
			}),
		);
	} else {
		offerSubscription = () => undefined;
	}
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
	await callApiResult(() =>
		commands.jobReport({
			jobId: args.jobId,
			progress: args.progress ?? null,
			phase: args.phase ?? null,
			error: args.error ?? null,
			state: args.state ?? null,
		} satisfies JobReportArgs),
	);
}

/**
 * Snapshot shape shared by the `job:changed` payload and `job_list`.
 * Bridge alias: the generated Rust type is `JobSnapshot`.
 */
export type JobChangedSnapshot = JobSnapshot;

/**
 * Job kinds projected into the background-tasks panel (§7.6). Kinds absent
 * here (pageCount / wikiReindex / layoutTranslate) stay silent to avoid
 * idle-lane noise.
 */
const PROJECTED_JOB_KINDS: ReadonlySet<JobKind> = new Set([
	"layoutAnalyze",
	"parseRefs",
	"parseBody",
	"downloadAssets",
	"recognizeMetadata",
	"import",
	"connectorSync",
	"modelDownload",
	"citingScan",
	"libraryIo",
	"metadataRefresh",
	"latexCompile",
	"jevSmartHighlights",
]);

/**
 * Import rows keep the icon their legacy row had (`search` for the magic wand
 * and 广场, `layout` for Cool Papers notes).
 */
function importRowIcon(params: unknown): BackgroundTaskIcon {
	switch (jobParams(params).mode) {
		case "lookup":
		case "lookupBatch":
		case "plaza":
			return "search";
		case "coolNotes":
			return "layout";
		default:
			return "fileUp";
	}
}

/** Params-dependent icon hint; other kinds derive their icon from the kind. */
function jobRowIcon(job: JobChangedSnapshot): BackgroundTaskIcon | undefined {
	if (job.kind === "import") return importRowIcon(job.params);
	if (job.kind === "libraryIo") {
		return jobParams(job.params).op === "export" ? "package" : "fileUp";
	}
	if (job.kind === "jevSmartHighlights") return "search";
	return undefined;
}

/** Scheduler-owned phase words carry no user-facing status. */
const LIFECYCLE_PHASES: ReadonlySet<string> = new Set([
	"queued",
	"running",
	"completed",
	"failed",
	"cancelled",
	"dependency failed",
]);

/**
 * The job's status text: executors report their localized phase (the legacy
 * `setDetail`), which the row shows while running and keeps once settled.
 */
function statusDetail(job: JobChangedSnapshot): string | undefined {
	const phase = job.phase?.trim();
	if (!phase || LIFECYCLE_PHASES.has(phase)) return undefined;
	return phase;
}

/** Absent / zero progress stays indeterminate so the ring keeps spinning. */
function panelProgress(job: JobChangedSnapshot): number | null {
	return typeof job.progress === "number" && job.progress > 0
		? job.progress
		: null;
}

function jobPanelTitle(job: JobChangedSnapshot): string {
	switch (job.kind) {
		case "import":
			return importPanelTitle(job.params);
		case "connectorSync":
			return connectorPanelTitle(job.params);
		case "parseRefs":
			return i18n.t("app:tasks.parseRefs");
		case "parseBody":
			return i18n.t("app:tasks.pdfParse");
		case "downloadAssets":
			return i18n.t("app:tasks.downloadPaper");
		case "recognizeMetadata":
			return i18n.t("app:tasks.recognizeMeta");
		case "modelDownload":
			return i18n.t("app:tasks.layoutModelDownload");
		case "citingScan":
			return i18n.t("app:tasks.citingScan");
		case "metadataRefresh":
			return i18n.t("sidebar:papersLibrary.refreshMetadataTaskTitle");
		case "libraryIo":
			return jobParams(job.params).op === "export"
				? i18n.t("app:tasks.libraryExport")
				: i18n.t("app:tasks.libraryImport");
		case "latexCompile":
			return i18n.t("app:tasks.latexCompile");
		case "jevSmartHighlights":
			return i18n.t("app:tasks.jevSmartHighlights");
		default:
			return i18n.t("app:tasks.layoutAnalysis");
	}
}

/**
 * Renderer-executed jobs carry their panel identity in `params`: imports their
 * flow (`mode`) plus source identifiers, Connector saves the progress key and
 * the paper title.
 */
type JobParams = {
	mode?: string;
	text?: string;
	texts?: string[];
	title?: string;
	id?: string;
	detail?: string;
	entries?: Array<{ filePath?: string }>;
	op?: string;
	papers?: unknown[];
	texPath?: string;
};

function jobParams(params: unknown): JobParams {
	return (params && typeof params === "object" ? params : {}) as JobParams;
}

function importPanelTitle(params: unknown): string {
	switch (jobParams(params).mode) {
		case "skillLookup":
			return i18n.t("app:tasks.skillLookup");
		case "skill":
			return i18n.t("sidebar:lookup.skillImportTask");
		case "localPdf":
			return i18n.t("app:tasks.importPdf");
		case "plaza":
			return i18n.t("app:plazaImport.taskTitle");
		case "coolNotes":
			return i18n.t("app:coolPapers.fetchTask");
		case "lookupBatch":
			return i18n.t("sidebar:lookup.batchTask");
		default:
			return i18n.t("app:tasks.lookupImport");
	}
}

function importPanelDetail(job: JobChangedSnapshot): string | undefined {
	const p = jobParams(job.params);
	switch (p.mode) {
		case "lookup":
			// Prefer a resolved title once the executor reports it via params;
			// never surface the raw identifier / URL as the row subject.
			return p.title?.trim().slice(0, 80) || undefined;
		case "lookupBatch":
			// Executor reports the imported count as the phase; the checklist
			// size stays in params.texts for the panel.
			return (
				p.title?.trim().slice(0, 80) ||
				(p.texts ? `${p.texts.length}` : undefined)
			);
		case "plaza":
			return (p.title?.trim() || "").slice(0, 80) || undefined;
		case "coolNotes":
			return (
				(p.title?.trim() || paperTaskLabel(job.paperPath) || "").slice(0, 80) ||
				undefined
			);
		case "localPdf": {
			const first = p.entries?.[0]?.filePath?.split(/[\\/]/).pop();
			const extra = (p.entries?.length ?? 0) - 1;
			if (!first) return undefined;
			return extra > 0 ? `${first} +${extra}` : first;
		}
		default:
			return undefined;
	}
}

/** Connector rows are titled after the paper the attachment belongs to. */
function connectorPanelTitle(params: unknown): string {
	return jobParams(params).title?.trim() || i18n.t("app:tasks.connector");
}

/**
 * Stable paper subject for the row (title preferred). Kept across status /
 * byte-progress updates so the panel does not fall back to `papers/<id>`.
 * `taskPaperPaths` lets progress events re-resolve after a late catalog refresh.
 */
const taskSubjects = new Map<string, string>();
const taskPaperPaths = new Map<string, string>();

function rememberTaskSubject(
	jobId: string,
	subject: string | undefined,
	paperPath?: string | null,
): void {
	const trimmed = subject?.trim();
	if (trimmed) taskSubjects.set(jobId, trimmed);
	const path = paperPath?.trim();
	if (path) taskPaperPaths.set(jobId, path);
}

function resolveTaskSubject(jobId: string): string | undefined {
	const path = taskPaperPaths.get(jobId);
	if (path) {
		const fresh = paperTaskLabel(path);
		if (fresh) {
			taskSubjects.set(jobId, fresh);
			return fresh;
		}
	}
	return taskSubjects.get(jobId);
}

function clearTaskSubject(jobId: string): void {
	taskSubjects.delete(jobId);
	taskPaperPaths.delete(jobId);
}

function jobPanelDetail(job: JobChangedSnapshot): string | undefined {
	if (job.kind === "import") return importPanelDetail(job);
	if (job.kind === "connectorSync") {
		return jobParams(job.params).detail?.slice(0, 80) || undefined;
	}
	if (job.kind === "modelDownload") {
		return i18n.t("app:tasks.layoutModelDetail");
	}
	if (job.kind === "metadataRefresh") {
		// Covers only the queued window: the executor reports real counts as soon as it starts.
		return i18n.t("sidebar:papersLibrary.refreshMetadataTaskDetail", {
			current: 0,
			total: jobParams(job.params).papers?.length ?? 0,
			updated: 0,
			failed: 0,
			empty: 0,
		});
	}
	// Vault-scope kinds carry no paper target.
	if (job.kind === "citingScan" || job.kind === "libraryIo") return undefined;
	// LaTeX rows show the source file name (the tex lives anywhere, not under
	// papers/, so there is no catalog title to resolve).
	if (job.kind === "latexCompile") {
		return jobParams(job.params).texPath?.split(/[\\/]/).pop();
	}
	return paperTaskLabel(job.paperPath);
}

/**
 * Subject used when composing status / progress onto the row.
 * Connector already puts the paper name in `title`, so it has no subject.
 */
function jobPanelSubject(job: JobChangedSnapshot): string | undefined {
	if (job.kind === "import") return importPanelDetail(job);
	if (
		job.kind === "connectorSync" ||
		job.kind === "citingScan" ||
		job.kind === "libraryIo" ||
		job.kind === "modelDownload" ||
		job.kind === "metadataRefresh"
	) {
		return undefined;
	}
	return paperTaskLabel(job.paperPath);
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
	if (isTauri()) {
		projectionSubscription = toSafeDisposer(
			events.jobChanged.listen((event) => {
				projectJobToBackgroundTask(event.payload.job);
			}),
		);
	} else {
		projectionSubscription = () => undefined;
	}
	void (async () => {
		try {
			const jobs = await callApiResult(() => commands.jobList({}), {
				fallback: "job list failed",
			});
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
	if (!PROJECTED_JOB_KINDS.has(job.kind)) return;
	const title = jobPanelTitle(job);
	const subject = jobPanelSubject(job);
	const detail = jobPanelDetail(job);
	const icon = jobRowIcon(job);
	const status = statusDetail(job);
	const progress = panelProgress(job);
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
			// Import / Connector carry their subject in params / title; do not
			// bind their parent-dir paperPath into the re-resolve map.
			rememberTaskSubject(
				job.id,
				subject,
				job.kind === "import" || job.kind === "connectorSync"
					? null
					: job.paperPath,
			);
			const remembered = resolveTaskSubject(job.id);
			const rowDetail = joinTaskDetail(remembered, status ?? detail);
			const paperPath =
				job.kind === "import" || job.kind === "connectorSync"
					? null
					: (job.paperPath ?? null);
			startBackgroundTask({
				id: job.id,
				kind: job.kind,
				title,
				detail: rowDetail,
				paperPath,
				icon,
				running: job.state === "running",
				progress,
			});
			wireJobCancellation(job.id);
			updateBackgroundTask(
				job.id,
				{
					status: job.state === "running" ? "running" : "queued",
					paperPath,
					// Byte progress (`job:progress`) owns the bar for
					// download/import rows, so an absent job progress must not
					// reset it to indeterminate.
					...(progress === null ? {} : { progress }),
					...(rowDetail ? { detail: rowDetail } : {}),
				},
				{ absoluteProgress: true },
			);
			return;
		}
		case "succeeded":
		case "skipped":
			completeBackgroundTask(
				job.id,
				joinTaskDetail(resolveTaskSubject(job.id), status ?? detail),
			);
			clearTaskSubject(job.id);
			releaseJobCancellation(job.id);
			return;
		case "failed":
			failBackgroundTask(job.id, job.error?.trim() || title);
			clearTaskSubject(job.id);
			releaseJobCancellation(job.id);
			return;
		case "cancelled":
			cancelBackgroundTask(job.id);
			clearTaskSubject(job.id);
			releaseJobCancellation(job.id);
			return;
	}
}

export function requestJobCancel(jobId: string): void {
	void callApiResult(() => commands.jobCancel(jobId), {
		fallback: "job cancellation failed",
	}).catch((error) =>
		logger.warn("job cancellation failed", {
			jobId,
			error: errorText(error),
		}),
	);
}

function wireJobCancellation(jobId: string): void {
	if (wiredJobCancels.has(jobId)) return;
	wiredJobCancels.add(jobId);
	registerBackgroundTaskCancelHandler(jobId, () => requestJobCancel(jobId));
}

function releaseJobCancellation(jobId: string): void {
	if (!wiredJobCancels.has(jobId)) return;
	wiredJobCancels.delete(jobId);
	releaseBackgroundTaskCancelHandler(jobId);
}

let progressSubscription: (() => void) | null = null;

/**
 * Single global `job:progress` listener, routed by task id (= job id) onto
 * the projected panel rows. Host runners (model download) and Host commands
 * driven by renderer executors (asset downloads, citing scans, import
 * batches) report byte/count progress under their JobCenter job id.
 */
export function startJobProgressListener(): void {
	if (progressSubscription) return;
	if (isTauri()) {
		progressSubscription = toSafeDisposer(
			events.jobProgress.listen((event) => handleJobProgress(event.payload)),
		);
	} else {
		progressSubscription = () => undefined;
	}
}

export function stopJobProgressListener(): void {
	progressSubscription?.();
	progressSubscription = null;
}

function handleJobProgress(payload: JobProgressEvent): void {
	const id = payload.taskId;
	const task = getBackgroundTasksSnapshot().tasks.find((t) => t.id === id);
	if (!task) return;
	const subject = resolveTaskSubject(id);
	const { downloadedBytes, totalBytes, currentCount, totalCount } = payload;
	if (payload.phase === "parse") {
		updateBackgroundTask(id, {
			progress: mapDownloadProgress(payload.phase, payload.progress),
			detail: joinTaskDetail(subject, phaseLabel(payload.phase)),
		});
		return;
	}
	if (currentCount != null && totalCount != null) {
		updateBackgroundTask(id, {
			progress: payload.progress,
			detail: joinTaskDetail(
				subject,
				i18n.t("app:tasks.batchProgress", {
					phase: phaseLabel(payload.phase),
					current: currentCount,
					total: totalCount,
				}),
			),
		});
		return;
	}
	updateBackgroundTask(id, {
		progress: mapDownloadProgress(payload.phase, payload.progress),
		detail: joinTaskDetail(
			subject,
			totalBytes == null
				? i18n.t("app:tasks.downloadBytesUnknown", {
						phase: phaseLabel(payload.phase),
						downloaded: formatBytes(downloadedBytes),
					})
				: i18n.t("app:tasks.downloadBytes", {
						phase: phaseLabel(payload.phase),
						downloaded: formatBytes(downloadedBytes),
						total: formatBytes(totalBytes),
					}),
		),
	});
}
