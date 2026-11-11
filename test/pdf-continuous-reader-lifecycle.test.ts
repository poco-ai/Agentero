// @vitest-environment happy-dom
import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as ReactI18next from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type PdfContinuousReaderState,
	usePdfContinuousReader,
} from "@/components/viewer/pdf/hooks/use-pdf-continuous-reader";
import type * as LayoutTranslate from "@/lib/pdf/layout/layout-translate";
import type { LayoutTranslateSidecar } from "@/lib/pdf/layout/layout-translate";
import {
	layoutAnalysisStore,
	setLayoutAnalysisUi,
} from "@/lib/pdf/layout/store";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";
import type * as ReflowService from "@/lib/pdf/reflow/service";
import { prepareReflowItems } from "@/lib/pdf/reflow/service";

const mocks = vi.hoisted(() => ({
	start: vi.fn(),
	t: (key: string) => key,
	sidecar: null as LayoutTranslateSidecar | null,
	writes: new Set<(paper: string) => void>(),
	extractActual: false,
}));
vi.mock("react-i18next", async (importOriginal) => {
	const actual = await importOriginal<typeof ReactI18next>();
	return {
		...actual,
		useTranslation: () => ({ t: mocks.t, i18n: { language: "en" } }),
	};
});
vi.mock("@/hooks/use-app-stores", () => ({ useSettings: () => null }));
vi.mock("@/lib/pdf/layout/layout-translate", async (importOriginal) => {
	const actual = await importOriginal<typeof LayoutTranslate>();
	return {
		...actual,
		currentLayoutTranslateCacheKey: () => ({
			providerId: "google",
			sourceLang: "en",
			targetLang: "zh",
			serviceKey: "google",
		}),
		readLayoutTranslateSidecar: async () => mocks.sidecar,
		subscribeLayoutTranslateSidecarWrite: (
			listener: (paper: string) => void,
		) => {
			mocks.writes.add(listener);
			return () => mocks.writes.delete(listener);
		},
	};
});
vi.mock("@/lib/pdf/reflow/service", async (importOriginal) => {
	const actual = await importOriginal<typeof ReflowService>();
	return {
		prepareReflowItems: vi.fn(
			(...args: Parameters<typeof actual.prepareReflowItems>) =>
				mocks.extractActual
					? actual.prepareReflowItems(...args)
					: Promise.resolve(args[2]),
		),
	};
});

let root: Root;
let reader: PdfContinuousReaderState;
function Fixture({
	docId = "doc",
	available = true,
	paperAbsPath = null,
	regions = null,
	engineContext,
	translation,
}: {
	docId?: string;
	available?: boolean;
	paperAbsPath?: string | null;
	regions?: PdfLayoutRegion[] | null;
	engineContext?: { engine: PdfEngine; document: PdfDocumentObject };
	translation?: Parameters<typeof usePdfContinuousReader>[0]["translation"];
}) {
	reader = usePdfContinuousReader({
		docId,
		translation,
		available,
		paperAbsPath,
		regions,
		context: () =>
			engineContext ??
			(regions
				? {
						engine: {} as PdfEngine,
						document: {} as PdfDocumentObject,
					}
				: null),
		startAnalysis: mocks.start,
	});
	return null;
}
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	mocks.sidecar = null;
	mocks.writes.clear();
	mocks.extractActual = false;
	layoutAnalysisStore.setState({
		ui: { stage: "idle" },
		activeDocumentId: null,
		activePaperAbsPath: null,
	});
	root = createRoot(document.createElement("div"));
	await act(() => root.render(createElement(Fixture)));
});
afterEach(async () => {
	await act(() => root.unmount());
	vi.unstubAllGlobals();
});

