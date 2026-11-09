import { type ReflowContext, usePdfReflow } from "./use-pdf-reflow";
/**
 * Bulk (whole-document) translation of body-text layout regions.
 *
 * Its own hook because it shares nothing with hover or with the analysis run
 * beyond the region list it reads: one abortable job, progressive overlay items,
 * and the toolbar button's start → stop → retry/hide/show flow. When layout regions
 * are missing the job queues (`waitingLayout`) behind the layout-analysis run
 * and auto-starts once regions land.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useStore } from "zustand";
import { backgroundTasksStore } from "@/lib/core/background-tasks";
import { errorText } from "@/lib/core/error";
import { notifyError, notifyWarning } from "@/lib/core/notify";
import { sameRelPaperPath } from "@/lib/core/path";
import {
	applyLayoutTranslateSidecar,
	buildLayoutDocumentResult,
	countPendingLayoutTranslateItems,
	currentLayoutTranslateCacheKey,
	enqueuePaperLayoutAnalysis,
	groupLayoutTranslateItemsByPage,
	hasPendingLayoutTranslateItems,
	hydrateLayoutTranslateItems,
	type LayoutTranslateCacheKey,
	type LayoutTranslateItem,
	type LayoutTranslateJobStatus,
	type LayoutTranslateRunScope,
	layoutAnalysisStore,
	layoutTranslatePendingPageRange,
	listTranslatableLayoutRegions,
	mergeCaptionsIntoHosts,
	normalizeLayoutPaperKey,
	type PdfLayoutRegion,
	persistLayoutTranslateSidecarBestEffort,
	readLayoutSidecar,
	readLayoutTranslateSidecar,
	runLayoutRegionTranslate,
	setLayoutDocumentResult,
	toLayoutTranslateItems,
} from "@/lib/pdf/layout";
import {
	layoutSidecarNeedsTextLayer,
	subscribeLayoutSidecarWrite,
} from "@/lib/pdf/layout/io";
import {
	layoutTranslateDisplayRatio,
	layoutTranslateSettledRatio,
} from "@/lib/pdf/layout/layout-translate-progress";
import {
	clearTranslationPartialDismissal,
	dismissTranslationPartial,
	isTranslationPartialDismissed,
	translationPartialDismissalKey,
} from "@/lib/pdf/translation-partial-dismissal";
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
	/** Viewer PDF bytes; hashed into the reflow IR cache key. */
	pdfBytes?: ArrayBuffer | null;
};

/** View model for the partial-translation button and its anchored dialog. */
export type PdfLayoutTranslatePartial = {
	pendingRequired: number;
	translatedCount: number;
	totalCount: number;
	/** 1-based inclusive page span of the untranslated blocks. */
	pageRange: { start: number; end: number } | null;
	/** The trigger is rendered only while true (no translation run in flight). */
	visible: boolean;
	open: boolean;
	/** A completion / retranslate attempt already ran and gaps remain. */
	completionFailed: boolean;
	onOpenChange: (open: boolean) => void;
	onCompleteMissing: () => void;
	onRetranslateAll: () => void;
	onDismiss: () => void;
};

export type PdfLayoutTranslate = {
	reflowBusy: boolean;
	reflowReady: boolean;
	/** Finished translated PDF bytes for the in-app display renderer. */
	reflowOutput: Uint8Array | null;
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
	/** Blocks with no translated text; drives the partial-translation entry. */
	layoutTranslatePendingRequired: number;
	/** At least one job block already had a translation when the job started. */
	layoutTranslateFromCache: boolean;
	/** Job phase, including `partial` after a cache hydrate or interrupted run. */
	layoutTranslateStatus: LayoutTranslateJobStatus;
	/** Partial-translation entry; render the button only when `visible`. */
	layoutTranslatePartial: PdfLayoutTranslatePartial;
	/**
	 * Settled blocks ÷ blocks in the job, 0–1.
	 * Null before the job has any blocks (the meter stays indeterminate).
	 */
	layoutTranslateProgress: number | null;
	/** Toolbar button: start → stop → retry incomplete / hide or show retained translations. */
	toggleLayoutTranslate: () => void;
	/** Per-page tag: retry incomplete blocks, translate this page, or hide a complete page. */
	togglePageLayoutTranslate: (pageIndex: number) => void;
};

/** What a queued job should start once layout regions land. */
type LayoutTranslateWaitTarget =
	| { mode: "document" }
	| { mode: "page"; pageIndex: number };

/**
 * One bulk-translate job. `runScopeIds` is the block set the meter measures:
 * a pending-completion run must not start from the whole-document ratio.
 */
