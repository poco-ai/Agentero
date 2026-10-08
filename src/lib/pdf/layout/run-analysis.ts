import type {
	DocumentAnalysisProgress,
	DocumentLayout,
	LayoutAnalysisErrorReason,
	LayoutAnalysisScope,
	LayoutTask,
} from "@embedpdf/plugin-layout-analysis";
import { events } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";

import { logger } from "@/lib/core/logger";
import { isTauri } from "@/lib/core/tauri";
import { findCanonicalPaperPdfPath, localFileToArrayBuffer } from "@/lib/paper";
import {
	type LayoutSidecarMode,
	layoutSidecarNeedsTextLayer,
	readLayoutSidecar,
	writeLayoutIndexFromRaw,
	writeLayoutSidecar,
	writeLayoutTextBackfill,
} from "@/lib/pdf/layout/io";
import { mergeCaptionsIntoHosts } from "@/lib/pdf/layout/merge-captions";
import { ensureLayoutModel } from "@/lib/pdf/layout/model";
import {
	buildLayoutDocumentResult,
	regionsFromDocumentLayout,
	summarizeLayoutResult,
} from "@/lib/pdf/layout/normalize";
import {
	invokeLayoutRemoteAnalyzePdf,
	paddlePageToRegions,
} from "@/lib/pdf/layout/paddle";
import {
	isRemoteLayoutProvider,
	layoutProviderFor,
	type RemoteLayoutProviderDescriptor,
} from "@/lib/pdf/layout/providers";
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
import { loadSettings } from "@/lib/settings/store";

export type RunLayoutAnalysisOptions = {
	/**
	 * When true, ignore `source/layout.json` and re-run PP-DocLayoutV3 (PDF→JSON).
	 * When false (default), load the sidecar if present and only re-run
	 * merge/filter into the sidebar store (JSON→regions).
	 */
	force?: boolean;
	/** Paper folder path; when present, raw layout persists to source/layout.json. */
	paperAbsPath?: string | null;
	/** PDF page count for progress bar before the first page-complete event. */
	totalPages?: number | null;
	/** Label shown in progress UI instead of the generic "Analyzing layout…". */
	paperLabel?: string;
	/** Optional live document guard for viewer-bound analysis. */
	isDocumentOpen?: () => boolean;
	/**
	 * True PDF page size in points for remote backends (the service renders
	 * pages itself, so sizes cannot come from a local render).
	 */
	pageSizeAt?: (pageIndex: number) => { width: number; height: number } | null;
	onProgress?: (messageStage: DocumentAnalysisProgress) => void;
	onDone?: (summary: string, total: number) => void;
	onError?: (message: string, aborted: boolean) => void;
};

/** Structural task shape shared by the local plugin task and the remote task. */
export type LayoutTaskLike = {
	onProgress: (listener: (p: DocumentAnalysisProgress) => void) => void;
	wait: (
		ok: (value: DocumentLayout) => void,
		err: (e: { type?: string; reason?: unknown }) => void,
	) => void;
	abort: (reason: LayoutAnalysisErrorReason) => void;
};

class LayoutDocumentClosedError extends Error {
	constructor() {
		super("document closed");
		this.name = "LayoutDocumentClosedError";
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (!error || typeof error !== "object") return "";
	const record = error as Record<string, unknown>;
	if (typeof record.message === "string") return record.message;
	const reason = record.reason;
	if (typeof reason === "string") return reason;
	if (reason && typeof reason === "object") {
		const reasonMessage = (reason as Record<string, unknown>).message;
		if (typeof reasonMessage === "string") return reasonMessage;
	}
	return "";
}

function isPdfDocumentCloseRaceError(error: unknown): boolean {
	return /document (does not|is not|not) open/i.test(errorMessage(error));
}

function isLayoutDocumentClosedError(error: unknown): boolean {
	return (
		error instanceof LayoutDocumentClosedError ||
		isPdfDocumentCloseRaceError(error)
	);
}

function isNoDocumentTaskError(error: { reason?: unknown }): boolean {
	const { reason } = error;
	return (
		reason != null &&
		typeof reason === "object" &&
		(reason as { type?: unknown }).type === "no-document"
	);
}

function assertDocumentOpen(isDocumentOpen?: () => boolean): void {
	if (isDocumentOpen && !isDocumentOpen()) {
		throw new LayoutDocumentClosedError();
	}
}

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
	options: RunLayoutAnalysisOptions,
): Map<number, { width: number; height: number }> {
	const pageSizes = new Map<number, { width: number; height: number }>();
	const pages = new Set(regions.map((r) => r.pageIndex));
	for (let pageIndex = 0; pageIndex < (options.totalPages ?? 0); pageIndex++) {
		pages.add(pageIndex);
	}
	for (const pageIndex of pages) {
		assertDocumentOpen(options.isDocumentOpen);
		const layout = scope.getPageLayout(pageIndex);
		const size = options.pageSizeAt?.(pageIndex) ?? layout?.pageSize;
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
		// Keep unknown pages in the walk so they cannot be marked complete.
		pageSizes.set(pageIndex, { width, height });
	}
	return pageSizes;
}

