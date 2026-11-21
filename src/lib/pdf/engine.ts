import { ignore, type PdfEngine } from "@embedpdf/models";
import pdfiumWasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { loadSystemCjkFontFallback } from "@/lib/pdf/system-font-fallback";

/** The worker factory patch exposes its initialization handshake. */
type WorkerPdfEngine = PdfEngine & {
	whenReady(): { toPromise(): Promise<unknown> };
};

const WORKER_READY_TIMEOUT_MS = 8000;
let workerEngineUsable = true;

/** A failed startup must not queue closeDocument behind an unresolved handshake. */
export function destroyPdfEngine(engine: PdfEngine): void {
	engine.destroy?.().wait(ignore, ignore);
}

/** Close live documents before terminating a ready engine. */
export function disposePdfEngine(engine: PdfEngine): void {
	engine.closeAllDocuments().wait(
		() => destroyPdfEngine(engine),
		() => destroyPdfEngine(engine),
	);
}

async function waitWorkerReady(
	engine: WorkerPdfEngine,
	signal?: AbortSignal,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		signal?.throwIfAborted();
		await Promise.race([
			engine.whenReady().toPromise(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("PDF worker initialization timed out")),
					WORKER_READY_TIMEOUT_MS,
				);
				onAbort = () => reject(signal?.reason);
				signal?.addEventListener("abort", onAbort, { once: true });
			}),
		]);
		signal?.throwIfAborted();
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

/** Shared startup policy; the viewer and background analysis own separate engines. */
export async function createPdfEngine(
	signal?: AbortSignal,
): Promise<PdfEngine> {
	signal?.throwIfAborted();
	const fontFallback = await loadSystemCjkFontFallback();
	signal?.throwIfAborted();
	if (workerEngineUsable) {
		let worker: PdfEngine | undefined;
		try {
			const { createPdfiumEngine } = await import(
				"@embedpdf/engines/pdfium-worker-engine"
			);
			signal?.throwIfAborted();
			const wasmUrl =
				typeof document === "undefined"
					? pdfiumWasmUrl
					: new URL(pdfiumWasmUrl, document.baseURI).href;
			worker = createPdfiumEngine(wasmUrl, {
				fontFallback,
				encoderPoolSize: 1,
			});
			await waitWorkerReady(worker as WorkerPdfEngine, signal);
			return worker;
		} catch (error) {
			if (worker) destroyPdfEngine(worker);
			// An unmounted consumer says nothing about this webview's worker support.
			signal?.throwIfAborted();
			workerEngineUsable = false;
			logger.warn("PDF worker unavailable, using direct engine", {
				error: errorText(error),
			});
		}
	}
	const { createPdfiumEngine } = await import(
		"@embedpdf/engines/pdfium-direct-engine"
	);
	signal?.throwIfAborted();
	const engine = await createPdfiumEngine(pdfiumWasmUrl, {
		fontFallback,
		encoderPoolSize: 1,
	});
	if (signal?.aborted) {
		destroyPdfEngine(engine);
		signal.throwIfAborted();
	}
	return engine;
}
