import type { PdfEngine } from "@embedpdf/models";
import {
	createPdfEngine,
	destroyPdfEngine,
	disposePdfEngine,
} from "@/lib/pdf/engine";

/**
 * Stall limit for one formula-engine PDFium call.
 * This is not a budget for the whole of `prepareWrite`.
 */
export const FORMULA_PDF_CALL_STALL_MS = 60_000;

export class FormulaPdfCallStalledError extends Error {
	constructor() {
		super("PDF formula call stalled");
		this.name = "FormulaPdfCallStalledError";
	}
}

export type FormulaCall = <T>(operation: Promise<T>) => Promise<T>;

function abortReason(signal: AbortSignal): unknown {
	return (
		signal.reason ?? new DOMException("The operation was aborted", "AbortError")
	);
}

/**
 * Formula fragments (open, redact, save, close) run on a private PDFium
 * engine. A stalled native redact is destroyed here: `disposePdfEngine`
 * waits for `closeAllDocuments` and cannot recover a hung engine, and the
 * shared reader engine must stay up for other papers.
 */
export async function withFormulaPdfEngine<T>(
	signal: AbortSignal | undefined,
	run: (
		engine: PdfEngine,
		call: FormulaCall,
		alive: () => boolean,
	) => Promise<T>,
): Promise<T> {
	const engine = await createPdfEngine(signal);
	let destroyed = false;
	let failure: unknown;
	const fail = (reason: unknown) => {
		if (destroyed) return;
		destroyed = true;
		failure = reason;
		destroyPdfEngine(engine);
	};
	const active = signal;
	if (active?.aborted) {
		fail(abortReason(active));
		throw failure;
	}
	const onAbort = () => {
		if (active) fail(abortReason(active));
	};
	active?.addEventListener("abort", onAbort);
	const call = <T>(operation: Promise<T>): Promise<T> => {
		if (destroyed || signal?.aborted) {
			if (signal?.aborted) fail(abortReason(signal));
			return Promise.reject(failure);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onCallAbort: (() => void) | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				fail(new FormulaPdfCallStalledError());
				reject(failure);
			}, FORMULA_PDF_CALL_STALL_MS);
		});
		const racers: Array<Promise<T>> = [operation, timeout];
		if (signal) {
			racers.push(
				new Promise<never>((_, reject) => {
					onCallAbort = () => {
						fail(abortReason(signal));
						reject(failure);
					};
					signal.addEventListener("abort", onCallAbort, { once: true });
				}),
			);
		}
		return Promise.race(racers)
			.then((value) => {
				// A late native resolve must not become a successful result.
				if (destroyed) throw failure;
				return value;
			})
			.catch((error: unknown) => {
				throw failure ?? error;
			})
			.finally(() => {
				clearTimeout(timer);
				if (onCallAbort) signal?.removeEventListener("abort", onCallAbort);
			});
	};
	try {
		return await run(engine, call, () => !destroyed);
	} finally {
		active?.removeEventListener("abort", onAbort);
		if (!destroyed) disposePdfEngine(engine);
	}
}
