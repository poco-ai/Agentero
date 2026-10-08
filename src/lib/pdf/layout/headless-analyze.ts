/**
 * Headless layout analysis: open a paper PDF off-viewer, run PP-DocLayoutV3,
 * write `{paper}/source/layout.json`. Used after download/import so sidecar is
 * ready before the user opens the paper.
 */

import { PluginRegistry } from "@embedpdf/core";
import type { PdfEngine } from "@embedpdf/models";
import { AiManagerPluginPackage } from "@embedpdf/plugin-ai-manager";
import type { DocumentManagerCapability } from "@embedpdf/plugin-document-manager";
import { DocumentManagerPluginPackage } from "@embedpdf/plugin-document-manager";
import {
	type LayoutAnalysisCapability,
	LayoutAnalysisPluginPackage,
} from "@embedpdf/plugin-layout-analysis";
import { RenderPluginPackage } from "@embedpdf/plugin-render";
import { errorText } from "@/lib/core/error";

import { logger } from "@/lib/core/logger";
import { findCanonicalPaperPdfPath, localFileToArrayBuffer } from "@/lib/paper";
import { getPdfAiRuntime } from "@/lib/pdf/layout/ai-runtime";
import {
	layoutSidecarBlocksAnalysis,
	readLayoutSidecar,
	writeLayoutIndexFromRaw,
} from "@/lib/pdf/layout/io";
import type { LayoutTaskLike } from "@/lib/pdf/layout/run-analysis";
import { runDocumentLayoutAnalysis } from "@/lib/pdf/layout/run-analysis";
import { clearLayoutDocumentResult } from "@/lib/pdf/layout/store";
import { loadSystemCjkFontFallback } from "@/lib/pdf/system-font-fallback";

function taskToPromise<T>(task: {
	wait: (ok: (v: T) => void, err: (e: unknown) => void) => void;
}): Promise<T> {
	return new Promise((resolve, reject) => {
		task.wait(resolve, reject);
	});
}

let analysisEngine: PdfEngine | null = null;
let analysisEnginePromise: Promise<PdfEngine> | null = null;

export async function getHeadlessPdfEngine(): Promise<PdfEngine> {
	if (analysisEngine) return analysisEngine;
	if (analysisEnginePromise) return analysisEnginePromise;
	const pending = (async () => {
		const fontFallback = await loadSystemCjkFontFallback();
		// Prefer worker engine (same as the app viewer).
		try {
			const pdfiumWasmUrl = (await import("@embedpdf/pdfium/pdfium.wasm?url"))
				.default;
			const abs =
				typeof document !== "undefined"
					? new URL(pdfiumWasmUrl, document.baseURI).href
					: pdfiumWasmUrl;
			const { createPdfiumEngine } = await import(
				"@embedpdf/engines/pdfium-worker-engine"
			);
			const created = createPdfiumEngine(abs, {
				fontFallback,
			});
			const engine = (
				created instanceof Promise ? await created : created
			) as PdfEngine & {
				whenReady?: () => { toPromise(): Promise<unknown> };
			};
			const ready = engine.whenReady?.();
			if (ready) {
				await Promise.race([
					ready.toPromise(),
					new Promise<never>((_, reject) => {
						setTimeout(() => reject(new Error("worker ready timeout")), 8000);
					}),
				]);
			}
			analysisEngine = engine;
			return engine;
		} catch (e) {
			logger.warn("headless layout: worker engine failed, using direct", {
				error: errorText(e),
			});
			const pdfiumWasmUrl = (await import("@embedpdf/pdfium/pdfium.wasm?url"))
				.default;
			const { createPdfiumEngine } = await import(
				"@embedpdf/engines/pdfium-direct-engine"
			);
			const created = createPdfiumEngine(pdfiumWasmUrl, {
				fontFallback,
			});
			const engine = (
				created instanceof Promise ? await created : created
			) as PdfEngine;
			analysisEngine = engine;
			return engine;
		}
	})();
	analysisEnginePromise = pending;
	try {
		return await pending;
	} finally {
		if (analysisEnginePromise === pending) analysisEnginePromise = null;
	}
}

export type HeadlessLayoutResult = {
	fromCache: boolean;
	summary: string;
	regionCount: number;
};

/**
 * Ensure layout sidecar exists for a paper folder. Hits cache when present
 * unless `force` is set. Opens `{paper}/{id}.pdf` only — never an
 * illustration PDF under `source/assets/`.
 */
