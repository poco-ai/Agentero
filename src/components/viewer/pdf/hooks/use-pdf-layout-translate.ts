import { type ReflowContext, usePdfReflow } from "./use-pdf-reflow";
/**
 * Bulk (whole-document) translation of body-text layout regions.
 *
 * Its own hook because it shares nothing with hover or with the analysis run
 * beyond the region list it reads: one abortable job, progressive overlay items,
 * and the toolbar button's start → stop → retry/clear flow. When layout regions
 * are missing the job queues (`waitingLayout`) behind the layout-analysis run
 * and auto-starts once regions land.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useStore } from "zustand";
import { backgroundTasksStore } from "@/lib/core/background-tasks";
import { errorText } from "@/lib/core/error";
import {
	notifyAction,
	notifyError,
	notifySuccess,
	notifyWarning,
} from "@/lib/core/notify";
import { sameRelPaperPath } from "@/lib/core/path";
import {
	applyLayoutTranslateSidecar,
	currentLayoutTranslateCacheKey,
	enqueuePaperLayoutAnalysis,
	groupLayoutTranslateItemsByPage,
	hasPendingLayoutTranslateItems,
	type LayoutTranslateItem,
	type LayoutTranslateJobStatus,
	layoutAnalysisStore,
	listTranslatableLayoutRegions,
	normalizeLayoutPaperKey,
	type PdfLayoutRegion,
	persistLayoutTranslateSidecarBestEffort,
	readLayoutTranslateSidecar,
	runLayoutRegionTranslate,
	toLayoutTranslateItems,
} from "@/lib/pdf/layout";
import {
	layoutTranslateDisplayRatio,
	layoutTranslateSettledRatio,
} from "@/lib/pdf/layout/layout-translate-progress";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { displayTranslateError } from "@/lib/translate";

export type UsePdfLayoutTranslateOptions = {
	reflowContext?: ReflowContext;
	docId: string;
	/** Translation-only panes hydrate completed overlays from the shared cache. */
	translationPane?: boolean;
	/** Pre-merge regions from {@link usePdfLayoutRegions}; the translate source. */
	layoutRawRegions: PdfLayoutRegion[] | null;
	/** Paper folder path; when present, full-document translations cache under source/. */
	paperAbsPath?: string | null;
	/** Vault-relative paper path; matches background-task rows to this paper. */
	paperRelPath?: string | null;
	/** Stable paper identifier for per-document Agent session reuse. */
	paperKey?: string | null;
	/** Vault root passed to the Agent as its cwd. */
	vaultPath?: string | null;
};

export type PdfLayoutTranslate = {
	reflowBusy: boolean;
	reflowReady: boolean;
	exportTranslatedPdf: (dual?: boolean) => Promise<void>;
	/** Progressive bulk-translate overlays (body text / abstract / header), bucketed by page. */
	layoutTranslateItemsByPage: ReadonlyMap<
		number,
		readonly LayoutTranslateItem[]
	>;
	/** One-page tag state, keyed by 0-based page index. */
	layoutTranslatePageStateByPage: ReadonlyMap<
		number,
		{ active: boolean; running: boolean }
	>;
	layoutTranslateRunning: boolean;
	/** Final corrected preview/export output is still building after items settled. */
	layoutTranslatePreparing: boolean;
	/** Queued behind layout analysis; toolbar shows the waiting state. */
	layoutTranslateWaiting: boolean;
	/** Running, or finished with overlays still painted. */
	layoutTranslateActive: boolean;
	/** Toolbar button label for the current job phase. */
	layoutTranslateLabel: string;
	/**
	 * Settled blocks ÷ blocks in the job, 0–1.
	 * Null before the job has any blocks (the meter stays indeterminate).
	 */
	layoutTranslateProgress: number | null;
	/** Toolbar button: start → stop → retry incomplete / clear complete. */
	toggleLayoutTranslate: () => void;
	/** Per-page tag: retry incomplete blocks, translate this page, or hide a complete page. */
	togglePageLayoutTranslate: (pageIndex: number) => void;
};