type LayoutTranslateJobState = {
	status: LayoutTranslateJobStatus;
	items: LayoutTranslateItem[];
	/** True when the job started from (or reused) already translated blocks. */
	fromCache: boolean;
	runScope: LayoutTranslateRunScope;
	runScopeIds: readonly string[];
	/** Cache identity backing `items`; keys the UI-only dismissal state. */
	cacheKey: LayoutTranslateCacheKey | null;
	/** Identity of the current gap set; null when nothing is pending. */
	partialDismissKey: string | null;
	/** A completion / retranslate ran and some blocks still have no translation. */
	partialCompletionFailed: boolean;
};

const EMPTY_LAYOUT_TRANSLATE_JOB: LayoutTranslateJobState = {
	status: "idle",
	items: [],
	fromCache: false,
	runScope: "initial",
	runScopeIds: [],
	cacheKey: null,
	partialDismissKey: null,
	partialCompletionFailed: false,
};

function layoutTranslateJobPatch(
	patch: Partial<LayoutTranslateJobState>,
): LayoutTranslateJobState {
	return { ...EMPTY_LAYOUT_TRANSLATE_JOB, ...patch };
}

/** Dismissal identity for the untranslated subset of `items`. */
function layoutTranslatePendingDismissKey(
	paperKey: string,
	cacheKey: LayoutTranslateCacheKey | null,
	items: readonly LayoutTranslateItem[],
): string | null {
	return translationPartialDismissalKey({
		paperKey,
		cacheKey,
		pendingItems: items.filter((item) => !item.translated?.trim()),
	});
}

/** Run ids for the meter: the whole block list unless the run only fills gaps. */
function layoutTranslateScopeIds(
	items: readonly LayoutTranslateItem[],
	onlyPending: boolean,
): string[] {
	return items
		.filter((item) => !onlyPending || !item.translated?.trim())
		.map((item) => item.id);
}

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

type TranslatedSnapshot = {
	translated: string;
	sentences?: LayoutTranslateItem["sentences"];
};

/** Remember successful translations before a run that may clear them. */
function snapshotTranslatedItems(
	items: readonly LayoutTranslateItem[],
): Map<string, TranslatedSnapshot> {
	const snapshot = new Map<string, TranslatedSnapshot>();
	for (const item of items) {
		if (!item.translated?.trim()) continue;
		snapshot.set(item.id, {
			translated: item.translated,
			sentences: item.sentences,
		});
	}
	return snapshot;
}

/**
 * A failed batch clears the block's translation. Put the pre-run translation
 * back so retranslate failures never erase an existing cache.
 */
