import type {
	DocumentAnalysisProgress,
	DocumentLayout,
	LayoutAnalysisScope,
	LayoutTask,
} from "@embedpdf/plugin-layout-analysis";

import i18n from "@/i18n";
import { logger } from "@/lib/core/logger";
import {
	beginLayoutAnalysisAttempt,
	finishLayoutAnalysisAttempt,
	resetLayoutAnalysisCrashGuard,
	shouldSkipAutoLayoutAnalysis,
} from "@/lib/pdf/layout/crash-guard";
import {
	readLayoutSidecar,
	writeLayoutIndexFromRaw,
	writeLayoutSidecar,
} from "@/lib/pdf/layout/io";
import { mergeCaptionsIntoHosts } from "@/lib/pdf/layout/merge-captions";
import { ensureLayoutModel } from "@/lib/pdf/layout/model";
import {
	buildLayoutDocumentResult,
	regionsFromDocumentLayout,
	summarizeLayoutResult,
} from "@/lib/pdf/layout/normalize";
import {
	setLayoutAnalysisUi,
	setLayoutDocumentResult,
} from "@/lib/pdf/layout/store";
import {
	attachTitlesFromTextRuns,
	enrichCaptionRegionsWithText,
} from "@/lib/pdf/layout/title-text";
import type {
	PdfLayoutDocumentResult,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";

export type RunLayoutAnalysisOptions = {
	/**
	 * When true, ignore `source/layout.json` and re-run PP-DocLayoutV3 (PDF→JSON).
	 * When false (default), load the sidecar if present and only re-run
	 * merge/filter into the sidebar store (JSON→regions).
	 */
	force?: boolean;
	/**
	 * Who asked for the analysis. Automatic paths (default) refuse to re-run
	 * after repeated mid-analysis WebView crashes; a manual run resets the
	 * crash guard and always proceeds.
	 */
	trigger?: "auto" | "manual";
	/** Paper folder path; when present, raw layout persists to source/layout.json. */
	paperAbsPath?: string | null;
	/** PDF page count for progress bar before the first page-complete event. */
	totalPages?: number | null;
	onProgress?: (messageStage: DocumentAnalysisProgress) => void;
	onDone?: (summary: string, total: number) => void;
	onError?: (message: string, aborted: boolean) => void;
};

/** Intra-page phase weight (0–1) so the bar advances within a page. */
function pagePhaseWeight(stage: DocumentAnalysisProgress["stage"]): number {
	switch (stage) {
		case "creating-session":
			return 0.05;
		case "rendering":
			return 0.2;
		case "layout-detection":
			return 0.55;
		case "mapping-coordinates":
			return 0.8;
		case "table-structure":
			return 0.9;
		case "page-complete":
			return 1;
		default:
			return 0.4;
	}
}

function clampProgress(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, Math.round(value)));
}

function taskToPromise<T>(task: {
	wait: (ok: (v: T) => void, err: (e: unknown) => void) => void;
}): Promise<T> {
	return new Promise((resolve, reject) => {
		task.wait(resolve, reject);
	});
}

function buildResultFromRawRegions(
	documentId: string,
	rawRegions: PdfLayoutRegion[],
): PdfLayoutDocumentResult {
	return buildLayoutDocumentResult(
		documentId,
		mergeCaptionsIntoHosts(rawRegions),
		rawRegions,
	);
}

/** Prefer plugin page layout; else recover size from point-rect / normalized bbox. */
function estimatePageSizesFromRegions(
	regions: readonly PdfLayoutRegion[],
	scope: LayoutAnalysisScope,
): Map<number, { width: number; height: number }> {
	const pageSizes = new Map<number, { width: number; height: number }>();
	const pages = new Set(regions.map((r) => r.pageIndex));
	for (const pageIndex of pages) {
		const layout = scope.getPageLayout(pageIndex);
		const size = layout?.pageSize;
		if (size && size.width > 0 && size.height > 0) {
			pageSizes.set(pageIndex, size);
			continue;
		}
		// rect (points) / bbox (0–1) ⇒ page size.
		let width = 0;
		let height = 0;
		for (const r of regions) {
			if (r.pageIndex !== pageIndex) continue;
			if (r.bbox.w > 0.02) width = Math.max(width, r.rect.w / r.bbox.w);
			if (r.bbox.h > 0.02) height = Math.max(height, r.rect.h / r.bbox.h);
		}
		if (width > 0 && height > 0) pageSizes.set(pageIndex, { width, height });
	}
	return pageSizes;
}

