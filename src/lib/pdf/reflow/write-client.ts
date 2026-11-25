import { logger } from "@/lib/core/logger";
import type { ReflowWriteTimings } from "./pdf-write";
import {
	executeWriteJob,
	type WriteFonts,
	type WriteJob,
	type WriteRequest,
	type WriteResponse,
	type WriteResults,
} from "./write-job";

const IDLE_MS = 30_000;
const JOB_TIMEOUT_MS = 180_000;
type JobResult = {
	value: WriteResults[keyof WriteResults];
	timings: ReflowWriteTimings;
};
type JobOptions = {
	fonts?: WriteFonts;
	signal?: AbortSignal;
	onProgress?: (ratio: number) => void;
};

let worker: Worker | undefined;
let workerFonts: WriteFonts | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
let busy = false;
const queue: Array<() => Promise<void>> = [];

function terminate(target: Worker) {
	target.terminate();
	if (worker !== target) return;
	worker = undefined;
	workerFonts = undefined;
	logger.debug("pdf.reflow.worker stopped");
}

async function drain() {
	if (busy) return;
	clearTimeout(idle);
	busy = true;
	try {
		for (let next = queue.shift(); next; next = queue.shift()) await next();
	} finally {
		busy = false;
		if (worker) {
			const target = worker;
			idle = setTimeout(() => terminate(target), IDLE_MS);
		}
	}
}

function dispatch(
	job: WriteJob,
	{ fonts, signal, onProgress }: JobOptions,
): Promise<JobResult> {
	return new Promise((resolve, reject) => {
		if (!worker) {
			worker = new Worker(new URL("./write.worker.ts", import.meta.url), {
				type: "module",
			});
			logger.debug("pdf.reflow.worker started");
		}
		const target = worker;
		const fail = (error: unknown) => {
			cleanup();
			terminate(target);
			reject(error);
		};
		const abort = () => fail(signal?.reason);
		const timeout = setTimeout(
			() => fail(new Error("PDF reflow worker timed out")),
			JOB_TIMEOUT_MS,
		);
		const cleanup = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			target.onmessage = null;
			target.onerror = null;
			target.onmessageerror = null;
		};
		signal?.addEventListener("abort", abort, { once: true });
		target.onmessage = ({ data }: MessageEvent<WriteResponse>) => {
			if ("progress" in data) {
				onProgress?.(data.progress);
				return;
			}
			cleanup();
			if ("error" in data) reject(new Error(data.error));
			else resolve(data);
		};
		target.onerror = (event) =>
			fail(new Error(event.message || "PDF reflow worker failed"));
		target.onmessageerror = () =>
			fail(new Error("Could not read PDF reflow worker result"));
		try {
			const request: WriteRequest = {
				job,
				fonts: fonts !== workerFonts ? fonts : undefined,
			};
			const transfer: Transferable[] = [];
			if (job.kind === "write") {
				transfer.push(job.redacted.buffer);
				if (job.formulaSource) transfer.push(job.formulaSource.buffer);
			}
			target.postMessage(request, transfer);
			if (fonts) workerFonts = fonts;
		} catch (error) {
			fail(error);
		}
	});
}

export function runReflowWorker<Job extends WriteJob>(
	job: Job,
	options: JobOptions = {},
): Promise<WriteResults[Job["kind"]]> {
	const { signal } = options;
	const queuedAt = performance.now();
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted();
		const abortQueued = () => {
			const index = queue.indexOf(run);
			if (index !== -1) queue.splice(index, 1);
			reject(signal?.reason);
		};
		const run = async () => {
			signal?.removeEventListener("abort", abortQueued);
			const started = performance.now();
			try {
				signal?.throwIfAborted();
				const inline =
					typeof Worker === "undefined" && typeof window === "undefined";
				const timings: ReflowWriteTimings = {};
				const result = inline
					? {
							value: await executeWriteJob(
								job,
								options.fonts,
								timings,
								options.onProgress,
							),
							timings,
						}
					: await dispatch(job, options);
				signal?.throwIfAborted();
				logger.info("pdf.reflow.write", {
					kind: job.kind,
					worker: !inline,
					queue_ms: Math.round(started - queuedAt),
					duration_ms: Math.round(performance.now() - started),
					layout_ms:
						result.timings.layoutMs === undefined
							? undefined
							: Math.round(result.timings.layoutMs),
					save_ms:
						result.timings.saveMs === undefined
							? undefined
							: Math.round(result.timings.saveMs),
				});
				resolve(result.value as WriteResults[Job["kind"]]);
			} catch (error) {
				reject(error);
			}
		};
		signal?.addEventListener("abort", abortQueued, { once: true });
		queue.push(run);
		void drain();
	});
}
