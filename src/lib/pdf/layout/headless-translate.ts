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
 * Viewers subscribe to this execution; opening a translation never restarts it.
 */

import type { PdfDocumentObject } from "@embedpdf/models";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { logger } from "@/lib/core/logger";
import { toVaultRelative } from "@/lib/core/path";
import {
	registerTaskExecutor,
	type TaskExecutorContext,
	type TaskReportArgs,
} from "@/lib/core/tasks";
import {
	findCanonicalPaperPdfPath,
	localFileToArrayBuffer,
} from "@/lib/paper/media";
import {
	assessLayoutReadiness,
	type LayoutCompletenessWarning,
} from "@/lib/pdf/layout/completeness";
import {
	analyzePaperLayoutHeadless,
	getHeadlessPdfEngine,
} from "@/lib/pdf/layout/headless-analyze";
import { readLayoutSidecar } from "@/lib/pdf/layout/io";
import {
	currentLayoutTranslateCacheKey,
	flushLayoutTranslateSidecar,
	hydrateLayoutTranslateItems,
	type LayoutTranslateCacheKey,
	layoutTranslateSidecarPath,
	listTranslatableLayoutRegions,
	persistLayoutTranslateSidecarBestEffort,
	readLayoutTranslateSidecar,
	runLayoutRegionTranslate,
	toLayoutTranslateItems,
} from "@/lib/pdf/layout/layout-translate";
import { createTranslationPublisher } from "@/lib/pdf/layout/translation-job";
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

export type HeadlessTranslateResult = {
	skipped: boolean;
	translated: number;
	total: number;
	pending: number;
	/** Display-ready message when every block failed (empty otherwise). */
	error?: string;
	reason?: string;
};

/** Register the renderer-side `layoutTranslate` executor (before task runtime). */
export function registerLayoutTranslateTaskExecutor(): void {
	registerTaskExecutor("layoutTranslate", runLayoutTranslateExecutor);
}

function isCancelledError(error: unknown): boolean {
	return errorText(error).toLowerCase().includes("cancel");
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

	if (!(await callApiResult(() => commands.jobLayoutTranslateClaim({ jobId }))))
		return;
	const paperKey = toVaultRelative(vaultPath, paperPath);
	const paperAbsPath = joinVaultPath(vaultPath, paperKey);
	const publisher = createTranslationPublisher(report, jobId);

	try {
		const result = await translatePaperLayoutHeadless({
			paperAbsPath,
			paperKey,
			vaultPath,
			jobId,
			signal,
			report: (args) => report(args),
			force: ctx.force,
			onItems: (key, items, layout) => publisher.publish(key, items, layout),
		});
		await publisher.flush();
		if (signal.aborted) {
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
		if (signal.aborted || isCancelledError(error)) {
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
		await publisher.flush();
		publisher.dispose();
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
	force?: boolean;
	onItems?: (
		key: LayoutTranslateCacheKey,
		items: LayoutTranslateItem[],
		layout?: {
			warnings: LayoutCompletenessWarning[];
			pageCount: number | null;
		},
	) => void;
}): Promise<HeadlessTranslateResult> {
	const signal = opts.signal;
	const report = (args: TaskReportArgs) => {
		void Promise.resolve(opts.report(args)).catch(() => undefined);
	};
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

	let layout = await readLayoutSidecar(opts.paperAbsPath);
	signal?.throwIfAborted();
	if (!layout) throw new Error("Layout analysis is missing");
	let readiness = assessLayoutReadiness(layout.source.completeness);
	if (readiness.status === "unknown" || readiness.status === "incomplete") {
		throw new Error("Layout analysis is incomplete");
	}
	if (readiness.needsContentRepair) {
		await analyzePaperLayoutHeadless({
			paperAbsPath: opts.paperAbsPath,
			paperLabel: opts.paperKey ?? undefined,
			documentId: `headless-layout-repair-${opts.jobId}`,
			force: true,
			signal,
		});
		layout = await readLayoutSidecar(opts.paperAbsPath);
		signal?.throwIfAborted();
		if (!layout) throw new Error("Layout analysis is missing");
		readiness = assessLayoutReadiness(layout.source.completeness);
		if (readiness.status === "unknown" || readiness.status === "incomplete") {
			throw new Error("Layout analysis is incomplete");
		}
	}
	const layoutReady = {
		warnings: layout.source.completeness?.warnings ?? [],
		pageCount: layout.source.completeness?.pageCount ?? null,
	};
	const cacheKey = currentLayoutTranslateCacheKey();
	// Raw (pre-merge) detections feed IR extraction and obstacles, exactly like
	// the viewer's `layoutRawRegions`; only the seed items use the filtered set.
	const rawRegions = layout.regions;
	const regions = listTranslatableLayoutRegions(rawRegions);
	if (!regions.length) {
		opts.onItems?.(cacheKey, [], layoutReady);
		return skipped("no translatable regions");
	}

	const pdfPath = await findCanonicalPaperPdfPath(opts.paperAbsPath);
	if (!pdfPath) return skipped("no local PDF");
	const pdfBytes = await localFileToArrayBuffer(pdfPath);
	if (!pdfBytes) throw new Error("Failed to read paper PDF");
	signal?.throwIfAborted();

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
		const previous = new Map(
			hydration.items
				.filter((item) => item.translated?.trim())
				.map((item) => [item.id, item]),
		);
		if (opts.force)
			hydration.items = hydration.items.map((item) => ({
				...item,
				status: "pending",
				error: undefined,
			}));
		opts.onItems?.(cacheKey, hydration.items, layoutReady);
		if (!opts.force && hydration.pendingRequired === 0) {
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
				opts.onItems?.(cacheKey, next, layoutReady);
				// Persist completed blocks for crash recovery while viewers
				// consume the shared in-memory progress.
				persistLayoutTranslateSidecarBestEffort(
					opts.paperAbsPath,
					cacheKey,
					next,
					{ preserveExisting: true },
				);
				const done = countTranslated(next);
				const percent = 5 + Math.floor((85 * done) / Math.max(1, total));
				if (percent <= reported) return;
				reported = percent;
				report({ progress: percent });
			},
		});

		const firstError = items.find(
			(item) => item.status === "error" && item.error,
		);
		// Retain successful prior text when an explicit retranslation fails.
		for (let i = 0; i < items.length; i++) {
			const old = previous.get(items[i].id);
			if (old && !items[i].translated?.trim()) items[i] = old;
		}
		const translated = countTranslated(items);
		const pending = total - translated;
		opts.onItems?.(cacheKey, items, layoutReady);
		await flushLayoutTranslateSidecar(opts.paperAbsPath, cacheKey, items, {
			preserveExisting: true,
		});

		logger.info("pdf.translate.headless", {
			result: "written",
			paper: opts.paperKey,
			path: layoutTranslateSidecarPath(opts.paperAbsPath),
			translated,
			total,
		});

		if (
			!signal?.aborted &&
			loadSettings().translate.cacheReflowFinal &&
			translated > 0
		) {
			await buildFinalCache({
				engine,
				doc,
				items,
				regions: rawRegions,
				pdfBytes,
				paperKey: opts.paperKey,
				paperAbsPath: opts.paperAbsPath,
				signal,
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
	return items.filter(
		(item) => item.status === "done" && item.translated?.trim(),
	).length;
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
	report: (args: TaskReportArgs) => void;
}): Promise<void> {
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