describe("continuous reader analysis ownership", () => {
	it("reuses completed text preparation on mode switches and invalidates it for layout changes, retry and document replacement", async () => {
		const regions: PdfLayoutRegion[] = [];
		await act(() => root.render(createElement(Fixture, { regions })));
		await act(async () => reader.setEnabled(true));
		expect(prepareReflowItems).toHaveBeenCalledTimes(1);
		await act(() => reader.setEnabled(false));
		await act(async () => reader.setEnabled(true));
		expect(prepareReflowItems).toHaveBeenCalledTimes(1);
		expect(reader.preparing).toBe(false);
		await act(async () => root.render(createElement(Fixture, { regions: [] })));
		expect(prepareReflowItems).toHaveBeenCalledTimes(2);
		await act(async () => reader.retryPreparation());
		expect(prepareReflowItems).toHaveBeenCalledTimes(3);
		await act(() =>
			root.render(createElement(Fixture, { docId: "next", regions })),
		);
		await act(async () => reader.setEnabled(true));
		expect(prepareReflowItems).toHaveBeenCalledTimes(4);
	});
	it("restarts interrupted preparation instead of caching its late result", async () => {
		let finish!: (items: []) => void;
		vi.mocked(prepareReflowItems).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await act(() => root.render(createElement(Fixture, { regions: [] })));
		await act(() => reader.setEnabled(true));
		expect(reader.preparing).toBe(true);
		const signal = vi.mocked(prepareReflowItems).mock.calls[0][4];
		await act(() => reader.setEnabled(false));
		expect(signal?.aborted).toBe(true);
		await act(async () => finish([]));
		await act(async () => reader.setEnabled(true));
		expect(prepareReflowItems).toHaveBeenCalledTimes(2);
		expect(reader.preparing).toBe(false);
	});
	it.each([
		true,
		false,
	])("reads uncovered PDF pages with detected regions=%s and leaves empty pages empty", async (hasRegions) => {
		mocks.extractActual = true;
		const texts = ["Detected paragraph", "Previously missing paragraph", ""];
		const document = {
			pages: texts.map((_, index) => ({
				index,
				size: { width: 200, height: 200 },
			})),
		} as PdfDocumentObject;
		const engine = {
			getPageGlyphs: (_doc: unknown, page: { index: number }) => ({
				toPromise: async () =>
					Array.from(texts[page.index], (_, index) => ({
						origin: { x: 10 + index * 5, y: 10 },
						size: { width: 5, height: 10 },
					})),
			}),
			getPageTextRuns: () => ({ toPromise: async () => ({ runs: [] }) }),
			getTextSlices: (
				_doc: unknown,
				slices: { pageIndex: number; charIndex: number }[],
			) => ({
				toPromise: async () =>
					slices.map(({ pageIndex, charIndex }) => texts[pageIndex][charIndex]),
			}),
			renderPageRaw: () => ({
				toPromise: async () => ({
					width: 1,
					height: 1,
					data: new Uint8ClampedArray(4),
				}),
			}),
		} as unknown as PdfEngine;
		const region: PdfLayoutRegion = {
			id: "body",
			pageIndex: 0,
			kind: "text",
			label: "text",
			score: 1,
			readingOrder: 0,
			rect: { x: 10, y: 10, w: 150, h: 20 },
			bbox: { x: 0.05, y: 0.05, w: 0.75, h: 0.1 },
			text: texts[0],
		};
		await act(() =>
			root.render(
				createElement(Fixture, {
					regions: hasRegions ? [region] : [],
					engineContext: { engine, document },
				}),
			),
		);
		await act(async () => reader.setEnabled(true));
		expect(reader.blocks.map((block) => [block.pageIndex, block.text])).toEqual(
			[
				[0, texts[0]],
				[1, texts[1]],
			],
		);
		expect(reader.blocks[1]?.item?.reflow?.origin).toBe("fallback");
		expect(reader.error).toBeNull();
	});
	it("keeps its analysis alive through running updates and aborts it on close", async () => {
		await act(() => reader.setEnabled(true));
		const signal = mocks.start.mock.calls[0][0] as AbortSignal;
		await act(() =>
			setLayoutAnalysisUi({ stage: "running", progress: 10 }, "doc"),
		);
		expect(signal.aborted).toBe(false);
		expect(mocks.start).toHaveBeenCalledOnce();
		await act(() => reader.setEnabled(false));
		expect(signal.aborted).toBe(true);
	});
	it("does not acquire ownership of analysis already running for another consumer", async () => {
		await act(() => setLayoutAnalysisUi({ stage: "running" }, "doc"));
		await act(() => reader.setEnabled(true));
		await act(() => reader.setEnabled(false));
		expect(mocks.start).not.toHaveBeenCalled();
		expect(layoutAnalysisStore.getState().ui.stage).toBe("running");
	});
	it("gives retries fresh ownership and aborts it when the document is replaced", async () => {
		await act(() => reader.setEnabled(true));
		const first = mocks.start.mock.calls[0][0] as AbortSignal;
		await act(() => reader.retryPreparation());
		const retry = mocks.start.mock.calls[1][0] as AbortSignal;
		expect(first.aborted).toBe(true);
		expect(retry.aborted).toBe(false);
		await act(() =>
			root.render(createElement(Fixture, { docId: "replacement" })),
		);
		expect(retry.aborted).toBe(true);
	});
	it("aborts owned analysis when reader availability is removed", async () => {
		await act(() => reader.setEnabled(true));
		const signal = mocks.start.mock.calls[0][0] as AbortSignal;
		await act(() => root.render(createElement(Fixture, { available: false })));
		expect(signal.aborted).toBe(true);
	});
	it("shows translations written by the companion without reopening the reader", async () => {
		const region: PdfLayoutRegion = {
			id: "body",
			pageIndex: 0,
			kind: "text",
			label: "text",
			score: 1,
			readingOrder: 0,
			rect: { x: 10, y: 10, w: 100, h: 30 },
			bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.1 },
			text: "Source paragraph",
		};
		await act(() =>
			root.render(
				createElement(Fixture, {
					paperAbsPath: "/vault/paper",
					regions: [region],
				}),
			),
		);
		await act(async () => reader.setEnabled(true));
		expect(reader.blocks[0]?.translated).toBeUndefined();
		mocks.sidecar = {
			schemaVersion: 2,
			source: {
				mode: "pdf-layout-translate",
				generatedAt: "2026-11-07T00:00:00Z",
				providerId: "google",
				sourceLang: "en",
				targetLang: "zh",
				serviceKey: "google",
			},
			items: [
				{
					id: region.id,
					pageIndex: region.pageIndex,
					bbox: region.bbox,
					kind: region.kind,
					readingOrder: region.readingOrder,
					source: "Source paragraph",
					translated: "译文段落",
				},
			],
		};
		await act(() => {
			for (const write of mocks.writes) write("/vault/other-paper");
		});
		expect(reader.blocks[0]?.translated).toBeUndefined();
		await act(() => {
			for (const write of mocks.writes) write("\\vault\\paper\\");
		});
		expect(reader.blocks[0]?.translated).toBe("译文段落");
	});
});

