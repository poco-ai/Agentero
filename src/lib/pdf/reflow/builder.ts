import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { acquireBackgroundPdfEngine } from "@/lib/pdf/background-engine";

export type ReflowBuildTarget = {
	engine: PdfEngine;
	document: PdfDocumentObject;
};

export interface ReflowBuildProvider {
	get(signal?: AbortSignal): Promise<ReflowBuildTarget>;
	idle(): void;
	dispose(): void;
}

/** The worker factory patch exposes its initialization handshake. */
type WorkerPdfEngine = PdfEngine & { whenReady?: unknown };

/**
 * Reflow builds issue dozens of serial PDFium RPCs per page (extract, redact,
 * save, render). On the shared viewer engine those RPCs sit in one FIFO with
 * scroll tiles, so streaming previews starve scrolling (#798, #838). Builds
 * run on the background engine with a private copy of the source document;
 * the shared pair stays as fallback and is never disposed here.
 */
export class ReflowBuildEngine implements ReflowBuildProvider {
	private target: ReflowBuildTarget | null = null;
	private spawning: Promise<ReflowBuildTarget> | null = null;
	private fallback = false;
	private disposed = false;
	private lease: Awaited<ReturnType<typeof acquireBackgroundPdfEngine>> | null =
		null;

	constructor(private readonly shared: ReflowBuildTarget) {}

	/**
	 * Only aborts propagate; a background-engine failure falls back to the
	 * shared pair (previous behavior) instead of failing the translation.
	 */
	async get(signal?: AbortSignal): Promise<ReflowBuildTarget> {
		signal?.throwIfAborted();
		if (this.target) return this.target;
		if (this.fallback || this.disposed) return this.shared;
		if (!this.spawning)
			this.spawning = this.spawn().catch((error) => {
				this.spawning = null;
				throw error;
			});
		try {
			const target = await this.spawning;
			signal?.throwIfAborted();
			return target;
		} catch (error) {
			signal?.throwIfAborted();
			this.fallback = true;
			this.spawning = null;
			logger.warn(
				"Reflow build engine unavailable, sharing the viewer engine",
				{
					error: errorText(error),
				},
			);
			return this.shared;
		}
	}

	private async spawn(): Promise<ReflowBuildTarget> {
		const lease = await acquireBackgroundPdfEngine();
		const { engine } = lease;
		try {
			// A direct engine would run builds synchronously on the main thread,
			// which janks more than sharing the viewer queue. Keep the worker only.
			if (typeof (engine as WorkerPdfEngine).whenReady !== "function")
				throw new Error("Background engine requires worker support");
			if (this.disposed) throw new Error("Reflow build engine disposed");
			const bytes = await this.shared.engine
				.saveAsCopy(this.shared.document)
				.toPromise();
			if (this.disposed) throw new Error("Reflow build engine disposed");
			const document = await engine
				.openDocumentBuffer({
					id: `reflow-source-${crypto.randomUUID()}`,
					content: bytes,
				})
				.toPromise();
			if (this.disposed) {
				await engine.closeDocument(document).toPromise();
				throw new Error("Reflow build engine disposed");
			}
			this.target = { engine, document };
			this.lease = lease;
			return this.target;
		} catch (error) {
			lease.release();
			throw error;
		}
	}

	/** Release the private document once builds settle. */
	idle(): void {
		const target = this.target;
		const lease = this.lease;
		if (!target || !lease) return;
		this.target = null;
		this.lease = null;
		this.spawning = null;
		target.engine
			.closeDocument(target.document)
			.wait(lease.release, lease.release);
	}

	dispose(): void {
		this.disposed = true;
		this.idle();
	}
}
