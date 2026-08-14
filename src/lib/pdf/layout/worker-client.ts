/**
 * Main-window client for the hidden layout-worker window.
 *
 * `runLayoutAnalysisInWorker` ensures the worker webview exists, dispatches
 * one analysis request, relays progress, and resolves on the worker's
 * done/failed events. A stall watchdog covers the isolation scenario this
 * design exists for: if the worker's WebContent process dies mid-run there is
 * no failure event, so silence for too long fails the request instead of
 * hanging the background task forever.
 */

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "@/lib/core/tauri";
import type {
	LayoutWorkerDone,
	LayoutWorkerFailed,
	LayoutWorkerProgress,
} from "@/lib/pdf/layout/worker-window";
import { LAYOUT_WORKER_EVENTS } from "@/lib/pdf/layout/worker-window";

/** No progress event for this long ⇒ assume the worker process died. */
const WORKER_STALL_TIMEOUT_MS = 5 * 60 * 1000;

export class LayoutWorkerCancelledError extends Error {
	constructor() {
		super("cancelled");
		this.name = "LayoutWorkerCancelledError";
	}
}

export function isLayoutWorkerAvailable(): boolean {
	return isTauri();
}

export async function runLayoutAnalysisInWorker(options: {
	paperAbsPath: string;
	vaultPath: string | null;
	signal?: AbortSignal;
	onProgress?: (progress: LayoutWorkerProgress) => void;
}): Promise<{ summary: string; regionCount: number }> {
	await invoke("layout_worker_window_ensure");
	const requestId = crypto.randomUUID();
	const disposers: UnlistenFn[] = [];
	const dispose = () => {
		for (const disposer of disposers.splice(0)) disposer();
	};

	try {
		return await new Promise((resolve, reject) => {
			let stallTimer: ReturnType<typeof setTimeout> | null = null;
			const finish = (fn: () => void) => {
				if (stallTimer !== null) clearTimeout(stallTimer);
				options.signal?.removeEventListener("abort", onAbort);
				fn();
			};
			const armStallTimer = () => {
				if (stallTimer !== null) clearTimeout(stallTimer);
				stallTimer = setTimeout(() => {
					finish(() =>
						reject(
							new Error(
								"layout worker stopped responding (its process may have been terminated)",
							),
						),
					);
				}, WORKER_STALL_TIMEOUT_MS);
			};
			const onAbort = () => {
				void emit(LAYOUT_WORKER_EVENTS.cancel, { requestId });
				finish(() => reject(new LayoutWorkerCancelledError()));
			};
			if (options.signal?.aborted) {
				onAbort();
				return;
			}
			options.signal?.addEventListener("abort", onAbort, { once: true });

			void (async () => {
				disposers.push(
					await listen<LayoutWorkerProgress>(
						LAYOUT_WORKER_EVENTS.progress,
						(event) => {
							if (event.payload.requestId !== requestId) return;
							armStallTimer();
							options.onProgress?.(event.payload);
						},
					),
					await listen<LayoutWorkerDone>(LAYOUT_WORKER_EVENTS.done, (event) => {
						if (event.payload.requestId !== requestId) return;
						finish(() =>
							resolve({
								summary: event.payload.summary,
								regionCount: event.payload.regionCount,
							}),
						);
					}),
					await listen<LayoutWorkerFailed>(
						LAYOUT_WORKER_EVENTS.failed,
						(event) => {
							if (event.payload.requestId !== requestId) return;
							finish(() =>
								reject(
									event.payload.cancelled
										? new LayoutWorkerCancelledError()
										: new Error(event.payload.error),
								),
							);
						},
					),
				);
				armStallTimer();
				await emit(LAYOUT_WORKER_EVENTS.analyze, {
					requestId,
					paperAbsPath: options.paperAbsPath,
					vaultPath: options.vaultPath,
				});
			})().catch((error) => {
				finish(() =>
					reject(error instanceof Error ? error : new Error(String(error))),
				);
			});
		});
	} finally {
		dispose();
	}
}
