/**
 * Enqueue post-download / post-import layout analysis as a background task.
 * Opens the paper later still re-runs as a guarantee (cache hit is silent).
 *
 * The analysis itself prefers the hidden layout-worker window (own WebContent
 * process — an ONNX/PDFium OOM cannot crash the main window); non-Tauri
 * environments fall back to running in-process.
 */

import i18n from "@/i18n";
import {
	enqueueBackgroundTask,
	isBackgroundTaskCancelledError,
} from "@/lib/core/background-tasks";
import { logger } from "@/lib/core/logger";
import { shouldSkipAutoLayoutAnalysis } from "@/lib/pdf/layout/crash-guard";
import { analyzePaperLayoutHeadless } from "@/lib/pdf/layout/headless-analyze";
import { readLayoutSidecar } from "@/lib/pdf/layout/io";
import { layoutAnalysisStore } from "@/lib/pdf/layout/store";
import {
	isLayoutWorkerAvailable,
	LayoutWorkerCancelledError,
	runLayoutAnalysisInWorker,
} from "@/lib/pdf/layout/worker-client";
import { getVaultPath } from "@/lib/vault/store";

/** Papers already queued or running headless analysis this session. */
const queuedPapers = new Set<string>();

function normalizePaperKey(paperAbsPath: string): string {
	return paperAbsPath.replace(/[/\\]+$/, "").replace(/\\/g, "/");
}

/**
 * After assets land on disk, ensure layout.json is produced.
 * No-op when sidecar already exists or a job is already queued for this paper.
 */
export function enqueuePaperLayoutAnalysis(opts: {
	paperAbsPath: string;
	/** Short label for the tasks panel (vault-rel path / title). */
	paperLabel?: string;
}): void {
	const paperAbsPath = normalizePaperKey(opts.paperAbsPath);
	if (!paperAbsPath || queuedPapers.has(paperAbsPath)) return;

	const label =
		opts.paperLabel?.trim() ||
		paperAbsPath.split("/").filter(Boolean).pop() ||
		paperAbsPath;

	queuedPapers.add(paperAbsPath);

	void (async () => {
		try {
			const cached = await readLayoutSidecar(paperAbsPath);
			if (cached?.regions?.length) {
				queuedPapers.delete(paperAbsPath);
				return;
			}

			// Before the queue even loads the PDF into memory: previous runs for
			// this paper crashed the WebView mid-analysis, so do not auto-retry.
			if (shouldSkipAutoLayoutAnalysis(paperAbsPath)) {
				logger.warn("headless layout skipped after repeated crashes", {
					paperAbsPath,
				});
				return;
			}

			await enqueueBackgroundTask(
				{
					kind: "parse",
					title: i18n.t("app:tasks.layoutAnalysis"),
					detail: label,
				},
				async ({ setProgress, setDetail, signal }) => {
					const describeProgress = (input: {
						progress: number | null;
						message: string;
						page: number | null;
						total: number | null;
					}) => {
						if (typeof input.progress === "number") {
							setProgress(input.progress);
						}
						const message =
							input.message.trim() || i18n.t("viewer:figures.analyzing");
						const pageLine =
							input.total != null && input.page != null
								? i18n.t("viewer:figures.progressPages", {
										page: input.page,
										total: input.total,
									})
								: typeof input.progress === "number"
									? i18n.t("viewer:figures.progressPct", {
											pct: Math.round(input.progress),
										})
									: null;
						setDetail(pageLine ? `${message} · ${pageLine}` : message);
					};

					setProgress(0);
					setDetail(i18n.t("viewer:pdf.layout.preparingModel"));
					if (signal.aborted) throw new Error("cancelled");

					// Preferred path: hidden worker window (isolated WebContent
					// process). The crash guard is maintained inside the worker via
					// run-analysis and shared through same-origin localStorage.
					if (isLayoutWorkerAvailable()) {
						try {
							const result = await runLayoutAnalysisInWorker({
								paperAbsPath,
								vaultPath: getVaultPath(),
								signal,
								onProgress: (progress) => describeProgress(progress),
							});
							setProgress(100);
							setDetail(result.summary);
						} catch (error) {
							if (error instanceof LayoutWorkerCancelledError) {
								throw new Error("cancelled");
							}
							throw error;
						}
						return;
					}

					// Fallback (plain browser / tests): analyze in this process.
					const syncFromLayoutUi = () => {
						const { ui } = layoutAnalysisStore.getState();
						if (ui.stage !== "running") return;
						describeProgress({
							progress: typeof ui.progress === "number" ? ui.progress : null,
							message: ui.message ?? "",
							page:
								typeof ui.page === "number" && ui.page > 0
									? ui.page
									: typeof ui.completed === "number"
										? ui.completed
										: null,
							total:
								typeof ui.total === "number" && ui.total > 0 ? ui.total : null,
						});
					};
					const unsub = layoutAnalysisStore.subscribe(syncFromLayoutUi);
					syncFromLayoutUi();
					try {
						const result = await analyzePaperLayoutHeadless({
							paperAbsPath,
							signal,
						});
						setProgress(100);
						setDetail(result.summary);
					} finally {
						unsub();
					}
				},
				// One ONNX layout job at a time.
				{ concurrency: 1 },
			);
		} catch (e) {
			if (isBackgroundTaskCancelledError(e)) return;
			logger.warn("enqueue paper layout analysis failed", {
				paperAbsPath,
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			queuedPapers.delete(paperAbsPath);
		}
	})();
}