it("reads shared progress only for the current provider, languages, service and source", async () => {
	const region: PdfLayoutRegion = {
		id: "body",
		pageIndex: 0,
		kind: "text",
		label: "text",
		score: 1,
		readingOrder: 0,
		rect: { x: 10, y: 10, w: 100, h: 30 },
		bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.1 },
		text: "Source paragraph",
	};
	const key = {
		providerId: "google" as const,
		sourceLang: "en",
		targetLang: "zh",
		serviceKey: "google",
	};
	const item = {
		id: region.id,
		pageIndex: 0,
		kind: "text" as const,
		readingOrder: 0,
		bbox: region.bbox,
		source: region.text ?? "",
		translated: "Shared translation",
		status: "done" as const,
	};
	const regions = [region];
	await act(() => root.render(createElement(Fixture, { regions })));
	await act(async () => reader.setEnabled(true));
	for (const cacheKey of [
		{ ...key, providerId: "deepl" as const },
		{ ...key, targetLang: "de" },
		{ ...key, sourceLang: "fr" },
		{ ...key, serviceKey: "another" },
	]) {
		await act(() =>
			root.render(
				createElement(Fixture, {
					regions,
					translation: { cacheKey, items: [item] },
				}),
			),
		);
		expect(reader.blocks[0]?.translated).toBeUndefined();
	}
	await act(() =>
		root.render(
			createElement(Fixture, {
				regions,
				translation: {
					cacheKey: key,
					items: [{ ...item, source: "Stale source" }],
				},
			}),
		),
	);
	expect(reader.blocks[0]?.translated).toBeUndefined();
	await act(() =>
		root.render(
			createElement(Fixture, {
				regions,
				translation: { cacheKey: key, items: [item] },
			}),
		),
	);
	expect(reader.blocks[0]?.translated).toBe("Shared translation");
	expect(reader.hasTranslations).toBe(true);
	expect(mocks.sidecar).toBeNull();
});
