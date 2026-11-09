/**
 * Headless full-text translation of one paper, driven by the `layoutTranslate`
 * JobCenter job after layout analysis succeeds.
 *
 * Mirrors the viewer's cache-first flow without a viewer: open the paper PDF
 * off-viewer, prepare the reflow IR, hydrate `source/layout-translate.json`,
 * translate only the pending blocks and write the sidecar back. When
 * `translate.cacheReflowFinal` is on, the finished translated PDF is built and
 * stored in the existing build cache so opening the paper reuses it.
 *
 * The renderer executor also owns the takeover lease: when the user starts a
 * manual full-text translation for a paper this job is translating, the viewer
 * aborts the background run and continues from the blocks already written.
 */

import type { PdfDocumentObject } from "@embedpdf/models";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import {
	registerTaskExecutor,
	type TaskExecutorContext,
	type TaskReportArgs,
} from "@/lib/core/tasks";
import {
	findCanonicalPaperPdfPath,
	localFileToArrayBuffer,
} from "@/lib/paper/media";
import { getHeadlessPdfEngine } from "@/lib/pdf/layout/headless-analyze";
import { readLayoutSidecar } from "@/lib/pdf/layout/io";
import {
	currentLayoutTranslateCacheKey,
	hydrateLayoutTranslateItems,
	layoutTranslateSidecarPath,
	listTranslatableLayoutRegions,
	readLayoutTranslateSidecar,
	runLayoutRegionTranslate,
	toLayoutTranslateItems,
	writeLayoutTranslateSidecar,
} from "@/lib/pdf/layout/layout-translate";
import type {
	LayoutTranslateItem,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";
import { createReflowBuildCache } from "@/lib/pdf/reflow/build-cache";
import { createReflowIrCache } from "@/lib/pdf/reflow/cache";
import { buildReflowPdf } from "@/lib/pdf/reflow/export";
import { loadReflowFonts } from "@/lib/pdf/reflow/fonts";
import {
	prepareReflowItems,
	reflowDocumentFromItems,
} from "@/lib/pdf/reflow/service";
import { loadSettings } from "@/lib/settings";
import { displayTranslateError } from "@/lib/translate/errors";
import { joinVaultPath } from "@/lib/vault";

/** Bound on waiting for an aborted background run to flush before takeover. */
const TAKEOVER_FLUSH_TIMEOUT_MS = 5_000;

export type HeadlessTranslateResult = {
	skipped: boolean;
	translated: number;
	total: number;
	pending: number;
	/** Display-ready message when every block failed (empty otherwise). */
	error?: string;
	reason?: string;
};

/** Paper-folder key shared with the viewer so cache lookups line up. */
function normalizePaperKey(
	paperPath: string | null | undefined,
): string | null {
	const key = (paperPath ?? "")
		.trim()
		.replace(/[/\\]+$/, "")
		.replace(/\\/g, "/");
	return key || null;
}

/** In-flight background translations, keyed by the normalized paper path. */
type ActiveTranslate = { abortAndFlush: () => Promise<void> };
const activeTranslates = new Map<string, ActiveTranslate>();

/**
 * Stop an in-flight background translation of this paper and resolve once it
 * stopped writing. Returns null when this renderer has no such run (the job is
 * queued elsewhere, or belongs to another window), so the caller can fall back
 * to cancelling the JobCenter row.
 */
export function takeOverHeadlessLayoutTranslate(
	paperPath: string | null | undefined,
): Promise<void> | null {
	const key = normalizePaperKey(paperPath);
	if (!key) return null;
	const active = activeTranslates.get(key);
	return active ? active.abortAndFlush() : null;
}

/** Register the renderer-side `layoutTranslate` executor (before task runtime). */
export function registerLayoutTranslateTaskExecutor(): void {
	registerTaskExecutor("layoutTranslate", runLayoutTranslateExecutor);
}

function isCancelledError(error: unknown): boolean {
	return errorText(error).toLowerCase().includes("cancel");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLayoutTranslateExecutor(
	ctx: TaskExecutorContext,
): Promise<void> {
	const { jobId, vaultPath, paperPath, signal } = ctx;
	const report = (args: TaskReportArgs) =>
		ctx.report(args).catch((error) => {
			logger.warn("layout translate job report failed", {
				jobId,
				error: errorText(error),
			});
		});
	if (!paperPath) {
		await report({ progress: 100, state: "succeeded" });
		return;
	}

	const paperAbsPath = joinVaultPath(vaultPath, paperPath);
	const key = normalizePaperKey(paperPath);
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });

	let takenOver = false;
	let resolveFinished: () => void = () => undefined;
	const finishedPromise = new Promise<void>((resolve) => {
		resolveFinished = resolve;
	});
	const lease: ActiveTranslate | null = key
		? {
				abortAndFlush: async () => {
					takenOver = true;
					controller.abort();
					await Promise.race([
						finishedPromise,
						delay(TAKEOVER_FLUSH_TIMEOUT_MS),
					]);
				},
			}
		: null;
	if (key && lease) activeTranslates.set(key, lease);

	try {
		const result = await translatePaperLayoutHeadless({
			paperAbsPath,
			paperKey: paperPath,
			vaultPath,
			jobId,
			signal: controller.signal,
			report: (args) => report(args),
			shouldPersist: () => !takenOver,
		});
		if (takenOver) {
			await report({ state: "cancelled" });
			return;
		}
		if (result.error) {
			await report({ state: "failed", error: result.error });
			return;
		}
		await report({
			progress: 100,
			phase:
				result.pending > 0 ? `${result.translated}/${result.total}` : undefined,
			state: "succeeded",
		});
	} catch (error) {
		if (takenOver) {
			await report({ state: "cancelled" });
			return;
		}
		if (controller.signal.aborted || isCancelledError(error)) {
			await report({ state: "cancelled" });
			return;
		}
		logger.warn("layout translate job failed", {
			jobId,
			paperAbsPath,
			error: errorText(error),
		});
		await report({
			state: "failed",
			error: displayTranslateError(errorText(error)),
		});
	} finally {
		resolveFinished();
		if (key && activeTranslates.get(key) === lease) {
			activeTranslates.delete(key);
		}
		signal.removeEventListener("abort", abort);
	}
}