/** What a queued job should start once layout regions land. */
type LayoutTranslateWaitTarget =
	| { mode: "document" }
	| { mode: "page"; pageIndex: number };

function mergeTranslatePageItems(
	items: readonly LayoutTranslateItem[],
	pageIndex: number,
	pageItems: readonly LayoutTranslateItem[],
): LayoutTranslateItem[] {
	return [
		...items.filter((it) => it.pageIndex !== pageIndex),
		...pageItems,
	].sort(
		(a, b) =>
			a.pageIndex - b.pageIndex ||
			a.readingOrder - b.readingOrder ||
			a.bbox.y - b.bbox.y ||
			a.bbox.x - b.bbox.x,
	);
}

/** Keep successful blocks when retrying a partial job, even before cache debounce flushes. */
function reuseCompletedTranslateItems(
	pending: readonly LayoutTranslateItem[],
	current: readonly LayoutTranslateItem[],
): LayoutTranslateItem[] {
	const byId = new Map(current.map((item) => [item.id, item]));
	return pending.map((item) => {
		const previous = byId.get(item.id);
		if (
			previous?.source === item.source &&
			previous.status === "done" &&
			previous.translated?.trim()
		) {
			return {
				...item,
				status: "done" as const,
				translated: previous.translated.trim(),
				error: undefined,
			};
		}
		return { ...item };
	});
}

/** Release interrupted blocks immediately; a cancelled runner may settle much later. */
function resetRunningTranslateItems(
	items: readonly LayoutTranslateItem[],
): LayoutTranslateItem[] {
	return items.map((item) =>
		item.status === "running" ? { ...item, status: "pending" } : item,
	);
}

/** One items state update per frame while batches stream in. */
const LAYOUT_TRANSLATE_PUBLISH_COALESCE_MS = 100;

type CancelScheduled = () => void;
/**
 * Batches settle from network callbacks; publishes landing in the same frame
 * only need one state update. rAF bounds that naturally; setTimeout covers
 * rAF-less runtimes; a synchronous passthrough keeps non-DOM hosts (tests,
 * headless) deterministic. Returning undefined means the run already happened.
 */
const schedulePublishFlush: (run: () => void) => CancelScheduled | undefined =
	typeof requestAnimationFrame === "function"
		? (run) => {
				const id = requestAnimationFrame(run);
				return () => cancelAnimationFrame(id);
			}
		: typeof setTimeout === "function"
			? (run) => {
					const id = setTimeout(run, LAYOUT_TRANSLATE_PUBLISH_COALESCE_MS);
					return () => clearTimeout(id);
				}
			: (run) => {
					run();
					return undefined;
				};

/**
 * Streaming batches settle continuously (bounded concurrency); each one used to
 * replace the whole items state and re-render every mounted page. Coalesce
 * publishes into one state update per window. Trailing edge only: the final
 * job result supersedes, so `cancel()` drops what is still queued.
 */
function createTranslatePublishCoalescer(
	flush: (items: LayoutTranslateItem[]) => void,
): { push: (items: LayoutTranslateItem[]) => void; cancel: () => void } {
	let pending: LayoutTranslateItem[] | null = null;
	let cancelScheduled: CancelScheduled | undefined;
	return {
		push(items) {
			pending = items;
			if (cancelScheduled) return;
			cancelScheduled =
				schedulePublishFlush(() => {
					cancelScheduled = undefined;
					const next = pending;
					pending = null;
					if (next) flush(next);
				}) ?? undefined;
		},
		cancel() {
			cancelScheduled?.();
			cancelScheduled = undefined;
			pending = null;
		},
	};
}