/** Pull PDF text layer into caption / body / abstract fields per page. */
async function enrichRawRegionsWithPageText(
	scope: LayoutAnalysisScope,
	raw: PdfLayoutRegion[],
	pageSizes: Map<number, { width: number; height: number }>,
	isDocumentOpen?: () => boolean,
): Promise<{ regions: PdfLayoutRegion[]; complete: boolean }> {
	let next = raw;
	let complete = true;
	const pages = new Set([...pageSizes.keys(), ...raw.map((r) => r.pageIndex)]);
	for (const pageIndex of pages) {
		assertDocumentOpen(isDocumentOpen);
		const pageSize = pageSizes.get(pageIndex);
		if (!pageSize || pageSize.width <= 0 || pageSize.height <= 0) {
			complete = false;
			continue;
		}
		try {
			const textRuns = await taskToPromise(scope.getPageTextRuns(pageIndex));
			assertDocumentOpen(isDocumentOpen);
			const runs = textRuns.runs ?? [];
			next = enrichCaptionRegionsWithText(next, pageIndex, runs, pageSize);
		} catch (error) {
			if (
				isLayoutDocumentClosedError(error) ||
				(isDocumentOpen && !isDocumentOpen())
			) {
				throw new LayoutDocumentClosedError();
			}
			complete = false;
		}
	}
	return { regions: next, complete };
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
	isDocumentOpen?: () => boolean,
): Promise<{
	rawRegions: PdfLayoutRegion[];
	result: PdfLayoutDocumentResult;
	textLayerExtracted: boolean;
}> {
	assertDocumentOpen(isDocumentOpen);
	let raw: PdfLayoutRegion[] = regionsFromDocumentLayout(docLayout);

	const pageSizes = new Map<number, { width: number; height: number }>();
	for (const page of docLayout.pages) {
		pageSizes.set(page.pageIndex, page.pageSize);
	}
	const extracted = await enrichRawRegionsWithPageText(
		scope,
		raw,
		pageSizes,
		isDocumentOpen,
	);
	raw = extracted.regions;
	const textLayerExtracted = extracted.complete;
	assertDocumentOpen(isDocumentOpen);

	let result = buildResultFromRawRegions(documentId, raw);
	let regions = result.regions;

	// Ensure hosts with titleBbox have title strings.
	const pages = new Set(raw.map((r) => r.pageIndex));
	for (const pageIndex of pages) {
		assertDocumentOpen(isDocumentOpen);
		const pageSize = pageSizes.get(pageIndex);
		if (!pageSize) continue;
		const need = regions.some(
			(r) => r.pageIndex === pageIndex && r.titleBbox && !r.title?.trim(),
		);
		if (!need) continue;
		try {
			const textRuns = await taskToPromise(scope.getPageTextRuns(pageIndex));
			assertDocumentOpen(isDocumentOpen);
			regions = attachTitlesFromTextRuns(
				regions,
				pageIndex,
				textRuns.runs ?? [],
				pageSize,
			);
			result = buildLayoutDocumentResult(documentId, regions, raw);
		} catch (error) {
			if (
				isLayoutDocumentClosedError(error) ||
				(isDocumentOpen && !isDocumentOpen())
			) {
				throw new LayoutDocumentClosedError();
			}
			// ignore
		}
	}

	return { rawRegions: raw, result, textLayerExtracted };
}

/**
 * Shared analyze-all-pages runner for toolbar + PdfViewerHandle + figures panel.
 * Awaits Host XDG model ensure (ModelScope → HuggingFace) before analysis.
 */
