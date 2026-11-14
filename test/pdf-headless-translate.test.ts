import { beforeEach, expect, it, vi } from "vitest";
import type { TaskExecutorContext } from "@/lib/core/tasks";
import {
	registerLayoutTranslateTaskExecutor,
	translatePaperLayoutHeadless,
} from "@/lib/pdf/layout/headless-translate";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";

const mocks = vi.hoisted(() => ({
	sidecar: null as unknown,
	run: vi.fn(),
	flush: vi.fn(),
	progress: vi.fn(),
	claim: vi.fn(),
	executor: null as ((ctx: TaskExecutorContext) => Promise<void>) | null,
	open: vi.fn(),
	close: vi.fn(),
	layoutCompleteness: null as unknown,
}));
vi.mock("@/lib/core/bindings", () => ({
	commands: { jobLayoutTranslateClaim: mocks.claim },
}));
vi.mock("@/lib/core/ipc", () => ({
	callApiResult: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/core/tasks", () => ({
	registerTaskExecutor: (_kind: string, executor: typeof mocks.executor) => {
		mocks.executor = executor;
	},
}));
vi.mock("@/lib/pdf/layout/headless-analyze", () => ({
	getHeadlessPdfEngine: async () => ({
		openDocumentBuffer: () => ({ toPromise: mocks.open }),
		closeDocument: () => ({ toPromise: mocks.close }),
	}),
}));
vi.mock("@/lib/paper/media", () => ({
	findCanonicalPaperPdfPath: async () => "/vault/papers/a/a.pdf",
	localFileToArrayBuffer: async () => new ArrayBuffer(1),
}));
vi.mock("@/lib/pdf/layout/io", () => ({
	readLayoutSidecar: async () => ({
		source: { completeness: mocks.layoutCompleteness },
		regions: [0, 1].map((pageIndex) => ({
			id: `p${pageIndex}`,
			kind: "text",
			label: "text",
			score: 1,
			pageIndex,
			readingOrder: pageIndex,
			text: `Source ${pageIndex}`,
			bbox: { x: 0, y: 0, w: 1, h: 1 },
			rect: { x: 0, y: 0, w: 100, h: 100 },
		})),
	}),
}));
vi.mock("@/lib/settings", () => ({
	loadSettings: () => ({
		translate: {
			provider: "tencenttransmart",
			sourceLang: "en",
			targetLang: "zh-CN",
			providerConfigs: {},
			customPrompt: "",
			customSystem: "",
			customUser: "",
			cacheReflowIr: false,
			cacheReflowFinal: false,
		},
	}),
}));
vi.mock("@/lib/vault", () => ({
	joinVaultPath: (a: string, b: string) => `${a}/${b}`,
}));
vi.mock("@/lib/pdf/reflow/service", () => ({
	prepareReflowItems: async (
		_engine: unknown,
		_doc: unknown,
		items: LayoutTranslateItem[],
	) => items,
}));
vi.mock("@/lib/pdf/reflow/cache", () => ({ createReflowIrCache: () => ({}) }));
vi.mock("@/lib/pdf/layout/layout-translate", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/pdf/layout/layout-translate")
	>()),
	readLayoutTranslateSidecar: async () => mocks.sidecar,
	flushLayoutTranslateSidecar: mocks.flush,
	persistLayoutTranslateSidecarBestEffort: mocks.progress,
	runLayoutRegionTranslate: mocks.run,
}));
const request = (patch = {}) => ({
	paperAbsPath: "/vault/papers/a",
	paperKey: "papers/a",
	vaultPath: "/vault",
	jobId: "test",
	report: vi.fn(),
	...patch,
});
const cached = (pages: number[]) => ({
	items: pages.map((page) => ({
		id: `p${page}`,
		source: `Source ${page}`,
		translated: `Cached ${page}`,
	})),
});
beforeEach(() => {
	mocks.sidecar = null;
	mocks.layoutCompleteness = {
		pageCount: 2,
		processedPages: [0, 1],
		textLayerComplete: true,
		pageStats: [0, 1].map((pageIndex) => ({
			pageIndex,
			regionCount: 1,
			textChars: 100,
			translatableRegionCount: 1,
		})),
		warnings: [],
		contentRepairAttempted: true,
	};
	mocks.open.mockReset().mockResolvedValue({ id: "doc", pageCount: 2 });
	mocks.close.mockReset().mockResolvedValue(undefined);
	mocks.claim.mockReset().mockResolvedValue(true);
	mocks.flush.mockReset().mockResolvedValue(undefined);
	mocks.progress.mockReset();
	mocks.run.mockReset().mockImplementation(async ({ items, onUpdate }) => {
		const final = items.map((item: LayoutTranslateItem) =>
			item.status === "done"
				? item
				: { ...item, status: "done", translated: "New" },
		);
		onUpdate(final);
		return final;
	});
});