export async function analyzePaperLayoutHeadless(opts: {
	paperAbsPath: string;
	/** Label shown in the background-task toast instead of "Analyzing layout…". */
	paperLabel?: string;
	/** Caller-owned EmbedPDF document id, so progress can be attributed to this run. */
	documentId?: string;
	/**
	 * Re-run even when `source/layout.json` already has regions. JobCenter
	 * stores this on the task; it has to be read here or a force enqueue
	 * still returns the cached sidecar.
	 */
	force?: boolean;
	signal?: AbortSignal;
}): Promise<HeadlessLayoutResult> {
	const paperAbsPath = opts.paperAbsPath.replace(/[/\\]+$/, "");
	if (opts.signal?.aborted) throw new Error("cancelled");

	const existing = await readLayoutSidecar(paperAbsPath);
	if (opts.signal?.aborted) throw new Error("cancelled");
	if (
		existing &&
		layoutSidecarBlocksAnalysis(opts.force, existing.regions.length)
	) {
		// Ensure CLI-facing sidebar index exists even on raw-only cache hits.
		try {
			if (opts.signal?.aborted) throw new Error("cancelled");
			await writeLayoutIndexFromRaw(paperAbsPath, existing.regions);
		} catch (error) {
			if (opts.signal?.aborted || errorText(error) === "cancelled") {
				throw new Error("cancelled");
			}
			// non-fatal
		}
		return {
			fromCache: true,
			summary: `cached ${existing.regions.length} regions`,
			regionCount: existing.regions.length,
		};
	}

	const pdfPath = await findCanonicalPaperPdfPath(paperAbsPath);
	if (!pdfPath) {
		// Soft-skip: callers may race ahead of DownloadAssets. Re-enqueue after
		// the PDF lands rather than failing the job with "No local PDF".
		return {
			fromCache: false,
			summary: "skipped: no local PDF",
			regionCount: 0,
		};
	}
	const buffer = await localFileToArrayBuffer(pdfPath);
	if (!buffer) {
		throw new Error("Failed to read paper PDF");
	}
	if (opts.signal?.aborted) throw new Error("cancelled");

	const engine = await getHeadlessPdfEngine();
	const documentId =
		opts.documentId ?? `headless-layout-${Date.now().toString(36)}`;
	const registry = new PluginRegistry(engine);
	registry.registerPlugin(DocumentManagerPluginPackage, {});
	registry.registerPlugin(RenderPluginPackage);
	registry.registerPlugin(AiManagerPluginPackage, {
		runtime: getPdfAiRuntime(),
	});
	registry.registerPlugin(LayoutAnalysisPluginPackage, {
		layoutThreshold: 0.3,
		tableStructure: false,
		autoAnalyze: false,
		renderScale: 2,
	});

	try {
		await registry.initialize();
		await registry.pluginsReady();
		if (opts.signal?.aborted) throw new Error("cancelled");

		const docPlugin = registry.getPlugin("document-manager");
		const layoutPlugin = registry.getPlugin("layout-analysis");
		if (!docPlugin || !layoutPlugin) {
			throw new Error("Layout plugins failed to register");
		}
		const docCap = (
			docPlugin as unknown as { provides: () => DocumentManagerCapability }
		).provides();
		const layoutCap = (
			layoutPlugin as unknown as { provides: () => LayoutAnalysisCapability }
		).provides();

		const openRes = await taskToPromise(
			docCap.openDocumentBuffer({
				buffer,
				documentId,
				name: "layout-analysis",
				autoActivate: true,
			}),
		);
		const doc = await taskToPromise(openRes.task);
		const pageCount = doc.pageCount ?? 0;
		if (opts.signal?.aborted) throw new Error("cancelled");

		const scope = layoutCap.forDocument(documentId);
		const summary = await new Promise<string>((resolve, reject) => {
			let settled = false;
			let layoutTask: LayoutTaskLike | null = null;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				opts.signal?.removeEventListener("abort", onAbort);
				fn();
			};
			function onAbort() {
				layoutTask?.abort({ type: "no-document", message: "cancelled" });
				layoutTask = null;
				finish(() => reject(new Error("cancelled")));
			}
			opts.signal?.addEventListener("abort", onAbort);
			void runDocumentLayoutAnalysis(scope, documentId, {
				paperAbsPath,
				paperLabel: opts.paperLabel,
				totalPages: pageCount > 0 ? pageCount : null,
				force: opts.force === true,
				pageSizeAt: (pageIndex) => {
					const size = doc.pages[pageIndex]?.size;
					return size && size.width > 0 && size.height > 0 ? size : null;
				},
				isDocumentOpen: () => docCap.isDocumentOpen(documentId),
				onDone: (s) => finish(() => resolve(s)),
				onError: (message, aborted) => {
					finish(() => {
						if (aborted) reject(new Error("cancelled"));
						else reject(new Error(message));
					});
				},
			})
				.then((task) => {
					layoutTask = task;
					// Cache path: onDone already fired before null return.
					if (task == null && !settled) {
						finish(() => resolve("cached"));
					} else if (task && opts.signal?.aborted) {
						onAbort();
					}
				})
				.catch((e) =>
					finish(() => reject(e instanceof Error ? e : new Error(String(e)))),
				);
		});

		const sidecar = await readLayoutSidecar(paperAbsPath);
		return {
			fromCache: false,
			summary,
			regionCount: sidecar?.regions?.length ?? 0,
		};
	} finally {
		try {
			const docPlugin = registry.getPlugin("document-manager");
			if (docPlugin) {
				const docCap = (
					docPlugin as unknown as {
						provides: () => DocumentManagerCapability;
					}
				).provides();
				await taskToPromise(docCap.closeDocument(documentId)).catch(
					() => undefined,
				);
			}
		} catch {
			// ignore close errors
		}
		try {
			await registry.destroy();
		} catch {
			// ignore
		}
		clearLayoutDocumentResult(documentId);
	}
}