export async function runDocumentLayoutAnalysis(
	scope: LayoutAnalysisScope,
	documentId: string,
	options: RunLayoutAnalysisOptions = {},
): Promise<LayoutTaskLike | null> {
	/** Attribute progress to this paper so the open Figures rail can match. */
	const paperKey = options.paperAbsPath ?? null;
	const setUi = (
		ui: Parameters<typeof setLayoutAnalysisUi>[0],
		withPaper = false,
	) => {
		setLayoutAnalysisUi(ui, documentId, withPaper ? paperKey : undefined);
	};

	const cancelClosedDocument = () => {
		setUi({ stage: "cancelled" });
		options.onError?.("document closed", true);
	};
	if (options.isDocumentOpen && !options.isDocumentOpen()) {
		cancelClosedDocument();
		return null;
	}

	// Default path: JSON→sidebar re-merge from layout.json (no ONNX).
	// `force` skips this and re-runs PDF→JSON via PP-DocLayoutV3.
	if (!options.force && options.paperAbsPath) {
		const cached = await readLayoutSidecar(options.paperAbsPath);
		if (options.isDocumentOpen && !options.isDocumentOpen()) {
			cancelClosedDocument();
			return null;
		}
		if (cached) {
			try {
				// No textLayerExtracted flag: walk the text layer once, including
				// boxes that already have text, then write it back. A flagged
				// sidecar only merges in memory and does not show analyzing.
				const needsText = layoutSidecarNeedsTextLayer(cached);
				if (needsText) {
					setUi(
						{
							stage: "running",
							message: "Rebuilding from cached layout…",
							progress: null,
						},
						true,
					);
				}
				const extracted = needsText
					? await enrichRawRegionsWithPageText(
							scope,
							cached.regions,
							estimatePageSizesFromRegions(cached.regions, scope, options),
							options.isDocumentOpen,
						)
					: null;
				const raw = extracted?.regions ?? cached.regions;
				if (options.isDocumentOpen && !options.isDocumentOpen()) {
					cancelClosedDocument();
					return null;
				}
				// Always re-run merge/filter so algorithm tweaks apply without ONNX.
				const result = buildResultFromRawRegions(documentId, raw);
				// A finished text walk is written back onto this same parse. A newer
				// sidecar (mode, generatedAt, or box geometry) is left untouched.
				if (needsText && extracted?.complete) {
					try {
						const wrote = await writeLayoutTextBackfill(
							options.paperAbsPath,
							cached,
							raw,
						);
						if (!wrote) {
							logger.warn(
								"layout text backfill skipped; sidecar parse changed",
							);
						}
					} catch (error) {
						logger.warn("layout text backfill failed", {
							error: errorText(error),
						});
					}
				}
				setLayoutDocumentResult(result);
				const summary = summarizeLayoutResult(result);
				setUi({
					stage: "done",
					message: summary,
					total: result.regions.length,
				});
				console.info("[layout-analysis]", {
					documentId,
					summary,
					cache: true,
					regions: result.regions,
				});
				// The index write is a no-op when the content is unchanged.
				void writeLayoutIndexFromRaw(options.paperAbsPath, raw).catch(
					() => undefined,
				);
				options.onDone?.(summary, result.regions.length);
				return null;
			} catch (error) {
				if (
					isLayoutDocumentClosedError(error) ||
					(options.isDocumentOpen && !options.isDocumentOpen())
				) {
					cancelClosedDocument();
					return null;
				}
				throw error;
			}
		}
	}

	const analyzingMessage = options.paperLabel?.trim() || "Analyzing layout…";

	setUi(
		{
			stage: "running",
			message: analyzingMessage,
			progress: null,
		},
		true,
	);

	// Remote layout backend (Settings → Layout): whole-PDF async job.
	// Falls back to local ONNX when the paper folder / page count is unknown.
	const provider = layoutProviderFor(loadSettings().layout.backend);
	if (
		provider &&
		isRemoteLayoutProvider(provider) &&
		options.paperAbsPath &&
		typeof options.totalPages === "number" &&
		options.totalPages > 0
	) {
		return startRemoteLayoutAnalysis(provider, scope, documentId, options, {
			paperAbsPath: options.paperAbsPath,
			totalPages: Math.floor(options.totalPages),
			analyzingMessage,
			cancelClosedDocument,
		});
	}

	try {
		const s = await ensureLayoutModel();
		if (s && !s.ready) {
			logger.warn("layout model ensure returned not ready", s);
		}
	} catch (e) {
		const message = errorText(e);
		logger.warn("layout model ensure failed", { error: message });
		setUi({ stage: "error", message });
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

	setUi(
		{
			stage: "running",
			message: analyzingMessage,
			progress: 0,
			completed: 0,
			total: knownTotal ?? undefined,
		},
		true,
	);

	let task: LayoutTask<DocumentLayout, DocumentAnalysisProgress>;
	try {
		assertDocumentOpen(options.isDocumentOpen);
		task = scope.analyzeAllPages({ force: options.force });
	} catch (error) {
		if (
			isLayoutDocumentClosedError(error) ||
			(options.isDocumentOpen && !options.isDocumentOpen())
		) {
			cancelClosedDocument();
			return null;
		}
		throw error;
	}

	task.onProgress((p) => {
		if (options.isDocumentOpen && !options.isDocumentOpen()) {
			task.abort({ type: "no-document", message: "document closed" });
			return;
		}
		options.onProgress?.(p);
		// Overall document progress for Figures rail + background-tasks panel:
		// model prep 0–5%, pages 5–98%, merge 99% (set below), done 100%.
		const message = analyzingMessage;
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

		setUi({
			stage: "running",
			message,
			progress,
			page,
			completed: completedPages,
			total: knownTotal ?? undefined,
		});
	});

	task.wait(
		(docLayout) => {
			if (options.isDocumentOpen && !options.isDocumentOpen()) {
				cancelClosedDocument();
				return;
			}
			setUi({
				stage: "running",
				message: "Merging figures & captions…",
				progress: 99,
				page: knownTotal ?? completedPages,
				completed: knownTotal ?? completedPages,
				total: knownTotal ?? undefined,
			});
			void buildTextAwareResult(
				scope,
				documentId,
				docLayout,
				options.isDocumentOpen,
			)
				.then(async ({ rawRegions, result, textLayerExtracted }) => {
					if (options.isDocumentOpen && !options.isDocumentOpen()) {
						cancelClosedDocument();
						return;
					}
					try {
						await writeLayoutSidecar(
							options.paperAbsPath,
							rawRegions,
							"embedpdf-layout",
							{ textLayerExtracted },
						);
					} catch (e) {
						const message = errorText(e);
						logger.warn("layout sidecar write failed", { error: message });
					}
					try {
						await writeLayoutIndexFromRaw(options.paperAbsPath, rawRegions);
					} catch (e) {
						const message = errorText(e);
						logger.warn("layout index write failed", { error: message });
					}
					setLayoutDocumentResult(result);
					const summary = summarizeLayoutResult(result);
					setUi({
						stage: "done",
						message: summary,
						total: result.regions.length,
					});
					console.info("[layout-analysis]", {
						documentId,
						summary,
						regions: result.regions,
					});
					options.onDone?.(summary, result.regions.length);
				})
				.catch((err) => {
					if (
						isLayoutDocumentClosedError(err) ||
						(options.isDocumentOpen && !options.isDocumentOpen())
					) {
						cancelClosedDocument();
						return;
					}
					const message = errorText(err);
					setUi({ stage: "error", message });
					options.onError?.(message, false);
				});
		},
		(error) => {
			if (
				error.type === "abort" ||
				isNoDocumentTaskError(error) ||
				isPdfDocumentCloseRaceError(error) ||
				(options.isDocumentOpen && !options.isDocumentOpen())
			) {
				setUi({ stage: "cancelled" });
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
			setUi({ stage: "error", message });
			options.onError?.(message, false);
		},
	);

	return task;
}

/** Minimal LayoutTask-compatible handle for a remote provider run. */
class RemoteLayoutTask implements LayoutTaskLike {
	private progressListeners: Array<(p: DocumentAnalysisProgress) => void> = [];
	private settled = false;
	private aborted = false;

	onProgress(listener: (p: DocumentAnalysisProgress) => void): void {
		this.progressListeners.push(listener);
	}

	wait(
		ok: (value: DocumentLayout) => void,
		err: (e: { type?: string; reason?: unknown }) => void,
	): void {
		this.onSettle = (e) => {
			if (e === "ok") ok({ pages: [] });
			else err(e);
		};
		if (this.settled && this.settleError) {
			this.onSettle(this.settleError);
		} else if (this.settled) {
			this.onSettle("ok");
		}
	}

	abort(reason: LayoutAnalysisErrorReason): void {
		if (this.settled) return;
		this.aborted = true;
		this.settle({ type: "abort", reason });
	}

	get isAborted(): boolean {
		return this.aborted;
	}

	private onSettle:
		| ((e: "ok" | { type?: string; reason?: unknown }) => void)
		| null = null;
	private settleError: { type?: string; reason?: unknown } | null = null;

	emit(p: DocumentAnalysisProgress): void {
		for (const listener of this.progressListeners) listener(p);
	}

	settle(error?: { type?: string; reason?: unknown }): void {
		if (this.settled) return;
		this.settled = true;
		this.settleError = error ?? null;
		if (this.onSettle) this.onSettle(error ?? "ok");
	}
}

/** Shared tail of both remote runners: enrich → merge → sidecar → store. */
async function finalizeRemoteLayoutRegions(args: {
	scope: LayoutAnalysisScope;
	documentId: string;
	options: RunLayoutAnalysisOptions;
	task: RemoteLayoutTask;
	raw: PdfLayoutRegion[];
	pageSizes: Map<number, { width: number; height: number }>;
	totalPages: number;
	backendLabel: string;
	sidecarMode: LayoutSidecarMode;
	cancelClosedDocument: () => void;
}): Promise<void> {
	const { scope, documentId, options, task, pageSizes, totalPages } = args;
	assertDocumentOpen(options.isDocumentOpen);
	setLayoutAnalysisUi(
		{
			stage: "running",
			message: "Merging figures & captions…",
			progress: 99,
			page: totalPages,
			completed: totalPages,
			total: totalPages,
		},
		documentId,
		options.paperAbsPath,
	);

	const extracted = await enrichRawRegionsWithPageText(
		scope,
		args.raw,
		pageSizes,
		options.isDocumentOpen,
	);
	let enriched = extracted.regions;
	const textLayerExtracted = extracted.complete;
	assertDocumentOpen(options.isDocumentOpen);

	let result = buildResultFromRawRegions(documentId, enriched);
	let regions = result.regions;
	for (const pageIndex of pageSizes.keys()) {
		assertDocumentOpen(options.isDocumentOpen);
		const pageSize = pageSizes.get(pageIndex);
		if (!pageSize) continue;
		const need = regions.some(
			(r) => r.pageIndex === pageIndex && r.titleBbox && !r.title?.trim(),
		);
		if (!need) continue;
		try {
			const textRuns = await taskToPromise(scope.getPageTextRuns(pageIndex));
			assertDocumentOpen(options.isDocumentOpen);
			regions = attachTitlesFromTextRuns(
				regions,
				pageIndex,
				textRuns.runs ?? [],
				pageSize,
			);
			result = buildLayoutDocumentResult(documentId, regions, enriched);
		} catch (error) {
			if (
				isLayoutDocumentClosedError(error) ||
				(options.isDocumentOpen && !options.isDocumentOpen())
			) {
				throw new LayoutDocumentClosedError();
			}
			// ignore per-page title failures
		}
	}
	enriched = result.rawRegions;

	try {
		await writeLayoutSidecar(options.paperAbsPath, enriched, args.sidecarMode, {
			textLayerExtracted,
		});
	} catch (e) {
		const message = errorText(e);
		logger.warn("layout sidecar write failed", { error: message });
	}
	try {
		await writeLayoutIndexFromRaw(options.paperAbsPath, enriched);
	} catch (e) {
		const message = errorText(e);
		logger.warn("layout index write failed", { error: message });
	}

	if (options.isDocumentOpen && !options.isDocumentOpen()) {
		args.cancelClosedDocument();
		return;
	}
	setLayoutDocumentResult(result);
	const summary = summarizeLayoutResult(result);
	setLayoutAnalysisUi(
		{ stage: "done", message: summary, total: result.regions.length },
		documentId,
	);
	console.info("[layout-analysis]", {
		documentId,
		summary,
		backend: args.backendLabel,
		regions: result.regions,
	});
	options.onDone?.(summary, result.regions.length);
	task.settle();
}

type RemoteRunDeps = {
	paperAbsPath: string;
	totalPages: number;
	analyzingMessage: string;
	cancelClosedDocument: () => void;
};

/** Only affects the point `rect` when no real page size is known. */
const CLOUD_FALLBACK_PAGE_SIZE = { width: 595, height: 842 };

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(
			...bytes.subarray(offset, offset + chunkSize),
		);
	}
	return btoa(binary);
}