/** Pull PDF text layer into caption / body / abstract fields per page. */
async function enrichRawRegionsWithPageText(
	scope: LayoutAnalysisScope,
	raw: PdfLayoutRegion[],
	pageSizes: Map<number, { width: number; height: number }>,
): Promise<PdfLayoutRegion[]> {
	let next = raw;
	const pages = new Set(raw.map((r) => r.pageIndex));
	for (const pageIndex of pages) {
		const pageSize = pageSizes.get(pageIndex);
		if (!pageSize || pageSize.width <= 0 || pageSize.height <= 0) continue;
		try {
			const textRuns = await taskToPromise(scope.getPageTextRuns(pageIndex));
			const runs = textRuns.runs ?? [];
			next = enrichCaptionRegionsWithText(next, pageIndex, runs, pageSize);
		} catch {
			// continue without text for this page
		}
	}
	return next;
}

/**
 * 1) Extract text on every caption / body / abstract box
 * 2) Assign captionRole (Figure/Table/Algorithm/subpanel)
 * 3) Merge by role + geometry
 * 4) Fill host titles from titleBbox if needed
 */
async function buildTextAwareResult(
	scope: LayoutAnalysisScope,
	documentId: string,
	docLayout: DocumentLayout,
): Promise<{
	rawRegions: PdfLayoutRegion[];
	result: PdfLayoutDocumentResult;
}> {
	let raw: PdfLayoutRegion[] = regionsFromDocumentLayout(docLayout);

	const pageSizes = new Map<number, { width: number; height: number }>();
	for (const page of docLayout.pages) {
		pageSizes.set(page.pageIndex, page.pageSize);
	}
	raw = await enrichRawRegionsWithPageText(scope, raw, pageSizes);

	let result = buildResultFromRawRegions(documentId, raw);
	let regions = result.regions;

	// Ensure hosts with titleBbox have title strings.
	const pages = new Set(raw.map((r) => r.pageIndex));
	for (const pageIndex of pages) {
		const pageSize = pageSizes.get(pageIndex);
		if (!pageSize) continue;
		const need = regions.some(
			(r) => r.pageIndex === pageIndex && r.titleBbox && !r.title?.trim(),
		);
		if (!need) continue;
		try {
			const textRuns = await taskToPromise(scope.getPageTextRuns(pageIndex));
			regions = attachTitlesFromTextRuns(
				regions,
				pageIndex,
				textRuns.runs ?? [],
				pageSize,
			);
			result = buildLayoutDocumentResult(documentId, regions, raw);
		} catch {
			// ignore
		}
	}

	return { rawRegions: raw, result };
}

/**
 * Shared analyze-all-pages runner for toolbar + PdfViewerHandle + figures panel.
 * Awaits Host XDG model ensure (ModelScope → HuggingFace) before analysis.
 */
