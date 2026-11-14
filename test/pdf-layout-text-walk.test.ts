import type { LayoutAnalysisScope } from "@embedpdf/plugin-layout-analysis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDocumentLayoutAnalysis } from "@/lib/pdf/layout/run-analysis";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	backfill: vi.fn().mockResolvedValue(true),
	store: vi.fn(),
}));
vi.mock("@/lib/pdf/layout/io", async (original) => ({
	...(await original<typeof import("@/lib/pdf/layout/io")>()),
	readLayoutSidecar: mocks.read,
	writeLayoutTextBackfill: mocks.backfill,
	writeLayoutIndexFromRaw: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/pdf/layout/store", () => ({
	setLayoutAnalysisUi: vi.fn(),
	setLayoutDocumentResult: mocks.store,
}));
vi.mock("@/lib/pdf/layout/model", () => ({ ensureLayoutModel: vi.fn() }));
vi.mock("@/lib/paper", () => ({}));
vi.mock("@/lib/settings/store", () => ({ loadSettings: vi.fn() }));

describe("cached MinerU caption text walk", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.read.mockResolvedValue({
			schemaVersion: 3,
			source: {
				mode: "mineru-layout",
				generatedAt: "old",
				textLayerExtracted: true,
			},
			regions: [],
		});
	});
	it("reads a caption-only page with no detected boxes using its actual PDF size", async () => {
		const getPageTextRuns = vi.fn(() => ({
			wait: (ok: (value: unknown) => void) =>
				ok({
					runs: [
						{
							text: "Fig. 1 | Caption on a page without model detections.",
							rect: {
								origin: { x: 40, y: 600 },
								size: { width: 240, height: 8 },
							},
						},
					],
				}),
		}));
		const scope = {
			getPageLayout: () => null,
			getPageTextRuns,
		} as unknown as LayoutAnalysisScope;
		await runDocumentLayoutAnalysis(scope, "doc", {
			paperAbsPath: "E:/paper",
			totalPages: 1,
			pageSizeAt: () => ({ width: 600, height: 800 }),
		});
		expect(getPageTextRuns).toHaveBeenCalledWith(0);
		expect(mocks.backfill).toHaveBeenCalledOnce();
		expect(mocks.backfill.mock.calls[0][2]).toEqual([
			expect.objectContaining({
				kind: "figure_title",
				pageIndex: 0,
				bbox: { x: 40 / 600, y: 0.75, w: 0.4, h: 0.01 },
			}),
		]);
	});
	it("does not mark extraction complete when an empty page's size is unavailable", async () => {
		const scope = {
			getPageLayout: () => null,
			getPageTextRuns: vi.fn(),
		} as unknown as LayoutAnalysisScope;
		await runDocumentLayoutAnalysis(scope, "doc", {
			paperAbsPath: "E:/paper",
			totalPages: 1,
		});
		expect(mocks.backfill).not.toHaveBeenCalled();
	});
});
