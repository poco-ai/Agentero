/**
 * Hidden layout-worker window runtime (`?window=layout-worker`).
 *
 * Runs PP-DocLayoutV3 analysis (PDFium wasm rendering + ONNX inference) in its
 * own WebContent process so an analysis OOM can no longer kill the main
 * window. Requests arrive as Tauri events, progress mirrors the local
 * layoutAnalysisStore, and results go back as events keyed by request id.
 */

import { emit, listen } from "@tauri-apps/api/event";
import { logger } from "@/lib/core/logger";
import { analyzePaperLayoutHeadless } from "@/lib/pdf/layout/headless-analyze";
import { layoutAnalysisStore } from "@/lib/pdf/layout/store";
import { ensureLocalFsScope } from "@/lib/vault";

export const LAYOUT_WORKER_EVENTS = {
	analyze: "layout-worker:analyze",
	cancel: "layout-worker:cancel",
	ready: "layout-worker:ready",
	progress: "layout-worker:progress",
	done: "layout-worker:done",
	failed: "layout-worker:failed",
} as const;

export type LayoutWorkerAnalyzeRequest = {
	requestId: string;
	paperAbsPath: string;
	vaultPath: string | null;
};

export type LayoutWorkerProgress = {
	requestId: string;
	progress: number | null;
	message: string;
	page: number | null;
	total: number | null;
};

export type LayoutWorkerDone = {
	requestId: string;
	summary: string;
	regionCount: number;
};

export type LayoutWorkerFailed = {
	requestId: string;
	error: string;
	cancelled: boolean;
};

const activeRequests = new Map<string, AbortController>();

async function handleAnalyze(request: LayoutWorkerAnalyzeRequest) {
	if (
		!request?.requestId ||
		!request.paperAbsPath ||
		activeRequests.has(request.requestId)
	) {
		return;
	}
	const controller = new AbortController();
	activeRequests.set(request.requestId, controller);
	const unsubscribe = layoutAnalysisStore.subscribe(() => {
		const { ui } = layoutAnalysisStore.getState();
		if (ui.stage !== "running") return;
		void emit(LAYOUT_WORKER_EVENTS.progress, {
			requestId: request.requestId,
			progress: typeof ui.progress === "number" ? ui.progress : null,
			message: ui.message ?? "",
			page: typeof ui.page === "number" ? ui.page : null,
			total: typeof ui.total === "number" ? ui.total : null,
		} satisfies LayoutWorkerProgress);
	});
	try {
		if (request.vaultPath) await ensureLocalFsScope(request.vaultPath);
		const result = await analyzePaperLayoutHeadless({
			paperAbsPath: request.paperAbsPath,
			signal: controller.signal,
		});
		void emit(LAYOUT_WORKER_EVENTS.done, {
			requestId: request.requestId,
			summary: result.summary,
			regionCount: result.regionCount,
		} satisfies LayoutWorkerDone);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void emit(LAYOUT_WORKER_EVENTS.failed, {
			requestId: request.requestId,
			error: message,
			cancelled: controller.signal.aborted || /cancelled/i.test(message),
		} satisfies LayoutWorkerFailed);
	} finally {
		unsubscribe();
		activeRequests.delete(request.requestId);
	}
}

/** Entry point called from main.tsx for the layout-worker window. */
export async function startLayoutWorker(): Promise<void> {
	await listen<LayoutWorkerAnalyzeRequest>(
		LAYOUT_WORKER_EVENTS.analyze,
		(event) => {
			void handleAnalyze(event.payload);
		},
	);
	await listen<{ requestId: string }>(LAYOUT_WORKER_EVENTS.cancel, (event) => {
		activeRequests.get(event.payload?.requestId ?? "")?.abort();
	});
	logger.info("layout worker window ready");
	// Broadcast readiness so a main window waiting on window creation can send.
	await emit(LAYOUT_WORKER_EVENTS.ready, {});
}
