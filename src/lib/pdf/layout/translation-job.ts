/** Shared document execution: local prepared items, Host snapshots across windows. */
import {
	commands,
	events,
	type JobSnapshot,
	type Json,
} from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";
import { normalizePath, sameRelPaperPath } from "@/lib/core/path";
import type { TaskReportArgs } from "@/lib/core/tasks";
import { isTauri } from "@/lib/core/tauri";
import type { LayoutCompletenessWarning } from "@/lib/pdf/layout/completeness";
import type { LayoutTranslateCacheKey } from "@/lib/pdf/layout/layout-translate";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";

export type TranslationSnapshot = {
	cacheKey: LayoutTranslateCacheKey;
	items: LayoutTranslateItem[];
	revision: number;
	fromCache?: boolean;
	cacheOnly?: boolean;
	layoutWarnings?: LayoutCompletenessWarning[];
	layoutPageCount?: number | null;
};
const localSnapshots = new Map<string, TranslationSnapshot>();
const listeners = new Set<
	(jobId: string, snapshot: TranslationSnapshot) => void
>();

export function translationSnapshot(
	job: JobSnapshot,
): TranslationSnapshot | null {
	const wire = (job.params as { layoutTranslate?: TranslationSnapshot } | null)
		?.layoutTranslate;
	const local = localSnapshots.get(job.id);
	return local && local.revision >= (wire?.revision ?? 0)
		? local
		: (wire ?? null);
}

/** Keep character IR in the executor; transport only translation state. */
export function createTranslationPublisher(
	report: (args: TaskReportArgs) => Promise<void>,
	jobId: string,
) {
	let revision = 0;
	let fromCache: boolean | undefined;
	let cacheOnly: boolean | undefined;
	let layoutWarnings: LayoutCompletenessWarning[] | undefined;
	let layoutPageCount: number | null | undefined;
	let pending: TranslationSnapshot | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let tail = Promise.resolve();
	const flush = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		const snapshot = pending;
		pending = null;
		if (snapshot) {
			const items = snapshot.items.map(
				({
					reflow: _ir,
					reflowPreview: _preview,
					reflowPreviewSources: _previewSources,
					reflowLayout: _layout,
					...item
				}) => item,
			);
			tail = tail.then(() =>
				report({
					params: {
						layoutTranslate: { ...snapshot, items },
					} as unknown as Json,
				}),
			);
		}
		return tail;
	};
	return {
		publish(
			cacheKey: LayoutTranslateCacheKey,
			items: LayoutTranslateItem[],
			layout?: {
				warnings: LayoutCompletenessWarning[];
				pageCount: number | null;
			},
		) {
			if (layout) {
				layoutWarnings = layout.warnings;
				layoutPageCount = layout.pageCount;
			}
			fromCache ??= items.some((item) => Boolean(item.translated?.trim()));
			cacheOnly ??= items.every(
				(item) => item.status === "done" && Boolean(item.translated?.trim()),
			);
			const snapshot = {
				cacheKey,
				items,
				revision: ++revision,
				fromCache,
				cacheOnly,
				layoutWarnings,
				layoutPageCount,
			};
			localSnapshots.set(jobId, snapshot);
			for (const listener of listeners) listener(jobId, snapshot);
			pending = snapshot;
			timer ??= setTimeout(() => {
				void flush();
			}, 100);
		},
		flush,
		dispose() {
			if (timer) clearTimeout(timer);
			localSnapshots.delete(jobId);
		},
	};
}

/** Listen before querying/enqueueing, so a fast job cannot finish between them. */
export async function observePaperTranslation(options: {
	vaultPath: string;
	paperPath: string;
	start: boolean;
	force?: boolean;
	forceLayout?: boolean;
	/** Gap-fill from the partial-translation action. Omitted for a full run. */
	purpose?: "complete";
	signal: AbortSignal;
	onUpdate: (job: JobSnapshot, snapshot: TranslationSnapshot | null) => void;
	onJob?: (jobId: string) => void;
}): Promise<{ jobId: string; dispose: () => void } | null> {
	if (!isTauri()) return null;
	let jobId: string | null = null;
	let current: JobSnapshot | null = null;
	const seen = new Map<string, JobSnapshot>();
	const matches = (job: JobSnapshot) =>
		job.kind === "layoutTranslate" &&
		sameRelPaperPath(job.paperPath, options.paperPath) &&
		[job.vaultPath, job.vaultId].some(
			(path) =>
				path && normalizePath(path) === normalizePath(options.vaultPath),
		);
	const accept = (job: JobSnapshot) => {
		if (!matches(job) || options.signal.aborted) return;
		seen.set(job.id, job);
		if (job.id !== jobId) return;
		current = job;
		seen.clear();
		options.onUpdate(job, translationSnapshot(job));
	};
	const localListener = (id: string, snapshot: TranslationSnapshot) => {
		if (current && id === jobId && !options.signal.aborted)
			options.onUpdate(current, snapshot);
	};
	listeners.add(localListener);
	let off: (() => void) | undefined;
	const dispose = () => {
		off?.();
		listeners.delete(localListener);
		options.signal.removeEventListener("abort", dispose);
	};
	options.signal.addEventListener("abort", dispose, { once: true });
	try {
		off = await events.jobChanged.listen(({ payload }) => accept(payload.job));
		if (options.signal.aborted) {
			dispose();
			return null;
		}
		const job = options.start
			? await callApiResult(() =>
					commands.jobLayoutTranslateEnqueue({
						vaultPath: options.vaultPath,
						path: options.paperPath,
						lane: "focus",
						force: options.force ?? false,
						forceLayout: options.forceLayout ?? false,
						purpose: options.purpose ?? null,
					}),
				)
			: (
					await callApiResult(() =>
						commands.jobList({
							vaultPath: options.vaultPath,
							path: options.paperPath,
						}),
					)
				).find(
					(job) =>
						job.kind === "layoutTranslate" &&
						(job.state === "queued" || job.state === "running"),
				);
		if (!job) {
			dispose();
			return null;
		}
		options.onJob?.(job.id);
		if (options.signal.aborted) {
			dispose();
			return null;
		}
		jobId = job.id;
		accept(seen.get(job.id) ?? job);
		return { jobId, dispose };
	} catch (error) {
		dispose();
		throw error;
	}
}
