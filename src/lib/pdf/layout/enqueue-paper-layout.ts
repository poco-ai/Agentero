/**
 * Enqueue post-download / post-import layout analysis as a JobCenter task.
 * The renderer registers as the executor and runs local ONNX or the Paddle
 * API when Rust emits `job:offer` for a `layoutAnalyze` job.
 */

import i18n from "@/i18n";
import {
	backgroundTasksStore,
	cancelBackgroundTask,
} from "@/lib/core/background-tasks";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { logger } from "@/lib/core/logger";
import { sameRelPaperPath } from "@/lib/core/path";
import {
	registerTaskExecutor,
	type TaskExecutorContext,
	type TaskReportArgs,
} from "@/lib/core/tasks";
import { findCanonicalPaperPdfPath } from "@/lib/paper/media";
import { analyzePaperLayoutHeadless } from "@/lib/pdf/layout/headless-analyze";
import {
	layoutIndexPath,
	layoutSidecarPath,
	readLayoutSidecar,
} from "@/lib/pdf/layout/io";
import { layoutAnalysisStore } from "@/lib/pdf/layout/store";
import {
	isPathMissingError,
	removeVaultPath,
	vaultPathExists,
	vaultRelativePath,
} from "@/lib/vault";
import { getVaultPath } from "@/lib/vault/store";

const queuedPapers = new Set<string>();

function normalizePaperKey(paperAbsPath: string): string {
	return paperAbsPath.replace(/[/\\]+$/, "").replace(/\\/g, "/");
}

/**
 * Register the renderer-side `layoutAnalyze` executor. Call before
 * `startTaskRuntime` (see `use-app-bootstrap`).
 */
export function registerLayoutTaskExecutor(): void {
	registerTaskExecutor("layoutAnalyze", runLayoutAnalyzeExecutor);
}

async function runLayoutAnalyzeExecutor(
	ctx: TaskExecutorContext,
): Promise<void> {
	const { jobId, vaultPath, paperPath, signal } = ctx;
	const paperAbsPath = paperPath
		? `${vaultPath}/${paperPath}`.replace(/\\/g, "/")
		: vaultPath;
	const paperLabel =
		paperPath?.split("/").filter(Boolean).pop() || paperAbsPath;
	const documentId = `headless-layout-${jobId}`;

	const report = (args: TaskReportArgs) =>
		ctx.report(args).catch((error) => {
			logger.warn("layout analyze job report failed", {
				jobId,
				error: errorText(error),
			});
		});

	const unsub = layoutAnalysisStore.subscribe((state) => {
		const { ui, activeDocumentId } = state;
		if (activeDocumentId !== documentId) return;
		if (ui.stage !== "running" || typeof ui.progress !== "number") return;
		void report({
			progress: ui.progress,
			phase: ui.message?.trim() || i18n.t("viewer:figures.analyzing"),
		});
	});

	try {
		if (signal.aborted) throw new Error("cancelled");
		await analyzePaperLayoutHeadless({
			paperAbsPath,
			paperLabel,
			documentId,
			signal,
			force: ctx.force,
		});
		await report({ progress: 100, phase: "completed", state: "succeeded" });
	} catch (e) {
		const message = errorText(e);
		const state = message.toLowerCase().includes("cancel")
			? "cancelled"
			: "failed";
		await report({ state, error: state === "failed" ? message : undefined });
	} finally {
		unsub();
	}
}

/**
 * After assets land on disk, ensure layout.json is produced. Enqueues a
 * JobCenter `layoutAnalyze` job; the `job:changed` projection owns the task
 * panel row, progress, and cancellation (§7.4 入口②). No-op when the sidecar
 * already exists or a job is already queued for this paper this session.
 */
