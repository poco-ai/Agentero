/**
 * Refresh the library (debounced, quiet) when JobCenter jobs that mutate the
 * catalog or assets settle. The file watcher already refreshes the tree for
 * on-disk changes; catalog edits (e.g. `body_source` after a download or
 * `PAPER.md` parse) are watcher-ignored, so the library reloads its rows.
 * Import and recognition join the same wave instead of rescanning `papers/`.
 *
 * Stays on raw `job:changed` rather than the `job:completed` / `job:failed`
 * lifecycle events because `cancelled` and `skipped` also count as settled
 * here, and those have no lifecycle event.
 */

import i18n from "@/i18n";
import { events, type JobSnapshot } from "@/lib/core/bindings";
import {
	type NotifyOptions,
	notifyError,
	notifyWarning,
} from "@/lib/core/notify";
import {
	basenameOf,
	displayPath,
	joinPath,
	normalizePath,
} from "@/lib/core/path";
import { isTerminalJobState, type JobKind } from "@/lib/core/tasks";
import { listenEventSafe } from "@/lib/core/tauri-events";
import { noteCommittedLibraryList } from "@/lib/lifecycle/refresh-wave";
import { libraryStore, setEditMetaDraft } from "@/lib/paper/library-store";
import { loadPaperMetadata } from "@/lib/paper/load-meta";
import {
	notifyOpenReviewDownloadIssue,
	openReviewPdfIssue,
} from "@/lib/paper/openreview-download";
import { getVaultPath } from "@/lib/vault/store";

const REFRESH_ON_KINDS: ReadonlySet<JobKind> = new Set([
	"downloadAssets",
	"parseBody",
	// Recognition upserts metadata (and may rename/merge folders) — the
	// library rows need the refetch when the job settles.
	"recognizeMetadata",
]);

function notifyRecognitionOutcome(job: JobSnapshot): void {
	if (job.state !== "succeeded" && job.state !== "failed") return;
	const vault = getVaultPath();
	const path = job.paperPath;
	if (!vault || !path) return;
	const vaultKey = (value: string) => normalizePath(displayPath(value));
	if (
		![job.vaultId, job.vaultPath].some(
			(value) => vaultKey(value) === vaultKey(vault),
		)
	) {
		return;
	}

	const params =
		job.params && typeof job.params === "object" && !Array.isArray(job.params)
			? job.params
			: null;
	const name = basenameOf(path);
	const options: NotifyOptions = {
		id: `recognize-metadata:${job.id}`,
		action: {
			label: i18n.t("sidebar:papersLibrary.rowEditMeta"),
			onClick: () => {
				if (getVaultPath() !== vault || libraryStore.getState().editMetaDraft)
					return;
				void loadPaperMetadata(joinPath(vault, path), vault).then((paper) => {
					if (getVaultPath() !== vault || libraryStore.getState().editMetaDraft)
						return;
					if (paper) setEditMetaDraft(paper);
					else
						notifyError(
							i18n.t("sidebar:papersLibrary.recognizePaperUnavailable"),
						);
				});
			},
		},
	};

	if (job.state === "failed") {
		notifyError(
			i18n.t("sidebar:papersLibrary.recognizeFailed", { name }),
			options,
		);
	} else if (params?.warning === "arxiv_rate_limited") {
		// This job may have renamed the paper; the original path is no longer
		// a reliable target for an edit action.
		const id =
			(typeof params.arxivId === "string" && params.arxivId.trim()) || name;
		notifyWarning(
			i18n.t("sidebar:papersLibrary.recognizeArxivRateLimited", { id }),
			{ id: options.id },
		);
	} else if (params?.warning === "no_match") {
		notifyWarning(
			i18n.t("sidebar:papersLibrary.recognizeNoMatch", { name }),
			options,
		);
	}
}

/** Caller owns the returned disposer. */
export function startJobCompletionRefresh(): () => void {
	return listenEventSafe(events.jobChanged, ({ job }) => {
		if (!REFRESH_ON_KINDS.has(job.kind)) return;
		if (!isTerminalJobState(job.state)) return;
		if (job.kind === "recognizeMetadata") notifyRecognitionOutcome(job);
		const issue =
			job.kind === "downloadAssets" && job.state === "failed"
				? openReviewPdfIssue(job.phase)
				: undefined;
		if (issue && job.paperPath) {
			const vault = getVaultPath();
			if (
				vault &&
				[job.vaultId, job.vaultPath].some(
					(value) =>
						normalizePath(displayPath(value)) ===
						normalizePath(displayPath(vault)),
				)
			)
				notifyOpenReviewDownloadIssue(vault, job.paperPath, issue);
		}
		noteCommittedLibraryList();
	});
}
