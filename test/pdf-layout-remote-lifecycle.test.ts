import type { LayoutAnalysisScope } from "@embedpdf/plugin-layout-analysis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type LayoutTaskLike,
	runDocumentLayoutAnalysis,
} from "@/lib/pdf/layout/run-analysis";

type ProgressEvent = {
	payload: {
		requestId?: string;
		phase: string;
		extractedPages?: number;
		totalPages?: number;
	};
};

const mocks = vi.hoisted(() => ({
	listeners: [] as Array<(event: ProgressEvent) => void>,
	analyze: vi.fn(),
	cancel: vi.fn().mockResolvedValue(undefined),
	ui: vi.fn(),
}));

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/core/bindings", () => ({
	events: {
		layoutRemoteProgress: {
			listen: vi.fn(async (listener: (event: ProgressEvent) => void) => {
				mocks.listeners.push(listener);
				return vi.fn();
			}),
		},
	},
}));
vi.mock("@/lib/paper", () => ({
	findCanonicalPaperPdfPath: vi.fn().mockResolvedValue("/vault/papers/a/a.pdf"),
	localFileToArrayBuffer: vi
		.fn()
		.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
}));
vi.mock("@/lib/pdf/layout/io", () => ({}));
vi.mock("@/lib/pdf/layout/model", () => ({ ensureLayoutModel: vi.fn() }));
vi.mock("@/lib/pdf/layout/store", () => ({
	setLayoutAnalysisUi: mocks.ui,
	setLayoutDocumentResult: vi.fn(),
}));
vi.mock("@/lib/pdf/layout/paddle", () => ({
	invokeLayoutRemoteAnalyzePdf: mocks.analyze,
	invokeLayoutRemoteCancel: mocks.cancel,
	paddlePageToRegions: vi.fn(),
}));
vi.mock("@/lib/settings/store", () => ({
	loadSettings: () => ({ layout: { backend: "mineru" } }),
}));

const tasks: LayoutTaskLike[] = [];
const finish: Array<() => void> = [];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.listeners.length = 0;
	mocks.analyze.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish.push(() => resolve({ pages: [] }));
			}),
	);
});

afterEach(async () => {
	for (const task of tasks.splice(0)) {
		task.abort({ type: "no-document", message: "cancelled" });
	}
	for (const resolve of finish.splice(0)) resolve();
	await Promise.resolve();
});

it("isolates retries from cancelled and unrelated remote progress", async () => {
	const scope = {} as LayoutAnalysisScope;
	const start = async () => {
		const task = await runDocumentLayoutAnalysis(scope, "same-document", {
			paperAbsPath: "/vault/papers/a",
			totalPages: 12,
			force: true,
		});
		expect(task).not.toBeNull();
		tasks.push(task as LayoutTaskLike);
		await vi.waitFor(() =>
			expect(mocks.analyze).toHaveBeenCalledTimes(tasks.length),
		);
		return task as LayoutTaskLike;
	};
	const first = await start();
	const firstId = mocks.analyze.mock.calls[0][0].requestId;
	const firstProgress = mocks.listeners[0];
	first.abort({ type: "no-document", message: "cancelled" });
	expect(mocks.cancel).toHaveBeenCalledWith(firstId);

	await start();
	const secondId = mocks.analyze.mock.calls[1][0].requestId;
	const secondProgress = mocks.listeners[1];
	expect(secondId).not.toBe(firstId);
	expect(mocks.analyze.mock.calls[1][0].pdfBase64).toBe(
		mocks.analyze.mock.calls[0][0].pdfBase64,
	);

	mocks.ui.mockClear();
	firstProgress({ payload: { requestId: firstId, phase: "pending" } });
	secondProgress({ payload: { requestId: firstId, phase: "pending" } });
	secondProgress({ payload: { phase: "pending" } });
	expect(mocks.ui).not.toHaveBeenCalled();

	secondProgress({
		payload: {
			requestId: secondId,
			phase: "running",
			extractedPages: 6,
			totalPages: 12,
		},
	});
	expect(mocks.ui).toHaveBeenCalledWith(
		expect.objectContaining({ progress: 50, completed: 6, total: 12 }),
		"same-document",
		"/vault/papers/a",
	);
});