/**
 * Remote provider run: upload the whole PDF once as an async job; the Host
 * polls and streams progress events, then per-page boxes come back in one
 * result — no per-page rendering or requests on our side.
 */
function startRemoteLayoutAnalysis(
	provider: RemoteLayoutProviderDescriptor,
	scope: LayoutAnalysisScope,
	documentId: string,
	options: RunLayoutAnalysisOptions,
	deps: RemoteRunDeps,
): RemoteLayoutTask {
	const task = new RemoteLayoutTask();
	const { paperAbsPath, totalPages, analyzingMessage } = deps;

	void (async () => {
		let unlisten: (() => void) | null = null;
		try {
			assertDocumentOpen(options.isDocumentOpen);
			const pdfPath = await findCanonicalPaperPdfPath(paperAbsPath);
			if (!pdfPath) throw new Error("No local PDF for layout analysis");
			const buffer = await localFileToArrayBuffer(pdfPath);
			if (!buffer) throw new Error("Failed to read paper PDF");
			assertDocumentOpen(options.isDocumentOpen);

			const requestId = `layout-remote-${documentId}`;
			// Host emits job progress (upload → pending/running → download).
			if (isTauri()) {
				unlisten = await events.layoutRemoteProgress.listen((event) => {
					const p = event.payload;
					if (p.requestId && p.requestId !== requestId) return;
					const known =
						typeof p.totalPages === "number" && p.totalPages > 0
							? p.totalPages
							: totalPages;
					const done =
						typeof p.extractedPages === "number" ? p.extractedPages : 0;
					const progress =
						p.phase === "uploading"
							? 3
							: p.phase === "downloading" || p.phase === "done"
								? 96
								: clampProgress(6 + (done / known) * 88);
					setLayoutAnalysisUi(
						{
							stage: "running",
							message: analyzingMessage,
							progress,
							page: Math.min(done + 1, known),
							completed: done,
							total: known,
						},
						documentId,
						paperAbsPath,
					);
				});
			}

			setLayoutAnalysisUi(
				{
					stage: "running",
					message: analyzingMessage,
					progress: 2,
					completed: 0,
					total: totalPages,
				},
				documentId,
				paperAbsPath,
			);
			const res = await invokeLayoutRemoteAnalyzePdf({
				provider: provider.id,
				pdfBase64: arrayBufferToBase64(buffer),
				fileName: pdfPath.split(/[/\\]/).pop() || "paper.pdf",
				requestId,
			});
			unlisten?.();
			unlisten = null;
			assertDocumentOpen(options.isDocumentOpen);
			if (task.isAborted) return;

			const raw: PdfLayoutRegion[] = [];
			const pageSizes = new Map<number, { width: number; height: number }>();
			for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
				const pluginSize = scope.getPageLayout(pageIndex)?.pageSize;
				const injected = options.pageSizeAt?.(pageIndex) ?? null;
				const size =
					pluginSize && pluginSize.width > 0 && pluginSize.height > 0
						? pluginSize
						: injected && injected.width > 0 && injected.height > 0
							? injected
							: CLOUD_FALLBACK_PAGE_SIZE;
				pageSizes.set(pageIndex, size);
				const page = res.pages[pageIndex];
				if (!page) continue;
				raw.push(
					...paddlePageToRegions({
						page,
						pageIndex,
						pageWidth: size.width,
						pageHeight: size.height,
						idPrefix: provider.id,
					}),
				);
			}

			await finalizeRemoteLayoutRegions({
				scope,
				documentId,
				options,
				task,
				raw,
				pageSizes,
				totalPages,
				backendLabel: provider.id,
				sidecarMode: provider.sidecarMode,
				cancelClosedDocument: deps.cancelClosedDocument,
			});
		} catch (error) {
			if (
				isLayoutDocumentClosedError(error) ||
				(options.isDocumentOpen && !options.isDocumentOpen())
			) {
				deps.cancelClosedDocument();
				task.settle({
					type: "abort",
					reason: { type: "no-document", message: "document closed" },
				});
				return;
			}
			const message = errorText(error);
			setLayoutAnalysisUi({ stage: "error", message }, documentId);
			options.onError?.(message, false);
			task.settle({ type: "error", reason: { message } });
		} finally {
			unlisten?.();
		}
	})();

	return task;
}