it("continues only missing blocks and publishes existing translations before requesting", async () => {
	mocks.sidecar = cached([0]);
	const onItems = vi.fn();
	const result = await translatePaperLayoutHeadless(request({ onItems }));
	expect(onItems.mock.calls[0][1][0].translated).toBe("Cached 0");
	expect(
		mocks.run.mock.calls[0][0].items.map(
			(item: LayoutTranslateItem) => item.status,
		),
	).toEqual(["done", "pending"]);
	expect(result.pending).toBe(0);
	expect(mocks.flush).toHaveBeenCalledWith(
		"/vault/papers/a",
		expect.anything(),
		expect.arrayContaining([
			expect.objectContaining({ translated: "Cached 0" }),
		]),
		{ preserveExisting: true },
	);
});

it("refuses to translate from a structurally incomplete layout", async () => {
	mocks.layoutCompleteness = {
		...(mocks.layoutCompleteness as object),
		textLayerComplete: false,
	};
	await expect(translatePaperLayoutHeadless(request())).rejects.toThrow(
		"Layout analysis is incomplete",
	);
	expect(mocks.run).not.toHaveBeenCalled();
});

it("passes content-gap warnings to the shared viewer snapshot", async () => {
	mocks.layoutCompleteness = {
		...(mocks.layoutCompleteness as object),
		warnings: [{ code: "content-gap", pages: [1] }],
	};
	const onItems = vi.fn();
	await translatePaperLayoutHeadless(request({ onItems }));
	expect(onItems.mock.calls[0][2]).toEqual({
		warnings: [{ code: "content-gap", pages: [1] }],
		pageCount: 2,
	});
});

it("publishes a complete cache without requesting translations or rewriting it", async () => {
	mocks.sidecar = cached([0, 1]);
	const onItems = vi.fn();
	const result = await translatePaperLayoutHeadless(request({ onItems }));
	expect(result.skipped).toBe(true);
	expect(onItems.mock.calls[0][1]).toHaveLength(2);
	expect(mocks.run).not.toHaveBeenCalled();
	expect(mocks.flush).not.toHaveBeenCalled();
	expect(mocks.close).toHaveBeenCalledTimes(1);
});

it("an explicit retranslation keeps prior successful text when a block fails", async () => {
	mocks.sidecar = cached([0, 1]);
	mocks.run.mockImplementation(async ({ items }) =>
		items.map((item: LayoutTranslateItem) => ({
			...item,
			status: "error",
			translated: undefined,
			error: "failed",
		})),
	);
	const result = await translatePaperLayoutHeadless(request({ force: true }));
	expect(
		mocks.run.mock.calls[0][0].items.every(
			(item: LayoutTranslateItem) => item.status === "pending",
		),
	).toBe(true);
	expect(result.pending).toBe(0);
	expect(result.translated).toBe(2);
	expect(
		mocks.flush.mock.calls[0][2].map(
			(item: LayoutTranslateItem) => item.translated,
		),
	).toEqual(["Cached 0", "Cached 1"]);
});

it("only the Host-selected window executes a broadcast translation offer", async () => {
	registerLayoutTranslateTaskExecutor();
	mocks.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
	const ctx = {
		jobId: "owned-job",
		vaultPath: "/vault",
		paperPath: "papers/a",
		force: false,
		signal: new AbortController().signal,
		report: vi.fn().mockResolvedValue(undefined),
	} as unknown as TaskExecutorContext;
	await mocks.executor?.(ctx);
	await mocks.executor?.(ctx);
	expect(mocks.open).toHaveBeenCalledTimes(1);
	expect(mocks.run).toHaveBeenCalledTimes(1);
	const reports = vi.mocked(ctx.report).mock.calls.map(([report]) => report);
	const terminal = reports.findIndex((report) => report.state === "succeeded");
	const progress = reports.findIndex((report) => report.params);
	expect(progress).toBeGreaterThanOrEqual(0);
	expect(terminal).toBeGreaterThan(progress);
});

it("retranslation progress excludes cached text whose replacement is still pending", async () => {
	mocks.sidecar = cached([0, 1]);
	const report = vi.fn();
	mocks.run.mockImplementation(async ({ items, onUpdate }) => {
		onUpdate(items);
		return items.map((item: LayoutTranslateItem) => ({
			...item,
			status: "done",
			translated: "Replacement",
		}));
	});
	await translatePaperLayoutHeadless(request({ force: true, report }));
	expect(
		report.mock.calls.map(([args]) => args.progress).filter(Boolean),
	).toEqual([2, 5]);
});
