import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { logger } from "@/lib/core/logger";
import { createPdfEngine, disposePdfEngine } from "./engine";

const IDLE_MS = 15_000;
let instance: Promise<PdfEngine> | undefined;
let holders = 0;
let idle: ReturnType<typeof setTimeout> | undefined;

export async function acquireBackgroundPdfEngine(signal?: AbortSignal) {
	signal?.throwIfAborted();
	clearTimeout(idle);
	holders += 1;
	instance ??= createPdfEngine().catch((error: unknown) => {
		instance = undefined;
		throw error;
	});
	const pending = instance;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		holders -= 1;
		if (holders || instance !== pending) return;
		idle = setTimeout(() => {
			if (holders || instance !== pending) return;
			instance = undefined;
			void pending.then((engine) => {
				disposePdfEngine(engine);
				logger.debug("pdf.background.engine released");
			});
		}, IDLE_MS);
	};
	try {
		const engine = await pending;
		signal?.throwIfAborted();
		return { engine, release };
	} catch (error) {
		release();
		throw error;
	}
}

export async function withBackgroundPdfDocument<T>(
	file: Parameters<PdfEngine["openDocumentBuffer"]>[0],
	signal: AbortSignal | undefined,
	run: (engine: PdfEngine, doc: PdfDocumentObject) => Promise<T>,
): Promise<T> {
	const { engine, release } = await acquireBackgroundPdfEngine(signal);
	try {
		const document = await engine.openDocumentBuffer(file).toPromise();
		try {
			signal?.throwIfAborted();
			return await run(engine, document);
		} finally {
			await engine
				.closeDocument(document)
				.toPromise()
				.catch(() => undefined);
		}
	} finally {
		release();
	}
}