/**
 * Translate the pending layout blocks of one paper. Returns `skipped` when
 * there is nothing to do (no PDF, no layout, no translatable text, or a
 * complete cache), which the executor reports as success without an error.
 */
export async function translatePaperLayoutHeadless(opts: {
	paperAbsPath: string;
	/** Vault-relative paper folder, shared with the viewer's cache identity. */
	paperKey: string | null;
	vaultPath: string | null;
	jobId: string;
	signal?: AbortSignal;
	report: (args: TaskReportArgs) => Promise<void> | void;
	/** False once a viewer took the paper over: do not write caches. */
	shouldPersist?: () => boolean;
}): Promise<HeadlessTranslateResult> {
	const signal = opts.signal;
	const report = (args: TaskReportArgs) => {
		void Promise.resolve(opts.report(args)).catch(() => undefined);
	};
	const shouldPersist = opts.shouldPersist ?? (() => true);
	signal?.throwIfAborted();

	const skipped = (
		reason: string,
		translated = 0,
		pending = 0,
	): HeadlessTranslateResult => {
		logger.info("pdf.translate.headless", {
			result: "skipped",
			reason,
			paper: opts.paperKey,
		});
		return {
			skipped: true,
			translated,
			total: translated + pending,
			pending,
			reason,
		};
	};

	const layout = await readLayoutSidecar(opts.paperAbsPath);
	signal?.throwIfAborted();
	if (!layout?.regions?.length) return skipped("no layout");
	// Raw (pre-merge) detections feed IR extraction and obstacles, exactly like
	// the viewer's `layoutRawRegions`; only the seed items use the filtered set.
	const rawRegions = layout.regions;
	const regions = listTranslatableLayoutRegions(rawRegions);
	if (!regions.length) return skipped("no translatable regions");

	const pdfPath = await findCanonicalPaperPdfPath(opts.paperAbsPath);
	if (!pdfPath) return skipped("no local PDF");
	const pdfBytes = await localFileToArrayBuffer(pdfPath);
	if (!pdfBytes) throw new Error("Failed to read paper PDF");
	signal?.throwIfAborted();

	const cacheKey = currentLayoutTranslateCacheKey();
	const sidecar = await readLayoutTranslateSidecar(opts.paperAbsPath, cacheKey);
	signal?.throwIfAborted();

	const seedItems = toLayoutTranslateItems(regions);
	const engine = await getHeadlessPdfEngine();
	const documentId = `headless-layout-translate-${opts.jobId}`;
	const doc: PdfDocumentObject = await engine
		.openDocumentBuffer({ id: documentId, content: pdfBytes.slice(0) })
		.toPromise();
	try {
		report({ progress: 2 });
		const irCache = createReflowIrCache(
			{
				paperKey: opts.paperKey,
				paperAbsPath: opts.paperAbsPath,
				pdfBytes,
				items: seedItems,
				regions: rawRegions,
			},
			{ writesEnabled: () => loadSettings().translate.cacheReflowIr },
		);
		const prepared = await prepareReflowItems(
			engine,
			doc,
			seedItems,
			rawRegions,
			signal,
			irCache,
		);
		signal?.throwIfAborted();
		const hydration = hydrateLayoutTranslateItems(prepared, sidecar, {
			requireReflowSentencePairs: true,
		});
		const total = hydration.items.length;
		if (hydration.pendingRequired === 0) {
			// Complete sidecar: the job is a no-op, no rewrite and no PDF build.
			report({ progress: 100 });
			return skipped("complete cache", total, 0);
		}

		report({ progress: 5 });
		let reported = 5;
		const items = await runLayoutRegionTranslate({
			items: hydration.items,
			signal,
			paperKey: opts.paperKey,
			vaultPath: opts.vaultPath,
			onUpdate: (next) => {
				const done = countTranslated(next);
				const percent = 5 + Math.floor((85 * done) / Math.max(1, total));
				if (percent <= reported) return;
				reported = percent;
				report({ progress: percent });
			},
		});
		const translated = countTranslated(items);
		const pending = total - translated;
		const firstError = items.find(
			(item) => item.status === "error" && item.error,
		);

		if (!shouldPersist()) {
			// A viewer took over; it owns the sidecar and the page build now.
			logger.info("pdf.translate.headless", {
				result: "taken-over",
				paper: opts.paperKey,
				translated,
			});
			return {
				skipped: false,
				translated,
				total,
				pending,
			};
		}
		await writeLayoutTranslateSidecar(opts.paperAbsPath, cacheKey, items);
		logger.info("pdf.translate.headless", {
			result: "written",
			paper: opts.paperKey,
			path: layoutTranslateSidecarPath(opts.paperAbsPath),
			translated,
			total,
		});

		if (loadSettings().translate.cacheReflowFinal && translated > 0) {
			await buildFinalCache({
				engine,
				doc,
				items,
				regions: rawRegions,
				pdfBytes,
				paperKey: opts.paperKey,
				paperAbsPath: opts.paperAbsPath,
				signal,
				shouldPersist,
				report,
			});
		}

		return {
			skipped: false,
			translated,
			total,
			pending,
			error:
				translated === 0 && firstError?.error
					? displayTranslateError(firstError.error)
					: undefined,
		};
	} finally {
		await engine
			.closeDocument(doc)
			.toPromise()
			.catch(() => undefined);
	}
}