export function enqueuePaperLayoutAnalysis(opts: {
	paperAbsPath: string;
	paperLabel?: string;
}): void {
	const paperAbsPath = normalizePaperKey(opts.paperAbsPath);
	if (!paperAbsPath || queuedPapers.has(paperAbsPath)) return;

	const vaultPath = getVaultPath();
	if (!vaultPath) return;
	const paperRelPath = paperAbsPath
		.slice(vaultPath.length)
		.replace(/^[/\\]+/, "");
	if (!paperRelPath) return;

	queuedPapers.add(paperAbsPath);

	void (async () => {
		try {
			const cached = await readLayoutSidecar(paperAbsPath);
			if (cached?.regions?.length) return;
			await callApiResult(
				() =>
					commands.jobLayoutAnalyzeEnqueue({
						vaultPath,
						path: paperRelPath,
						lane: "normal",
						force: false,
					}),
				{ fallback: "layout analysis enqueue failed" },
			);
		} catch (e) {
			logger.warn("enqueue paper layout analysis failed", {
				paperAbsPath,
				error: errorText(e),
			});
		} finally {
			queuedPapers.delete(paperAbsPath);
		}
	})();
}

export class LayoutReanalyzeError extends Error {
	readonly code: "missing-pdf" | "missing-paper";

	constructor(code: "missing-pdf" | "missing-paper") {
		super(code);
		this.name = "LayoutReanalyzeError";
		this.code = code;
	}
}

async function removePaperLayoutSidecars(paperAbsPath: string): Promise<void> {
	await Promise.all(
		[layoutSidecarPath(paperAbsPath), layoutIndexPath(paperAbsPath)].map(
			async (path) => {
				try {
					if (!(await vaultPathExists(path))) return;
					await removeVaultPath(path);
				} catch (error) {
					if (isPathMissingError(error)) return;
					logger.warn("layout sidecar remove failed", {
						path,
						error: errorText(error),
					});
				}
			},
		),
	);
}

/**
 * Enqueue a focus `layoutAnalyze` job with `force: true` for one paper.
 * The executor forwards `force` into `analyzePaperLayoutHeadless`, which
 * otherwise returns when `layout.json` already has regions. After the job
 * is queued, the two sidecar files are removed so other readers do not
 * keep the old parse. The root `{id}.pdf` must already be on disk; this
 * does not fall through to `source/assets/`.
 */
export async function forcePaperLayoutAnalysis(opts: {
	paperAbsPath: string;
	paperRelPath?: string | null;
}): Promise<void> {
	const paperAbsPath = opts.paperAbsPath.trim().replace(/[/\\]+$/, "");
	if (!paperAbsPath) throw new LayoutReanalyzeError("missing-paper");

	const vaultPath = getVaultPath();
	if (!vaultPath) throw new LayoutReanalyzeError("missing-paper");

	const explicitRel = (opts.paperRelPath ?? "")
		.replace(/\\/g, "/")
		.replace(/^[/\\]+/, "");
	const paperRelPath =
		explicitRel ||
		vaultRelativePath(vaultPath, paperAbsPath)?.replace(/^[/\\]+/, "") ||
		"";
	if (!paperRelPath) throw new LayoutReanalyzeError("missing-paper");

	const pdfPath = await findCanonicalPaperPdfPath(paperAbsPath);
	if (!pdfPath) throw new LayoutReanalyzeError("missing-pdf");

	const inflight = backgroundTasksStore
		.getState()
		.tasks.filter(
			(task) =>
				task.kind === "layoutAnalyze" &&
				(task.status === "queued" || task.status === "running") &&
				sameRelPaperPath(task.paperPath, paperRelPath),
		);
	await Promise.all(
		inflight.map(async (task) => {
			try {
				await callApiResult(() => commands.jobCancel(task.id), {
					fallback: "layout job cancel failed",
				});
			} catch (error) {
				logger.warn("cancel layout job before force reanalyze failed", {
					jobId: task.id,
					error: errorText(error),
				});
			}
			cancelBackgroundTask(task.id);
		}),
	);

	await callApiResult(
		() =>
			commands.jobLayoutAnalyzeEnqueue({
				vaultPath,
				path: paperRelPath,
				lane: "focus",
				force: true,
			}),
		{ fallback: "layout analysis enqueue failed" },
	);
	// Drop the old parse only after the force job is queued. A failed enqueue
	// leaves the sidecar in place. `force` makes the new run ignore whatever
	// is still on disk, then overwrite it.
	await removePaperLayoutSidecars(paperAbsPath);
}