export async function runDocumentLayoutAnalysis(
	scope: LayoutAnalysisScope,
	documentId: string,
	options: RunLayoutAnalysisOptions = {},
): Promise<LayoutTask<DocumentLayout, DocumentAnalysisProgress> | null> {
	// Default path: JSON→sidebar re-merge from layout.json (no ONNX).
	// `force` skips this and re-runs PDF→JSON via PP-DocLayoutV3.
	if (!options.force && options.paperAbsPath) {
		setLayoutAnalysisUi(
			{
				stage: "running",
				message: "Rebuilding from cached layout…",
				progress: null,
			},
			documentId,
		);
		const cached = await readLayoutSidecar(options.paperAbsPath);
		if (cached) {
			// Sidecar may predate body-text extract; re-pull PDF text layer cheaply.
			const pageSizes = estimatePageSizesFromRegions(cached.regions, scope);
			const needsText = cached.regions.some(
				(r) =>
					(r.kind === "text" ||
						r.kind === "abstract" ||
						r.kind === "header" ||
						r.kind === "figure_title") &&
					!(r.text?.trim() || r.title?.trim()),
			);
			const raw = needsText
				? await enrichRawRegionsWithPageText(scope, cached.regions, pageSizes)
				: cached.regions;
			// Always re-run merge/filter so algorithm tweaks apply without ONNX.
			const result = buildResultFromRawRegions(documentId, raw);
			setLayoutDocumentResult(result);
			const summary = summarizeLayoutResult(result);
			setLayoutAnalysisUi(
				{
					stage: "done",
					message: summary,
					total: result.regions.length,
				},
				documentId,
			);
			console.info("[layout-analysis]", {
				documentId,
				summary,
				cache: true,
				regions: result.regions,
			});
			if (needsText) {
				void writeLayoutSidecar(options.paperAbsPath, raw).catch(
					() => undefined,
				);
			}
			// Always refresh sidebar index (cheap; keeps CLI in sync with merge rules).
			void writeLayoutIndexFromRaw(options.paperAbsPath, raw).catch(
				() => undefined,
			);
			options.onDone?.(summary, result.regions.length);
			return null;
		}
	}

	// ONNX path (cache miss). Repeated mid-analysis WebView crashes must not
	// loop forever: automatic callers back off, manual runs reset the guard.
	if (options.paperAbsPath) {
		if (options.trigger === "manual") {
			resetLayoutAnalysisCrashGuard(options.paperAbsPath);
		} else if (shouldSkipAutoLayoutAnalysis(options.paperAbsPath)) {
			const message = i18n.t("viewer:pdf.layout.crashLoopSkipped");
			logger.warn("layout analysis auto-run skipped after repeated crashes", {
				paperAbsPath: options.paperAbsPath,
			});
			setLayoutAnalysisUi({ stage: "error", message }, documentId);
			options.onError?.(message, false);
			return null;
		}
	}

	setLayoutAnalysisUi(
		{
			stage: "running",
			message: "Analyzing layout…",
			progress: null,
		},
		documentId,
	);

	try {
		const s = await ensureLayoutModel();
		if (s && !s.ready) {
			logger.warn("layout model ensure returned not ready", s);
		}
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		logger.warn("layout model ensure failed", { error: message });
		setLayoutAnalysisUi({ stage: "error", message }, documentId);
		options.onError?.(message, false);
		// Return a no-op style task: rethrow by starting nothing — callers need a task.
		// Fall through only if we still want plugin fallback; fail closed here.
		throw e;
	}

	let knownTotal =
		typeof options.totalPages === "number" && options.totalPages > 0
			? Math.floor(options.totalPages)
			: null;
	let completedPages = 0;

	setLayoutAnalysisUi(
		{
			stage: "running",
			message: "Analyzing layout…",
			progress: 0,
			completed: 0,
			total: knownTotal ?? undefined,
		},
		documentId,
	);

	// From here rendering + inference can exhaust the WebContent process; the
	// in-flight record below is only cleared by a normal outcome, so a reload
	// that finds it knows the previous run crashed the WebView.
	if (options.paperAbsPath) beginLayoutAnalysisAttempt(options.paperAbsPath);
	const task = scope.analyzeAllPages({ force: options.force });

	task.onProgress((p) => {
		options.onProgress?.(p);
		// Overall document progress for Figures rail + background-tasks panel:
		// model prep 0–5%, pages 5–98%, merge 99% (set below), done 100%.
		const message = "Analyzing layout…";
		let progress: number | null = knownTotal && knownTotal > 0 ? 0 : null;
		let page: number | undefined;

		const pageProgress = (pageIndex: number, phase: number) => {
			if (knownTotal && knownTotal > 0) {
				return clampProgress(5 + ((pageIndex + phase) / knownTotal) * 93);
			}
			return clampProgress(Math.min(95, 5 + (pageIndex + 0.5) * 4));
		};

		switch (p.stage) {
			case "downloading-model": {
				// Host may still be writing the file; plugin loads via agentero-model://.
				// Map model download into the first 5% so the bar never jumps to 100%
				// before page analysis starts.
				const pct = p.total > 0 ? (p.loaded / p.total) * 100 : 0;
				progress = clampProgress((pct / 100) * 5);
				break;
			}
			case "creating-session":
				progress = 5;
				break;
			case "rendering":
			case "layout-detection":
			case "mapping-coordinates":
			case "table-structure": {
				// Keep a stable "Analyzing layout…" message; page progress is
				// shown via progress bar + page counters in the figures panel.
				page = p.pageIndex + 1;
				progress = pageProgress(p.pageIndex, pagePhaseWeight(p.stage));
				break;
			}
			case "page-complete":
				if (p.total > 0) knownTotal = p.total;
				completedPages = p.completed;
				page = p.pageIndex + 1;
				progress =
					p.total > 0 ? clampProgress(5 + (p.completed / p.total) * 93) : null;
				break;
			default:
				break;
		}

		setLayoutAnalysisUi(
			{
				stage: "running",
				message,
				progress,
				page,
				completed: completedPages,
				total: knownTotal ?? undefined,
			},
			documentId,
		);
	});

	task.wait(
		(docLayout) => {
			if (options.paperAbsPath) {
				finishLayoutAnalysisAttempt(options.paperAbsPath);
			}
			setLayoutAnalysisUi(
				{
					stage: "running",
					message: "Merging figures & captions…",
					progress: 99,
					page: knownTotal ?? completedPages,
					completed: knownTotal ?? completedPages,
					total: knownTotal ?? undefined,
				},
				documentId,
			);
			void buildTextAwareResult(scope, documentId, docLayout)
				.then(async ({ rawRegions, result }) => {
					try {
						await writeLayoutSidecar(options.paperAbsPath, rawRegions);
					} catch (e) {
						const message = e instanceof Error ? e.message : String(e);
						logger.warn("layout sidecar write failed", { error: message });
					}
					try {
						await writeLayoutIndexFromRaw(options.paperAbsPath, rawRegions);
					} catch (e) {
						const message = e instanceof Error ? e.message : String(e);
						logger.warn("layout index write failed", { error: message });
					}
					setLayoutDocumentResult(result);
					const summary = summarizeLayoutResult(result);
					setLayoutAnalysisUi(
						{
							stage: "done",
							message: summary,
							total: result.regions.length,
						},
						documentId,
					);
					console.info("[layout-analysis]", {
						documentId,
						summary,
						regions: result.regions,
					});
					options.onDone?.(summary, result.regions.length);
				})
				.catch((err) => {
					const message = err instanceof Error ? err.message : String(err);
					setLayoutAnalysisUi({ stage: "error", message }, documentId);
					options.onError?.(message, false);
				});
		},
		(error) => {
			if (options.paperAbsPath) {
				finishLayoutAnalysisAttempt(options.paperAbsPath);
			}
			if (error.type === "abort") {
				setLayoutAnalysisUi({ stage: "cancelled" }, documentId);
				options.onError?.("cancelled", true);
				return;
			}
			const reason = error.reason;
			const message =
				reason &&
				typeof reason === "object" &&
				"message" in reason &&
				typeof reason.message === "string"
					? reason.message
					: "Layout analysis failed";
			setLayoutAnalysisUi({ stage: "error", message }, documentId);
			options.onError?.(message, false);
		},
	);

	return task;
}