function countTranslated(items: readonly LayoutTranslateItem[]): number {
	return items.filter((item) => item.translated?.trim()).length;
}

/**
 * Build and persist the translated PDF through the same content-keyed cache the
 * viewer uses. Best effort: a failed build only slows the next open down.
 */
async function buildFinalCache(opts: {
	engine: Awaited<ReturnType<typeof getHeadlessPdfEngine>>;
	doc: PdfDocumentObject;
	items: readonly LayoutTranslateItem[];
	regions: readonly PdfLayoutRegion[];
	pdfBytes: ArrayBuffer;
	paperKey: string | null;
	paperAbsPath: string;
	signal?: AbortSignal;
	shouldPersist: () => boolean;
	report: (args: TaskReportArgs) => void;
}): Promise<void> {
	if (!opts.shouldPersist()) return;
	opts.signal?.throwIfAborted();
	const run = async (): Promise<void> => {
		const fonts = await loadReflowFonts();
		opts.signal?.throwIfAborted();
		const ir = reflowDocumentFromItems(opts.doc, opts.items, opts.regions);
		const translations = new Map(
			opts.items
				.filter((item) => item.status === "done" && item.translated?.trim())
				.map((item) => [item.id, item.translated?.trim() ?? ""]),
		);
		if (translations.size === 0) return;
		const cache = createReflowBuildCache(
			{ paperKey: opts.paperKey, pdfBytes: opts.pdfBytes },
			{ writesEnabled: () => loadSettings().translate.cacheReflowFinal },
		);
		const cached = await cache.readFinal(ir, translations, fonts);
		opts.signal?.throwIfAborted();
		if (cached) {
			logger.info("pdf.translate.headless", { result: "pdf-cache-hit" });
			return;
		}
		if (!opts.shouldPersist()) return;
		const built = await buildReflowPdf(
			opts.engine,
			opts.doc,
			ir,
			translations,
			fonts,
			opts.signal,
			true,
			(ratio) => opts.report({ progress: 90 + Math.round(9 * ratio) }),
		);
		opts.signal?.throwIfAborted();
		if (!opts.shouldPersist()) return;
		await cache.writeFinal(ir, translations, fonts, built.bytes);
		logger.info("pdf.translate.headless", {
			result: "pdf-cached",
			bytes: built.bytes.byteLength,
		});
	};
	try {
		await run();
	} catch (error) {
		if (opts.signal?.aborted) throw error;
		logger.warn("layout translate final PDF failed", {
			paperAbsPath: opts.paperAbsPath,
			error: errorText(error),
		});
	}
}