function restoreTranslatedItems(
	items: readonly LayoutTranslateItem[],
	snapshot: ReadonlyMap<string, TranslatedSnapshot>,
): LayoutTranslateItem[] {
	if (snapshot.size === 0) return items.map((item) => ({ ...item }));
	return items.map((item) => {
		if (item.translated?.trim()) return { ...item };
		const previous = snapshot.get(item.id);
		if (!previous) return { ...item };
		return {
			...item,
			status: "done" as const,
			translated: previous.translated,
			sentences: previous.sentences,
			error: undefined,
		};
	});
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
	pdfBytes,
}: UsePdfLayoutTranslateOptions): PdfLayoutTranslate {
	const { t } = useTranslation("viewer");
	/** Progressive layout bulk-translate overlays (body text / abstract / header). */
	const [sourcePreparing, setSourcePreparing] = useState(false);
	const [cacheOnly, setCacheOnly] = useState(false);
	const [layoutTranslateJob, setLayoutTranslateJob] =
		useState<LayoutTranslateJobState>(EMPTY_LAYOUT_TRANSLATE_JOB);
	const layoutTranslateJobRef = useRef(layoutTranslateJob);
	layoutTranslateJobRef.current = layoutTranslateJob;
	const [partialDialogOpen, setPartialDialogOpen] = useState(false);
	/** Gap identity that already got its one automatic open this session. */
	const partialAutoOpenedKeyRef = useRef<string | null>(null);
	/** Stable paper identity for the machine-local dismissal records. */
	const dismissalPaperKey = paperAbsPath ?? paperRelPath ?? docId;
	// Visibility must not discard the translation or invalidate its reflow preview.
	const [hiddenPageIndexes, setHiddenPageIndexes] = useState<
		ReadonlySet<number>
	>(new Set());
	const {
		prepare: prepareReflow,
		reflowItems,
		reflowBusy,
		reflowReady,
		reflowOutput,
		reflowProgress,
		exportTranslatedPdf,
	} = usePdfReflow(
		reflowContext,
		layoutRawRegions,
		layoutTranslateJob.items,
		layoutTranslateJob.status === "running",
		docId,
		paperAbsPath,
		paperKey,
		pdfBytes,
	);
	const layoutTranslateAbortRef = useRef<AbortController | null>(null);
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

	const stopLayoutTranslate = useCallback(() => {
		layoutTranslateAbortRef.current?.abort();
		layoutTranslateAbortRef.current = null;
		setSourcePreparing(false);
		setPartialDialogOpen(false);
		setLayoutTranslateJob((prev) => {
			if (prev.status !== "running") return prev;
			const items = resetRunningTranslateItems(prev.items);
			return {
				...prev,
				status: "cancelled",
				items,
				partialDismissKey: layoutTranslatePendingDismissKey(
					dismissalPaperKey,
					prev.cacheKey,
					items,
				),
				partialCompletionFailed: false,
			};
		});
	}, [dismissalPaperKey]);

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
			prev.status === "waitingLayout" ? { ...prev, status: "idle" } : prev,
		);
	}, []);

	/**
	 * Queue the job behind layout analysis: ensure a parse is pending, park the
	 * target, and let the auto-start effect fire once regions land. Items are
	 * kept so a later start reuses completed blocks.
	 */
	const enterWaitingLayout = useCallback(
		(target: LayoutTranslateWaitTarget) => {
			layoutTranslateWaitTargetRef.current = target;
			if (paperAbsPath) {
				enqueuePaperLayoutAnalysis({
					paperAbsPath,
					focus: true,
					onError: (error) => {
						if (layoutTranslateWaitTargetRef.current !== target) return;
						cancelWaitingLayout();
						notifyTranslateFailure(displayTranslateError(errorText(error)));
					},
				});
			} else if (!parsePendingForPaper) {
				// Loose PDF with nothing to enqueue and nothing running.
				notifyError(t("pdf.layoutTranslate.needLayout"));
				return;
			}
			waitingAutoStartedRef.current = false;
			setLayoutTranslateJob((prev) => ({
				...prev,
				status: "waitingLayout",
			}));
		},
		[
			parsePendingForPaper,
			paperAbsPath,
			cancelWaitingLayout,
			notifyTranslateFailure,
			t,
		],
	);

	/**
	 * Ask for at most one automatic popover per gap set. Dismissed sets stay
	 * silent across sessions; a changed gap set has a new key and asks again.
	 */
	const schedulePartialAutoOpen = useCallback((dismissKey: string | null) => {
		if (!dismissKey) return;
		if (partialAutoOpenedKeyRef.current === dismissKey) return;
		partialAutoOpenedKeyRef.current = dismissKey;
		if (isTranslationPartialDismissed(dismissKey)) return;
		setPartialDialogOpen(true);
	}, []);

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
		setSourcePreparing(true);
		setHiddenPageIndexes(new Set());
		const cacheKey = currentLayoutTranslateCacheKey();
		const pendingItems = reuseCompletedTranslateItems(
			toLayoutTranslateItems(regions),
			layoutTranslateJobRef.current.items,
		);
		const seedScopeIds = layoutTranslateScopeIds(pendingItems, true);
		setLayoutTranslateJob(
			layoutTranslateJobPatch({
				status: "running",
				items: pendingItems,
				fromCache: false,
				runScope: "initial",
				runScopeIds: seedScopeIds,
				cacheKey,
			}),
		);
		const publishes = createTranslatePublishCoalescer((next) => {
			if (ac.signal.aborted) return;
			persistLayoutTranslateSidecarBestEffort(paperAbsPath, cacheKey, next);
			setLayoutTranslateJob((prev) => ({
				...prev,
				status: prev.status === "cancelled" ? "cancelled" : "running",
				items: next,
			}));
		});
		void (async () => {
			const sidecar = await readLayoutTranslateSidecar(paperAbsPath, cacheKey);
			if (ac.signal.aborted) return;
			const prepared = await prepareReflow(pendingItems, ac.signal);
			if (ac.signal.aborted) return;
			setSourcePreparing(false);
			// Cache-first: render every hydrated block, then translate only when
			// the sidecar had nothing usable. A cache with gaps stays partial.
			const hydration = hydrateLayoutTranslateItems(prepared, sidecar, {
				requireReflowSentencePairs: true,
			});
			const needsRun = !hydration.fromCache;
			const dismissKey = layoutTranslatePendingDismissKey(
				dismissalPaperKey,
				cacheKey,
				hydration.items,
			);
			setCacheOnly(!needsRun);
			setLayoutTranslateJob({
				status: needsRun
					? "running"
					: hydration.pendingRequired > 0
						? "partial"
						: "done",
				items: hydration.items,
				fromCache: hydration.fromCache,
				runScope: "initial",
				runScopeIds: layoutTranslateScopeIds(
					hydration.items,
					hydration.pendingRequired > 0,
				),
				cacheKey,
				partialDismissKey: dismissKey,
				partialCompletionFailed: false,
			});
			if (!needsRun) {
				// Cache-first renders a partial page without asking the user yet;
				// the popover opens once the page build finishes and the button can
				// anchor it. The build itself is never blocked.
				if (hydration.pendingRequired > 0) schedulePartialAutoOpen(dismissKey);
				return;
			}
			const finalItems = await runLayoutRegionTranslate({
				items: hydration.items,
				signal: ac.signal,
				paperKey,
				vaultPath,
				onUpdate: (next) => {
					if (ac.signal.aborted) return;
					publishes.push(next);
				},
			});
			// Cancellation/replacement owns the visible state now. A late result
			// must not restore hidden overlays or overwrite a newer sidecar write.
			if (ac.signal.aborted || layoutTranslateAbortRef.current !== ac) return;
			persistLayoutTranslateSidecarBestEffort(
				paperAbsPath,
				cacheKey,
				finalItems,
			);
			notifyTranslateItemErrors(finalItems);
			const pendingKey = layoutTranslatePendingDismissKey(
				dismissalPaperKey,
				cacheKey,
				finalItems,
			);
			setLayoutTranslateJob((prev) => ({
				...prev,
				status: hasPendingLayoutTranslateItems(finalItems) ? "partial" : "done",
				items: finalItems,
				partialDismissKey: pendingKey,
				partialCompletionFailed: false,
			}));
		})()
			.catch((e) => {
				if (ac.signal.aborted) return;
				const message = displayTranslateError(errorText(e));
				notifyTranslateFailure(message);
				setLayoutTranslateJob((prev) => ({
					...prev,
					status: "partial",
				}));
			})
			.finally(() => {
				publishes.cancel();
				if (layoutTranslateAbortRef.current === ac) {
					if (!ac.signal.aborted) setSourcePreparing(false);
					layoutTranslateAbortRef.current = null;
				}
			});
	}, [
		layoutRawRegions,
		paperAbsPath,
		paperKey,
		vaultPath,
		dismissalPaperKey,
		enterWaitingLayout,
		prepareReflow,
		notifyTranslateItemErrors,
		notifyTranslateFailure,
		schedulePartialAutoOpen,
		t,
	]);
	/** Cache-miss fallback from the translation pane's hydrate effect. */
	const startLayoutTranslateRef = useRef(startLayoutTranslate);
	startLayoutTranslateRef.current = startLayoutTranslate;

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
			setSourcePreparing(true);
			setHiddenPageIndexes((hidden) => {
				if (!hidden.has(pageIndex)) return hidden;
				const next = new Set(hidden);
				next.delete(pageIndex);
				return next;
			});
			const cacheKey = currentLayoutTranslateCacheKey();
			const pendingItems = reuseCompletedTranslateItems(
				toLayoutTranslateItems(regions),
				layoutTranslateJobRef.current.items.filter(
					(item) => item.pageIndex === pageIndex,
				),
			);
			// A page run keeps measuring the whole visible job, as before.
			setLayoutTranslateJob((prev) => ({
				...prev,
				status: "running",
				runScope: "all",
				runScopeIds: [],
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
					...prev,
					status: prev.status === "cancelled" ? "cancelled" : "running",
					items: mergeTranslatePageItems(prev.items, pageIndex, next),
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
				setSourcePreparing(false);
				const pageItems = applyLayoutTranslateSidecar(prepared, sidecar, {
					requireReflowSentencePairs: true,
				});
				const needsRun = hasPendingLayoutTranslateItems(pageItems);
				setCacheOnly(!needsRun);
				setLayoutTranslateJob((prev) => {
					const merged = mergeTranslatePageItems(
						prev.items,
						pageIndex,
						pageItems,
					);
					return {
						...prev,
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
						...prev,
						status: hasPendingLayoutTranslateItems(merged) ? "partial" : "done",
						items: merged,
					};
				});
			})()
				.catch((e) => {
					if (ac.signal.aborted) return;
					const message = displayTranslateError(errorText(e));
					notifyTranslateFailure(message);
					setLayoutTranslateJob((prev) => ({
						...prev,
						status: "partial",
					}));
				})
				.finally(() => {
					publishes.cancel();
					if (layoutTranslateAbortRef.current === ac) {
						if (!ac.signal.aborted) setSourcePreparing(false);
						layoutTranslateAbortRef.current = null;
					}
				});
		},
		[
			layoutRawRegions,
			paperAbsPath,
			paperKey,
			vaultPath,
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
			if (hiddenPageIndexes.has(pageIndex)) {
				setHiddenPageIndexes((hidden) => {
					const next = new Set(hidden);
					next.delete(pageIndex);
					return next;
				});
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
				setHiddenPageIndexes((hidden) => new Set([...hidden, pageIndex]));
				return;
			}
			startPageLayoutTranslate(pageIndex);
		},
		[
			hiddenPageIndexes,
			startPageLayoutTranslate,
			stopLayoutTranslate,
			cancelWaitingLayout,
		],
	);

	/**
	 * Translate only the blocks still missing a translation. Completed blocks
	 * keep their text and the sidecar is rewritten from the merged result, so a
	 * partial run can never drop cached translations.
	 */
	const completeMissingLayoutTranslate = useCallback(() => {
		const job = layoutTranslateJobRef.current;
		if (job.status === "running" || job.status === "waitingLayout") return;
		const pendingIds = new Set(
			job.items
				.filter((item) => !item.translated?.trim())
				.map((item) => item.id),
		);
		if (pendingIds.size === 0) return;
		const cacheKey = job.cacheKey ?? currentLayoutTranslateCacheKey();
		const snapshot = snapshotTranslatedItems(job.items);
		layoutTranslateAbortRef.current?.abort();
		const ac = new AbortController();
		layoutTranslateAbortRef.current = ac;
		setPartialDialogOpen(false);
		setHiddenPageIndexes(new Set());
		setSourcePreparing(false);
		setCacheOnly(false);
		const scopeIds = [...pendingIds];
		const seed = job.items.map((item) =>
			pendingIds.has(item.id)
				? { ...item, status: "running" as const, error: undefined }
				: item,
		);
		setLayoutTranslateJob({
			...job,
			status: "running",
			items: seed,
			cacheKey,
			runScope: "pending",
			runScopeIds: scopeIds,
			partialDismissKey: null,
			partialCompletionFailed: false,
		});
		const publishes = createTranslatePublishCoalescer((next) => {
			if (ac.signal.aborted) return;
			setLayoutTranslateJob((prev) => ({
				...prev,
				status: prev.status === "cancelled" ? "cancelled" : "running",
				items: next,
			}));
		});
		void (async () => {
			const finalItems = await runLayoutRegionTranslate({
				items: seed.map((item) => ({ ...item })),
				signal: ac.signal,
				paperKey,
				vaultPath,
				onUpdate: (next) => {
					if (ac.signal.aborted) return;
					publishes.push(next);
				},
			});
			if (ac.signal.aborted || layoutTranslateAbortRef.current !== ac) return;
			const settled = restoreTranslatedItems(finalItems, snapshot);
			persistLayoutTranslateSidecarBestEffort(paperAbsPath, cacheKey, settled);
			notifyTranslateItemErrors(settled);
			const pending = settled.filter((item) => !item.translated?.trim());
			const dismissKey = layoutTranslatePendingDismissKey(
				dismissalPaperKey,
				cacheKey,
				settled,
			);
			if (!dismissKey) clearTranslationPartialDismissal(job.partialDismissKey);
			setLayoutTranslateJob((prev) => ({
				...prev,
				status: pending.length > 0 ? "partial" : "done",
				items: settled,
				cacheKey,
				runScope: "pending",
				runScopeIds: scopeIds,
				partialDismissKey: dismissKey,
				// Failure keeps the button visible but must not auto-open again.
				partialCompletionFailed: pending.length > 0,
			}));
		})()
			.catch((error) => {
				if (ac.signal.aborted) return;
				notifyTranslateFailure(displayTranslateError(errorText(error)));
				setLayoutTranslateJob((prev) => {
					const settled = restoreTranslatedItems(
						resetRunningTranslateItems(prev.items),
						snapshot,
					);
					const pending = settled.filter((item) => !item.translated?.trim());
					return {
						...prev,
						status: "partial",
						items: settled,
						partialDismissKey: layoutTranslatePendingDismissKey(
							dismissalPaperKey,
							cacheKey,
							settled,
						),
						partialCompletionFailed: pending.length > 0,
					};
				});
			})
			.finally(() => {
				publishes.cancel();
				if (layoutTranslateAbortRef.current === ac) {
					if (!ac.signal.aborted) setSourcePreparing(false);
					layoutTranslateAbortRef.current = null;
				}
			});
	}, [
		paperAbsPath,
		paperKey,
		vaultPath,
		dismissalPaperKey,
		notifyTranslateFailure,
		notifyTranslateItemErrors,
	]);

	/**
	 * Re-request the whole document after an explicit confirmation. Every
	 * successful block is replaced; a failed block falls back to its pre-run
	 * translation so one bad pass cannot empty the cache.
	 */
	const retranslateAllLayoutTranslate = useCallback(() => {
		const job = layoutTranslateJobRef.current;
		if (job.status === "running" || job.status === "waitingLayout") return;
		if (job.items.length === 0) return;
		const cacheKey = job.cacheKey ?? currentLayoutTranslateCacheKey();
		const snapshot = snapshotTranslatedItems(job.items);
		clearTranslationPartialDismissal(job.partialDismissKey);
		layoutTranslateAbortRef.current?.abort();
		const ac = new AbortController();
		layoutTranslateAbortRef.current = ac;
		setPartialDialogOpen(false);
		setHiddenPageIndexes(new Set());
		setSourcePreparing(false);
		setCacheOnly(false);
		const scopeIds = job.items.map((item) => item.id);
		// Keep the old text painted while the new pass streams; status alone
		// tells the runner that every block still needs a request.
		const seed = job.items.map((item) => ({
			...item,
			status: "pending" as const,
			error: undefined,
		}));
		setLayoutTranslateJob({
			...job,
			status: "running",
			items: seed,
			cacheKey,
			runScope: "all",
			runScopeIds: scopeIds,
			partialDismissKey: null,
			partialCompletionFailed: false,
		});
		const publishes = createTranslatePublishCoalescer((next) => {
			if (ac.signal.aborted) return;
			setLayoutTranslateJob((prev) => ({
				...prev,
				status: prev.status === "cancelled" ? "cancelled" : "running",
				items: next,
			}));
		});
		void (async () => {
			const finalItems = await runLayoutRegionTranslate({
				items: seed.map((item) => ({ ...item })),
				signal: ac.signal,
				paperKey,
				vaultPath,
				onUpdate: (next) => {
					if (ac.signal.aborted) return;
					publishes.push(next);
				},
			});
			if (ac.signal.aborted || layoutTranslateAbortRef.current !== ac) return;
			const settled = restoreTranslatedItems(finalItems, snapshot);
			persistLayoutTranslateSidecarBestEffort(paperAbsPath, cacheKey, settled);
			notifyTranslateItemErrors(settled);
			const pending = settled.filter((item) => !item.translated?.trim());
			setLayoutTranslateJob((prev) => ({
				...prev,
				status: pending.length > 0 ? "partial" : "done",
				items: settled,
				cacheKey,
				runScope: "all",
				runScopeIds: scopeIds,
				partialDismissKey: layoutTranslatePendingDismissKey(
					dismissalPaperKey,
					cacheKey,
					settled,
				),
				partialCompletionFailed: pending.length > 0,
			}));
		})()
			.catch((error) => {
				if (ac.signal.aborted) return;
				notifyTranslateFailure(displayTranslateError(errorText(error)));
				setLayoutTranslateJob((prev) => {
					const settled = restoreTranslatedItems(
						resetRunningTranslateItems(prev.items),
						snapshot,
					);
					const pending = settled.filter((item) => !item.translated?.trim());
					return {
						...prev,
						status: pending.length > 0 ? "partial" : "done",
						items: settled,
						partialDismissKey: layoutTranslatePendingDismissKey(
							dismissalPaperKey,
							cacheKey,
							settled,
						),
						partialCompletionFailed: pending.length > 0,
					};
				});
			})
			.finally(() => {
				publishes.cancel();
				if (layoutTranslateAbortRef.current === ac) {
					if (!ac.signal.aborted) setSourcePreparing(false);
					layoutTranslateAbortRef.current = null;
				}
			});
	}, [
		paperAbsPath,
		paperKey,
		vaultPath,
		dismissalPaperKey,
		notifyTranslateFailure,
		notifyTranslateItemErrors,
	]);

	/**
	 * The main button owns original/translated switching. Pending gaps never
	 * make it translate again: completion and full retranslation live on the
	 * partial entry. Stopping keeps completed text and the next click hides it.
	 */
	const toggleLayoutTranslate = useCallback(() => {
		if (layoutTranslateJob.status === "waitingLayout") {
			cancelWaitingLayout();
			return;
		}
		if (layoutTranslateJob.status === "running") {
			stopLayoutTranslate();
			return;
		}
		if (hiddenPageIndexes.size > 0) {
			setHiddenPageIndexes(new Set());
			return;
		}
		if (layoutTranslateJob.items.some((item) => item.translated?.trim())) {
			setHiddenPageIndexes(
				new Set(layoutTranslateJob.items.map((item) => item.pageIndex)),
			);
			return;
		}
		startLayoutTranslate();
	}, [
		layoutTranslateJob,
		hiddenPageIndexes,
		startLayoutTranslate,
		stopLayoutTranslate,
		cancelWaitingLayout,
	]);

	// Abort bulk translate when switching documents.
	useEffect(() => {
		if (!docId) return;
		layoutTranslateAbortRef.current?.abort();
		layoutTranslateAbortRef.current = null;
		setSourcePreparing(false);
		setHiddenPageIndexes(new Set());
		layoutTranslateWaitTargetRef.current = null;
		waitingAutoStartedRef.current = false;
		partialAutoOpenedKeyRef.current = null;
		setPartialDialogOpen(false);
		setLayoutTranslateJob(EMPTY_LAYOUT_TRANSLATE_JOB);
		return () => {
			layoutTranslateAbortRef.current?.abort();
		};
	}, [docId]);

	// A cached layout is already ready for translation. Do not rely on the
	// Figures viewer's active-tab/capability gate or a future file-watch event
	// to publish it, especially after a remount or in a translation companion.
	useEffect(() => {
		if (layoutTranslateJob.status !== "waitingLayout" || !paperAbsPath) return;
		let cancelled = false;
		let ticket = 0;
		const load = async () => {
			const currentTicket = ++ticket;
			const cached = await readLayoutSidecar(paperAbsPath);
			if (cancelled || currentTicket !== ticket || !cached?.regions.length)
				return;
			// Legacy caches still need the viewer's text-layer enrichment.
			if (layoutSidecarNeedsTextLayer(cached)) return;
			setLayoutDocumentResult(
				buildLayoutDocumentResult(
					docId,
					mergeCaptionsIntoHosts(cached.regions),
					cached.regions,
				),
			);
		};
		const unsubscribe = subscribeLayoutSidecarWrite((path) => {
			if (
				normalizeLayoutPaperKey(path) === normalizeLayoutPaperKey(paperAbsPath)
			)
				void load();
		});
		void load();
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [layoutTranslateJob.status, docId, paperAbsPath]);

	// A queued job starts the moment layout regions land (parse finished —
	// possibly in another tab via the sidecar file watcher).
	useEffect(() => {
		if (layoutTranslateJob.status !== "waitingLayout") return;
		if (!layoutRawRegions?.length) return;
		if (waitingAutoStartedRef.current) return;
		waitingAutoStartedRef.current = true;
		const target = layoutTranslateWaitTargetRef.current;
		layoutTranslateWaitTargetRef.current = null;
		if (target?.mode === "page") startPageLayoutTranslate(target.pageIndex);
		else startLayoutTranslate();
	}, [
		layoutTranslateJob.status,
		layoutRawRegions,
		startLayoutTranslate,
		startPageLayoutTranslate,
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
	// pane's local React state. Cache hydrate is shared with `startLayoutTranslate`
	// so both modes agree on cached blocks and the remaining pending set.
	useEffect(() => {
		if (!translationPane || !paperAbsPath) return;
		let cancelled = false;
		const cacheKey = currentLayoutTranslateCacheKey();
		void (async () => {
			const sidecar = await readLayoutTranslateSidecar(paperAbsPath, cacheKey);
			if (cancelled || !sidecar?.items.length) return;
			// Paint the cached blocks before the region-prepare pass. Besides making
			// the pane visible sooner, this marks the job active so the pane's
			// auto-start cannot fire a second, network-backed job while preparing.
			const seededItems = sidecar.items.map((item) => ({
				...item,
				status: "done" as const,
			}));
			if (layoutTranslateJobRef.current.status !== "running") {
				setLayoutTranslateJob((prev) => ({
					...prev,
					status: "done",
					fromCache: true,
					runScope: "initial",
					runScopeIds: seededItems.map((item) => item.id),
					items: seededItems,
					cacheKey,
					partialDismissKey: null,
					partialCompletionFailed: false,
				}));
			}
			const seed = layoutRawRegions?.length
				? toLayoutTranslateItems(
						listTranslatableLayoutRegions(layoutRawRegions),
					)
				: seededItems;
			const prepared = await prepareReflow(seed);
			if (cancelled) return;
			const hydration = hydrateLayoutTranslateItems(prepared, sidecar, {
				requireReflowSentencePairs: true,
			});
			if (!hydration.fromCache) {
				// The cache exists but no block matches the current layout/source.
				// Fall back to the normal first-translation flow.
				startLayoutTranslateRef.current();
				return;
			}
			// A real run started while preparing owns the visible state.
			if (layoutTranslateJobRef.current.status === "running") return;
			const dismissKey = layoutTranslatePendingDismissKey(
				dismissalPaperKey,
				cacheKey,
				hydration.items,
			);
			setCacheOnly(true);
			setSourcePreparing(false);
			setLayoutTranslateJob((prev) => ({
				...prev,
				status: hydration.pendingRequired > 0 ? "partial" : "done",
				items: hydration.items,
				fromCache: true,
				runScope: "initial",
				runScopeIds: layoutTranslateScopeIds(
					hydration.items,
					hydration.pendingRequired > 0,
				),
				cacheKey,
				partialDismissKey: dismissKey,
				partialCompletionFailed: false,
			}));
		})().catch((error) => {
			if (!cancelled)
				notifyError(t("pdf.layoutTranslate.reflowFailed"), {
					description: errorText(error),
				});
		});
		return () => {
			cancelled = true;
		};
	}, [
		translationPane,
		paperAbsPath,
		layoutRawRegions,
		prepareReflow,
		dismissalPaperKey,
		t,
	]);

	// Bucket once per job update (not per page); unchanged buckets keep their
	// previous array identity so memoized page overlays bail out while another
	// page streams.
	const layoutTranslateByPageRef = useRef<
		ReadonlyMap<number, readonly LayoutTranslateItem[]>
	>(new Map());
	const layoutTranslateItemsByPage = useMemo(() => {
		const grouped = groupLayoutTranslateItemsByPage(
			hiddenPageIndexes.size > 0
				? reflowItems.filter((item) => !hiddenPageIndexes.has(item.pageIndex))
				: reflowItems,
			layoutTranslateByPageRef.current,
		);
		layoutTranslateByPageRef.current = grouped;
		return grouped;
	}, [reflowItems, hiddenPageIndexes]);

	const layoutTranslatePageStateByPage = useMemo(() => {
		const states = new Map<number, { active: boolean; running: boolean }>();
		for (const item of layoutTranslateJob.items) {
			if (hiddenPageIndexes.has(item.pageIndex)) continue;
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
	}, [layoutTranslateJob.items, hiddenPageIndexes]);

	const layoutTranslateRunning = layoutTranslateJob.status === "running";
	const layoutTranslatePendingRequired = useMemo(
		() => countPendingLayoutTranslateItems(layoutTranslateJob.items),
		[layoutTranslateJob.items],
	);
	// A pending-completion run measures only the blocks it is filling in, not the
	// document-wide ratio (which would sit near 98% for a handful of gaps).
	const textSettled = useMemo(() => {
		const scopeIds = layoutTranslateJob.runScopeIds;
		const items = layoutTranslateJob.items;
		if (layoutTranslateJob.runScope === "all" || scopeIds.length === 0) {
			return layoutTranslateSettledRatio(items);
		}
		return layoutTranslateSettledRatio(
			items.filter((item) => scopeIds.includes(item.id)),
		);
	}, [
		layoutTranslateJob.items,
		layoutTranslateJob.runScope,
		layoutTranslateJob.runScopeIds,
	]);
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
		layoutTranslateRunning && sourcePreparing ? null : textSettled,
		(layoutTranslateRunning || previewPending) && !finalReflowFailed,
		reflowProgress,
		cacheOnly,
	);
	// Cached re-runs settle almost immediately, but the translated page only
	// paints once the final reflow build publishes its previews. Keep the
	// loading indicator up through that build instead of leaving a blank wait.
	const layoutTranslatePreparing =
		previewPending && !layoutTranslateRunning && !finalReflowFailed;
	const layoutTranslateWaiting = layoutTranslateJob.status === "waitingLayout";
	const layoutTranslateActive =
		layoutTranslateRunning ||
		layoutTranslateJob.items.some(
			(item) => item.translated && !hiddenPageIndexes.has(item.pageIndex),
		);
	const layoutTranslateLabel = layoutTranslateWaiting
		? t("pdf.layoutTranslate.waiting")
		: layoutTranslateRunning
			? t("pdf.layoutTranslate.stop")
			: hiddenPageIndexes.size > 0
				? t("pdf.layoutTranslate.show")
				: layoutTranslateActive
					? t("pdf.layoutTranslate.hide")
					: t("pdf.layoutTranslate.start");

	const dismissPartialLayoutTranslate = useCallback(() => {
		dismissTranslationPartial(layoutTranslateJobRef.current.partialDismissKey);
		setPartialDialogOpen(false);
	}, []);

	// The main translate button owns original/translated switching; the partial
	// entry stays a separate, always-available action while gaps remain (page
	// building does not hide it, only an in-flight translation run does).
	const layoutTranslatePartialVisible =
		layoutTranslatePendingRequired > 0 &&
		!layoutTranslateRunning &&
		!layoutTranslateWaiting;

	const partialPageRange = useMemo(
		() => layoutTranslatePendingPageRange(layoutTranslateJob.items),
		[layoutTranslateJob.items],
	);
	const layoutTranslateTranslatedCount = Math.max(
		0,
		layoutTranslateJob.items.length - layoutTranslatePendingRequired,
	);
	const layoutTranslatePartial = useMemo<PdfLayoutTranslatePartial>(
		() => ({
			pendingRequired: layoutTranslatePendingRequired,
			translatedCount: layoutTranslateTranslatedCount,
			totalCount: layoutTranslateJob.items.length,
			pageRange: partialPageRange,
			visible: layoutTranslatePartialVisible,
			open: partialDialogOpen,
			completionFailed: layoutTranslateJob.partialCompletionFailed,
			onOpenChange: setPartialDialogOpen,
			onCompleteMissing: completeMissingLayoutTranslate,
			onRetranslateAll: retranslateAllLayoutTranslate,
			onDismiss: dismissPartialLayoutTranslate,
		}),
		[
			layoutTranslatePendingRequired,
			layoutTranslateTranslatedCount,
			layoutTranslateJob.items.length,
			partialPageRange,
			layoutTranslatePartialVisible,
			partialDialogOpen,
			layoutTranslateJob.partialCompletionFailed,
			completeMissingLayoutTranslate,
			retranslateAllLayoutTranslate,
			dismissPartialLayoutTranslate,
		],
	);

	return {
		reflowBusy,
		reflowReady,
		reflowOutput,
		exportTranslatedPdf,
		layoutTranslateItemsByPage,
		layoutTranslatePageStateByPage,
		layoutTranslateRunning,
		layoutTranslatePreparing,
		layoutTranslateWaiting,
		layoutTranslateActive,
		layoutTranslateLabel,
		layoutTranslatePendingRequired,
		layoutTranslateFromCache: layoutTranslateJob.fromCache,
		layoutTranslateStatus: layoutTranslateJob.status,
		layoutTranslatePartial,
		layoutTranslateProgress,
		toggleLayoutTranslate,
		togglePageLayoutTranslate,
	};
}