export function usePdfLayoutTranslate({
	reflowContext,
	docId,
	layoutRawRegions,
	translationPane = false,
	paperAbsPath,
	paperRelPath,
	paperKey,
	vaultPath,
}: UsePdfLayoutTranslateOptions): PdfLayoutTranslate {
	const { t } = useTranslation("viewer");
	/** Progressive layout bulk-translate overlays (body text / abstract / header). */
	const [layoutTranslateJob, setLayoutTranslateJob] = useState<{
		status: LayoutTranslateJobStatus;
		items: LayoutTranslateItem[];
	}>({ status: "idle", items: [] });
	const layoutTranslateJobRef = useRef(layoutTranslateJob);
	layoutTranslateJobRef.current = layoutTranslateJob;
	const {
		prepare: prepareReflow,
		reflowItems,
		reflowBusy,
		reflowReady,
		exportTranslatedPdf,
	} = usePdfReflow(
		reflowContext,
		layoutRawRegions,
		layoutTranslateJob.items,
		layoutTranslateJob.status === "running",
		docId,
	);
	const layoutTranslateAbortRef = useRef<AbortController | null>(null);
	const hiddenPageIndexesRef = useRef(new Set<number>());
	/** Queued target to auto-start once layout regions land. */
	const layoutTranslateWaitTargetRef = useRef<LayoutTranslateWaitTarget | null>(
		null,
	);
	const waitingAutoStartedRef = useRef(false);
	const layoutTranslateWaitToastIdRef = useRef(
		`layout-translate-wait:${docId}`,
	);
	layoutTranslateWaitToastIdRef.current = `layout-translate-wait:${docId}`;

	// Is a layout analysis queued/running for this paper? Task rows are the only
	// signal covering host-job queueing and headless runs (synthetic docIds);
	// the store UI covers row-less in-viewer runs via the real documentId.
	const layoutJobPending = useStore(backgroundTasksStore, (s) =>
		s.tasks.some(
			(task) =>
				(task.kind === "layoutAnalyze" || task.kind === "layoutRun") &&
				(task.status === "queued" || task.status === "running") &&
				sameRelPaperPath(task.paperPath, paperRelPath),
		),
	);
	const layoutUiRunning = useStore(layoutAnalysisStore, (s) => {
		if (s.ui.stage !== "running") return false;
		if (s.activeDocumentId === docId) return true;
		const activePaper = s.activePaperAbsPath;
		return (
			activePaper != null &&
			paperAbsPath != null &&
			normalizeLayoutPaperKey(activePaper) ===
				normalizeLayoutPaperKey(paperAbsPath)
		);
	});
	const parsePendingForPaper = layoutJobPending || layoutUiRunning;

	const applyHiddenPages = useCallback(
		(items: readonly LayoutTranslateItem[]) => {
			const hidden = hiddenPageIndexesRef.current;
			if (hidden.size === 0) return items.map((it) => ({ ...it }));
			return items
				.filter((it) => !hidden.has(it.pageIndex))
				.map((it) => ({ ...it }));
		},
		[],
	);

	const stopLayoutTranslate = useCallback(() => {
		layoutTranslateAbortRef.current?.abort();
		layoutTranslateAbortRef.current = null;
		setLayoutTranslateJob((prev) =>
			prev.status === "running"
				? {
						...prev,
						status: "cancelled",
						items: resetRunningTranslateItems(prev.items),
					}
				: prev,
		);
	}, []);

	const clearLayoutTranslate = useCallback(() => {
		layoutTranslateAbortRef.current?.abort();
		layoutTranslateAbortRef.current = null;
		hiddenPageIndexesRef.current.clear();
		setLayoutTranslateJob({ status: "idle", items: [] });
	}, []);

	// `runLayoutRegionTranslate` settles per-chain errors into item state instead
	// of throwing, so a dead translation API would otherwise finish silently.
	const notifyTranslateFailure = useCallback(
		(description: string) => {
			notifyError(t("pdf.layoutTranslate.failed"), {
				description,
				action: {
					label: t("pdf.layoutTranslate.openSettings"),
					onClick: () => openSettingsWindow("translate"),
				},
			});
		},
		[t],
	);

	const notifyTranslateItemErrors = useCallback(
		(items: readonly LayoutTranslateItem[]) => {
			const failed = items.find((it) => it.status === "error" && it.error);
			if (!failed) return;
			notifyTranslateFailure(displayTranslateError(failed.error ?? ""));
		},
		[notifyTranslateFailure],
	);

	const cancelWaitingLayout = useCallback(() => {
		layoutTranslateWaitTargetRef.current = null;
		waitingAutoStartedRef.current = false;
		toast.dismiss(layoutTranslateWaitToastIdRef.current);
		setLayoutTranslateJob((prev) =>
			prev.status === "waitingLayout"
				? { status: "idle", items: prev.items }
				: prev,
		);
	}, []);

	/**
	 * Queue the job behind layout analysis: ensure a parse is pending, park the
	 * target, and let the auto-start effect fire once regions land. Items are
	 * kept so a later start reuses completed blocks.
	 */
	const enterWaitingLayout = useCallback(
		(target: LayoutTranslateWaitTarget) => {
			if (!parsePendingForPaper) {
				if (!paperAbsPath) {
					// Loose PDF with nothing to enqueue and nothing running.
					notifyError(t("pdf.layoutTranslate.needLayout"));
					return;
				}
				enqueuePaperLayoutAnalysis({ paperAbsPath });
			}
			layoutTranslateWaitTargetRef.current = target;
			waitingAutoStartedRef.current = false;
			setLayoutTranslateJob((prev) => ({
				status: "waitingLayout",
				items: prev.items,
			}));
			notifyAction(t("pdf.layoutTranslate.queuedToast"), {
				id: layoutTranslateWaitToastIdRef.current,
				actionLabel: t("pdf.layoutTranslate.cancelQueue"),
				onAction: cancelWaitingLayout,
				duration: 12000,
			});
		},
		[parsePendingForPaper, paperAbsPath, cancelWaitingLayout, t],
	);

	const startLayoutTranslate = useCallback(() => {
		const raw = layoutRawRegions;
		if (!raw?.length) {
			enterWaitingLayout({ mode: "document" });
			return;
		}
		const regions = listTranslatableLayoutRegions(raw);
		if (regions.length === 0) {
			notifyError(t("pdf.layoutTranslate.noText"));
			return;
		}
		layoutTranslateAbortRef.current?.abort();
		const ac = new AbortController();
		layoutTranslateAbortRef.current = ac;
		hiddenPageIndexesRef.current.clear();
		const cacheKey = currentLayoutTranslateCacheKey();
		const pendingItems = reuseCompletedTranslateItems(
			toLayoutTranslateItems(regions),
			layoutTranslateJobRef.current.items,
		);
		setLayoutTranslateJob({ status: "running", items: pendingItems });
		const publishes = createTranslatePublishCoalescer((next) => {
			if (ac.signal.aborted) return;
			persistLayoutTranslateSidecarBestEffort(paperAbsPath, cacheKey, next);
			setLayoutTranslateJob((prev) => ({
				status: prev.status === "cancelled" ? "cancelled" : "running",
				items: applyHiddenPages(next),
			}));
		});
		void (async () => {
			const sidecar = await readLayoutTranslateSidecar(paperAbsPath, cacheKey);
			if (ac.signal.aborted) return;
			const prepared = await prepareReflow(pendingItems, ac.signal);
			if (ac.signal.aborted) return;
			const items = applyLayoutTranslateSidecar(prepared, sidecar);
			const needsRun = hasPendingLayoutTranslateItems(items);
			setLayoutTranslateJob({
				status: needsRun ? "running" : "done",
				items,
			});
			if (!needsRun) return;
			const finalItems = await runLayoutRegionTranslate({
				items,
				signal: ac.signal,
				paperKey,
				vaultPath,
				onUpdate: (next) => {
					if (ac.signal.aborted) return;
					publishes.push(next);
				},
			});
			// Cancellation/replacement owns the visible state now. A late result
			// must not restore cleared overlays or overwrite a newer sidecar write.
			if (ac.signal.aborted || layoutTranslateAbortRef.current !== ac) return;
			persistLayoutTranslateSidecarBestEffort(
				paperAbsPath,
				cacheKey,
				finalItems,
			);
			notifyTranslateItemErrors(finalItems);
			setLayoutTranslateJob({
				status: hasPendingLayoutTranslateItems(finalItems) ? "partial" : "done",
				items: applyHiddenPages(finalItems),
			});
		})()
			.catch((e) => {
				if (ac.signal.aborted) return;
				const message = displayTranslateError(errorText(e));
				notifyTranslateFailure(message);
				setLayoutTranslateJob((prev) => ({
					status: "partial",
					items: prev.items,
				}));
			})
			.finally(() => {
				publishes.cancel();
				if (layoutTranslateAbortRef.current === ac) {
					layoutTranslateAbortRef.current = null;
				}
			});
	}, [
		layoutRawRegions,
		paperAbsPath,
		paperKey,
		vaultPath,
		applyHiddenPages,
		enterWaitingLayout,
		prepareReflow,
		notifyTranslateItemErrors,
		notifyTranslateFailure,
		t,
	]);

	const startPageLayoutTranslate = useCallback(
		(pageIndex: number) => {
			const raw = layoutRawRegions;
			if (!raw?.length) {
				enterWaitingLayout({ mode: "page", pageIndex });
				return;
			}
			const regions = listTranslatableLayoutRegions(raw).filter(
				(region) => region.pageIndex === pageIndex,
			);
			if (regions.length === 0) {
				notifyError(t("pdf.layoutTranslate.noText"));
				return;
			}
			layoutTranslateAbortRef.current?.abort();
			const ac = new AbortController();
			layoutTranslateAbortRef.current = ac;
			hiddenPageIndexesRef.current.delete(pageIndex);
			const cacheKey = currentLayoutTranslateCacheKey();
			const pendingItems = reuseCompletedTranslateItems(
				toLayoutTranslateItems(regions),
				layoutTranslateJobRef.current.items.filter(
					(item) => item.pageIndex === pageIndex,
				),
			);
			setLayoutTranslateJob((prev) => ({
				status: "running",
				items: mergeTranslatePageItems(
					resetRunningTranslateItems(prev.items),
					pageIndex,
					pendingItems,
				),
			}));
			const publishes = createTranslatePublishCoalescer((next) => {
				if (ac.signal.aborted) return;
				persistLayoutTranslateSidecarBestEffort(paperAbsPath, cacheKey, next, {
					preserveExisting: true,
					replacePageIndexes: [pageIndex],
				});
				setLayoutTranslateJob((prev) => ({
					status: prev.status === "cancelled" ? "cancelled" : "running",
					items: applyHiddenPages(
						mergeTranslatePageItems(prev.items, pageIndex, next),
					),
				}));
			});
			void (async () => {
				const sidecar = await readLayoutTranslateSidecar(
					paperAbsPath,
					cacheKey,
				);
				if (ac.signal.aborted) return;
				const prepared = await prepareReflow(pendingItems, ac.signal);
				if (ac.signal.aborted) return;
				const pageItems = applyLayoutTranslateSidecar(prepared, sidecar);
				const needsRun = hasPendingLayoutTranslateItems(pageItems);
				setLayoutTranslateJob((prev) => {
					const merged = mergeTranslatePageItems(
						prev.items,
						pageIndex,
						pageItems,
					);
					return {
						status: needsRun
							? "running"
							: hasPendingLayoutTranslateItems(merged)
								? "partial"
								: "done",
						items: merged,
					};
				});
				if (!needsRun) return;
				const finalPageItems = await runLayoutRegionTranslate({
					items: pageItems,
					signal: ac.signal,
					paperKey,
					vaultPath,
					onUpdate: (next) => {
						if (ac.signal.aborted) return;
						publishes.push(next);
					},
				});
				// Only the current live run may publish or persist its final result.
				if (ac.signal.aborted || layoutTranslateAbortRef.current !== ac) return;
				persistLayoutTranslateSidecarBestEffort(
					paperAbsPath,
					cacheKey,
					finalPageItems,
					{
						preserveExisting: true,
						replacePageIndexes: [pageIndex],
					},
				);
				notifyTranslateItemErrors(finalPageItems);
				setLayoutTranslateJob((prev) => {
					const merged = mergeTranslatePageItems(
						prev.items,
						pageIndex,
						finalPageItems,
					);
					return {
						status: hasPendingLayoutTranslateItems(merged) ? "partial" : "done",
						items: applyHiddenPages(merged),
					};
				});
			})()
				.catch((e) => {
					if (ac.signal.aborted) return;
					const message = displayTranslateError(errorText(e));
					notifyTranslateFailure(message);
					setLayoutTranslateJob((prev) => ({
						status: "partial",
						items: prev.items,
					}));
				})
				.finally(() => {
					publishes.cancel();
					if (layoutTranslateAbortRef.current === ac) {
						layoutTranslateAbortRef.current = null;
					}
				});
		},
		[
			layoutRawRegions,
			paperAbsPath,
			paperKey,
			vaultPath,
			applyHiddenPages,
			enterWaitingLayout,
			prepareReflow,
			notifyTranslateItemErrors,
			notifyTranslateFailure,
			t,
		],
	);

	const togglePageLayoutTranslate = useCallback(
		(pageIndex: number) => {
			// Waiting re-click cancels the queue instead of re-queueing.
			if (layoutTranslateJobRef.current.status === "waitingLayout") {
				cancelWaitingLayout();
				return;
			}
			const pageItems = layoutTranslateJobRef.current.items.filter(
				(item) => item.pageIndex === pageIndex,
			);
			if (pageItems.some((item) => item.status === "running")) {
				stopLayoutTranslate();
				return;
			}
			if (pageItems.length > 0 && hasPendingLayoutTranslateItems(pageItems)) {
				startPageLayoutTranslate(pageIndex);
				return;
			}
			const pageActive = pageItems.some((item) => item.translated?.trim());
			if (pageActive) {
				hiddenPageIndexesRef.current.add(pageIndex);
				setLayoutTranslateJob((prev) => ({
					...prev,
					items: prev.items.filter((item) => item.pageIndex !== pageIndex),
				}));
				return;
			}
			startPageLayoutTranslate(pageIndex);
		},
		[startPageLayoutTranslate, stopLayoutTranslate, cancelWaitingLayout],
	);

	const toggleLayoutTranslate = useCallback(() => {
		if (layoutTranslateJob.status === "waitingLayout") {
			cancelWaitingLayout();
			return;
		}
		if (layoutTranslateJob.status === "running") {
			stopLayoutTranslate();
			return;
		}
		if (layoutTranslateJob.status === "partial") {
			startLayoutTranslate();
			return;
		}
		if (
			layoutTranslateJob.status === "done" ||
			layoutTranslateJob.status === "cancelled"
		) {
			// Complete/explicitly-cancelled overlays keep the original clear action.
			if (layoutTranslateJob.items.some((it) => it.translated)) {
				clearLayoutTranslate();
				return;
			}
		}
		startLayoutTranslate();
	}, [
		layoutTranslateJob,
		startLayoutTranslate,
		stopLayoutTranslate,
		clearLayoutTranslate,
		cancelWaitingLayout,
	]);

	// Abort bulk translate when switching documents.
	useEffect(() => {
		if (!docId) return;
		layoutTranslateAbortRef.current?.abort();
		layoutTranslateAbortRef.current = null;
		hiddenPageIndexesRef.current.clear();
		layoutTranslateWaitTargetRef.current = null;
		waitingAutoStartedRef.current = false;
		setLayoutTranslateJob({ status: "idle", items: [] });
		return () => {
			layoutTranslateAbortRef.current?.abort();
		};
	}, [docId]);

	// A queued job starts the moment layout regions land (parse finished —
	// possibly in another tab via the sidecar file watcher).
	useEffect(() => {
		if (layoutTranslateJob.status !== "waitingLayout") return;
		if (!layoutRawRegions?.length) return;
		if (waitingAutoStartedRef.current) return;
		waitingAutoStartedRef.current = true;
		notifySuccess(t("pdf.layoutTranslate.startedAfterLayout"), {
			id: layoutTranslateWaitToastIdRef.current,
		});
		const target = layoutTranslateWaitTargetRef.current;
		layoutTranslateWaitTargetRef.current = null;
		if (target?.mode === "page") startPageLayoutTranslate(target.pageIndex);
		else startLayoutTranslate();
	}, [
		layoutTranslateJob.status,
		layoutRawRegions,
		startLayoutTranslate,
		startPageLayoutTranslate,
		t,
	]);

	// Edge-triggered parse-failure watch while queued: only tasks observed
	// queued/running during the wait may cancel it — finished rows linger in the
	// panel store, so a level check would trip on a stale earlier failure.
	useEffect(() => {
		if (layoutTranslateJob.status !== "waitingLayout") return;
		const fail = () => {
			notifyWarning(t("pdf.layoutTranslate.parseFailedWhileWaiting"), {
				id: layoutTranslateWaitToastIdRef.current,
			});
			cancelWaitingLayout();
		};
		const tracked = new Set<string>();
		const scanTasks = () => {
			for (const task of backgroundTasksStore.getState().tasks) {
				if (task.kind !== "layoutAnalyze" && task.kind !== "layoutRun")
					continue;
				if (!sameRelPaperPath(task.paperPath, paperRelPath)) continue;
				if (task.status === "queued" || task.status === "running") {
					tracked.add(task.id);
					continue;
				}
				if (
					tracked.has(task.id) &&
					(task.status === "failed" || task.status === "cancelled")
				) {
					fail();
					return;
				}
			}
		};
		const unsubTasks = backgroundTasksStore.subscribe(scanTasks);
		const unsubUi = layoutAnalysisStore.subscribe((s) => {
			if (s.activeDocumentId !== docId) return;
			if (s.ui.stage === "error" || s.ui.stage === "cancelled") fail();
		});
		scanTasks();
		return () => {
			unsubTasks();
			unsubUi();
		};
	}, [layoutTranslateJob.status, docId, paperRelPath, cancelWaitingLayout, t]);

	// A translation pane must show the source pane's completed cache immediately;
	// it should not depend on starting a second translation job or on the source
	// pane's local React state.
	useEffect(() => {
		if (!translationPane || !paperAbsPath) return;
		let cancelled = false;
		void readLayoutTranslateSidecar(
			paperAbsPath,
			currentLayoutTranslateCacheKey(),
		)
			.then(async (sidecar) => {
				if (cancelled || !sidecar?.items.length) return;
				const seed = layoutRawRegions?.length
					? toLayoutTranslateItems(
							listTranslatableLayoutRegions(layoutRawRegions),
						)
					: sidecar.items.map((item) => ({ ...item, status: "done" as const }));
				const items = applyLayoutTranslateSidecar(
					await prepareReflow(seed),
					sidecar,
				);

				if (!cancelled) setLayoutTranslateJob({ status: "done", items });
			})
			.catch((error) => {
				if (!cancelled)
					notifyError(t("pdf.layoutTranslate.reflowFailed"), {
						description: errorText(error),
					});
			});
		return () => {
			cancelled = true;
		};
	}, [translationPane, paperAbsPath, layoutRawRegions, prepareReflow, t]);

	// Bucket once per job update (not per page); unchanged buckets keep their
	// previous array identity so memoized page overlays bail out while another
	// page streams.
	const layoutTranslateByPageRef = useRef<
		ReadonlyMap<number, readonly LayoutTranslateItem[]>
	>(new Map());
	const layoutTranslateItemsByPage = useMemo(() => {
		const grouped = groupLayoutTranslateItemsByPage(
			reflowItems,
			layoutTranslateByPageRef.current,
		);
		layoutTranslateByPageRef.current = grouped;
		return grouped;
	}, [reflowItems]);

	const layoutTranslatePageStateByPage = useMemo(() => {
		const states = new Map<number, { active: boolean; running: boolean }>();
		for (const item of layoutTranslateJob.items) {
			const state = states.get(item.pageIndex) ?? {
				active: false,
				running: false,
			};
			if (item.status === "running") {
				state.active = true;
				state.running = true;
			}
			if (item.translated?.trim()) {
				state.active = true;
			}
			states.set(item.pageIndex, state);
		}
		return states;
	}, [layoutTranslateJob.items]);

	const layoutTranslateRunning = layoutTranslateJob.status === "running";
	const textSettled = useMemo(
		() => layoutTranslateSettledRatio(layoutTranslateJob.items),
		[layoutTranslateJob.items],
	);
	const hasTranslatedText = layoutTranslateJob.items.some(
		(item) => item.status === "done" && Boolean(item.translated?.trim()),
	);
	// `reflowReady` stays false for the whole run, and also for the paint
	// before the final build flips `reflowBusy`. Hold the meter across that
	// paint so the rim does not unmount, freeze, and start over.
	const previewPending =
		hasTranslatedText &&
		!reflowReady &&
		(layoutTranslateRunning ||
			layoutTranslateJob.status === "done" ||
			layoutTranslateJob.status === "partial");
	const sawFinalReflowBusyRef = useRef(false);
	if (layoutTranslateRunning || !previewPending) {
		sawFinalReflowBusyRef.current = false;
	} else if (reflowBusy) {
		sawFinalReflowBusyRef.current = true;
	}
	const finalReflowFailed =
		!layoutTranslateRunning &&
		previewPending &&
		sawFinalReflowBusyRef.current &&
		!reflowBusy;
	const layoutTranslateProgress = layoutTranslateDisplayRatio(
		textSettled,
		previewPending && !finalReflowFailed,
	);
	// Cached re-runs settle almost immediately, but the translated page only
	// paints once the final reflow build publishes its previews. Keep the
	// loading indicator up through that build instead of leaving a blank wait.
	const layoutTranslatePreparing =
		previewPending && !layoutTranslateRunning && !finalReflowFailed;
	const layoutTranslateWaiting = layoutTranslateJob.status === "waitingLayout";
	const layoutTranslateActive =
		layoutTranslateRunning ||
		layoutTranslateJob.items.some((it) => it.translated);
	const layoutTranslateLabel = layoutTranslateWaiting
		? t("pdf.layoutTranslate.waiting")
		: layoutTranslateRunning
			? t("pdf.layoutTranslate.stop")
			: layoutTranslateJob.status === "partial"
				? t("pdf.layoutTranslate.start")
				: layoutTranslateActive
					? t("pdf.layoutTranslate.clear")
					: t("pdf.layoutTranslate.start");

	return {
		reflowBusy,
		reflowReady,
		exportTranslatedPdf,
		layoutTranslateItemsByPage,
		layoutTranslatePageStateByPage,
		layoutTranslateRunning,
		layoutTranslatePreparing,
		layoutTranslateWaiting,
		layoutTranslateActive,
		layoutTranslateLabel,
		layoutTranslateProgress,
		toggleLayoutTranslate,
		togglePageLayoutTranslate,
	};
}
