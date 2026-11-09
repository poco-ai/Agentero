/**
 * Renderer executors for library-scope jobs: citing scan, bibliography
 * import/export, and bulk metadata refresh. Terminal state is reported once,
 * so handlers just do the work and throw on failure.
 */

import i18n from "@/i18n";
import {
	BackgroundTaskCancelledError,
	isBackgroundTaskCancelledError,
} from "@/lib/core/background-tasks";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { notifyWarning } from "@/lib/core/notify";
import {
	registerTaskExecutor,
	reportTaskPhase,
	type TaskExecutorContext,
	throwIfTaskCancelled,
} from "@/lib/core/tasks";
import { mapLimit } from "@/lib/core/utils";
import {
	exportLibraryToFile,
	importLibraryFromFile,
	resolveIdentifierMetadata,
	syncPublication,
	updatePaperMeta,
} from "@/lib/paper/api";
import {
	currentLookupParentDir,
	resolvedMetaPatch,
} from "@/lib/paper/library-actions";
import {
	refreshLibrary,
	scheduleLibraryRefresh,
	setCitingScanDraft,
} from "@/lib/paper/library-store";
import { libraryCitingScan } from "@/lib/paper/refs";
import { getVaultPath, refreshTree } from "@/lib/vault/store";

/** Register the library-scope executors (before `startTaskRuntime`). */
export function registerLibraryTaskExecutors(): void {
	registerTaskExecutor("citingScan", (ctx) =>
		runGuarded(ctx, runCitingScanJob),
	);
	registerTaskExecutor("libraryIo", (ctx) => runGuarded(ctx, runLibraryIoJob));
	registerTaskExecutor("metadataRefresh", (ctx) =>
		runGuarded(ctx, runMetadataRefreshJob),
	);
}

async function runGuarded(
	ctx: TaskExecutorContext,
	handler: (ctx: TaskExecutorContext) => Promise<void>,
): Promise<void> {
	try {
		await handler(ctx);
		throwIfTaskCancelled(ctx);
		await ctx.report({ progress: 100, state: "succeeded" });
	} catch (error) {
		const cancelled =
			ctx.signal.aborted || isBackgroundTaskCancelledError(error);
		await ctx.report({
			state: cancelled ? "cancelled" : "failed",
			error: cancelled ? undefined : errorText(error),
		});
	}
}

async function runCitingScanJob(ctx: TaskExecutorContext): Promise<void> {
	await reportTaskPhase(ctx, i18n.t("app:tasks.citingScanPhaseMeta"));
	// The Host routes the per-seed counter to the job id and polls it for
	// cancellation (bridged from the job's cancel token).
	const result = await libraryCitingScan(ctx.vaultPath, { taskId: ctx.jobId });
	if (result.cancelled) throw new BackgroundTaskCancelledError();
	await reportTaskPhase(
		ctx,
		i18n.t("sidebar:papersLibrary.citingScanDone", {
			count: result.candidates.length,
		}),
	);
	// The result describes the vault it was scanned from; a switch mid-scan
	// means the dialog would be about the wrong library.
	if (getVaultPath() === ctx.vaultPath) setCitingScanDraft(result);
}

async function runLibraryIoJob(ctx: TaskExecutorContext): Promise<void> {
	const op =
		ctx.params && typeof ctx.params === "object"
			? (ctx.params as { op?: unknown }).op
			: undefined;
	if (op === "export") {
		// A dismissed save dialog resolves to null: soft cancel, job succeeds.
		await exportLibraryToFile({
			vaultPath: ctx.vaultPath,
			format: "bibtex",
		});
		return;
	}
	if (op === "import") {
		const r = await importLibraryFromFile({
			vaultPath: ctx.vaultPath,
			parentDir: currentLookupParentDir(),
		});
		if (!r) return;
		await reportTaskPhase(
			ctx,
			i18n.t("sidebar:papersLibrary.importDone", { count: r.imported }),
		);
		await refreshTree(ctx.vaultPath);
		await refreshLibrary();
		if (r.errors.length) {
			notifyWarning(
				`${i18n.t("sidebar:papersLibrary.importDone", { count: r.imported })}; ${r.errors.slice(0, 2).join("; ")}`,
			);
		}
		return;
	}
	throw new Error(`unknown library op: ${JSON.stringify(ctx.params)}`);
}

type RefreshTarget = { path: string; query: string };

function metadataRefreshTargets(params: unknown): RefreshTarget[] {
	const raw =
		params && typeof params === "object"
			? (params as { papers?: unknown }).papers
			: undefined;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const { path, query } = item as { path?: unknown; query?: unknown };
		return typeof path === "string" && typeof query === "string" && query
			? [{ path, query }]
			: [];
	});
}

/** All paper paths in scope, including papers with no metadata query. */
function metadataSyncPaths(params: unknown): string[] {
	const raw =
		params && typeof params === "object"
			? (params as { syncPaths?: unknown }).syncPaths
			: undefined;
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(path): path is string =>
			typeof path === "string" && path.trim().length > 0,
	);
}

async function runMetadataRefreshJob(ctx: TaskExecutorContext): Promise<void> {
	const papers = metadataRefreshTargets(ctx.params);
	const syncPaths = metadataSyncPaths(ctx.params);
	if (!papers.length && !syncPaths.length) return;
	const stats = { updated: 0, empty: 0, failed: 0, processed: 0 };
	const maxMetadataProgress = syncPaths.length ? 90 : 100;
	const reportStats = (): Promise<void> =>
		ctx
			.report({
				progress: papers.length
					? Math.round((stats.processed / papers.length) * maxMetadataProgress)
					: 90,
				phase: i18n.t("sidebar:papersLibrary.refreshMetadataTaskDetail", {
					current: stats.processed,
					total: papers.length,
					updated: stats.updated,
					failed: stats.failed,
					empty: stats.empty,
				}),
			})
			.catch((error) => {
				logger.warn("metadata refresh report failed", {
					jobId: ctx.jobId,
					error: errorText(error),
				});
			});
	await reportStats();
	// Concurrency 3 to stay polite with metadata providers.
	await mapLimit(papers, 3, async (paper) => {
		if (ctx.signal.aborted) return;
		try {
			const meta = await resolveIdentifierMetadata(paper.query);
			const patch = resolvedMetaPatch(meta);
			if (Object.keys(patch).length > 0 && paper.path) {
				await updatePaperMeta(ctx.vaultPath, paper.path, patch);
				stats.updated++;
				scheduleLibraryRefresh();
			} else {
				stats.empty++;
			}
		} catch (e) {
			stats.failed++;
			logger.error("refresh metadata failed", {
				path: paper.path,
				error: String(e),
			});
		} finally {
			stats.processed++;
			await reportStats();
		}
	});
	throwIfTaskCancelled(ctx);
	if (syncPaths.length) {
		await reportTaskPhase(
			ctx,
			i18n.t("sidebar:papersLibrary.syncPublicationPhase"),
		);
		const sync = await syncPublication(ctx.vaultPath, syncPaths);
		if (sync.metricsFailed > 0) {
			notifyWarning(
				i18n.t("sidebar:papersLibrary.syncPublicationPartial", {
					failed: sync.metricsFailed,
				}),
			);
		}
	}
	await refreshLibrary();
	throwIfTaskCancelled(ctx);
	if (stats.failed > 0) {
		throw new Error(
			i18n.t("sidebar:papersLibrary.refreshMetadataPartial", {
				updated: stats.updated,
				failed: stats.failed,
				empty: stats.empty,
			}),
		);
	}
}
