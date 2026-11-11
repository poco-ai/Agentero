// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as ReactI18next from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type PdfLayoutRun,
	type UsePdfLayoutRunOptions,
	usePdfLayoutRun,
} from "@/components/viewer/pdf/hooks/use-pdf-layout-run";
import type {
	LayoutTaskLike,
	RunLayoutAnalysisOptions,
} from "@/lib/pdf/layout/run-analysis";

const mocks = vi.hoisted(() => ({ run: vi.fn(), notify: vi.fn() }));
vi.mock("react-i18next", async (importOriginal) => {
	const actual = await importOriginal<typeof ReactI18next>();
	return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});
vi.mock("@/lib/core/notify", () => ({ notifyError: mocks.notify }));
vi.mock("@/lib/pdf/layout", () => ({
	runDocumentLayoutAnalysis: mocks.run,
	enqueuePaperLayoutAnalysis: vi.fn(),
	getLayoutDocumentResult: vi.fn(),
	layoutAnalysisStore: { getState: () => ({ activeDocumentId: "doc" }) },
	layoutDocumentKey: (id: string) => id,
	readLayoutSidecar: vi.fn(),
	setLayoutAnalysisUi: vi.fn(),
	setLayoutOverlayVisible: vi.fn(),
}));

let root: Root;
let api: PdfLayoutRun;
const pending: Array<{
	options: RunLayoutAnalysisOptions;
	resolve: (task: LayoutTaskLike | null) => void;
}> = [];

function Fixture() {
	const docs = { isDocumentOpen: () => true };
	const capability = { forDocument: () => ({}) };
	api = usePdfLayoutRun({
		docId: "doc",
		paperAbsPath: null,
		paperRelPath: null,
		isActive: false,
		totalPages: 1,
		docCap: docs,
		docCapRef: { current: docs },
		layoutCap: capability,
		layoutCapRef: { current: capability },
	} as unknown as UsePdfLayoutRunOptions);
	return null;
}
function task(): LayoutTaskLike {
	return { abort: vi.fn(), onProgress: vi.fn(), wait: vi.fn() };
}

beforeEach(async () => {
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	pending.length = 0;
	mocks.run.mockImplementation(
		(_scope: unknown, _doc: string, options: RunLayoutAnalysisOptions) => {
			const { promise, resolve } =
				Promise.withResolvers<LayoutTaskLike | null>();
			pending.push({ options, resolve });
			return promise;
		},
	);
	root = createRoot(document.createElement("div"));
	await act(() => root.render(createElement(Fixture)));
});
afterEach(async () => {
	await act(() => root.unmount());
	vi.unstubAllGlobals();
});

describe("layout invocation ownership", () => {
	it("cancels pending acquisition and aborts its late task without a failure toast", async () => {
		const owner = new AbortController();
		api.startLayoutAnalysisRef.current({ signal: owner.signal });
		const acquired = task();
		await act(async () => {
			owner.abort();
			pending[0].options.onError?.("late provider error", false);
			pending[0].resolve(acquired);
		});
		expect(pending[0].options.signal?.aborted).toBe(true);
		expect(acquired.abort).toHaveBeenCalledOnce();
		expect(api.layoutTaskRef.current).toBeNull();
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("does not let old callbacks or reader cancellation clear or abort a newer task", async () => {
		const reader = new AbortController();
		api.startLayoutAnalysisRef.current({ signal: reader.signal });
		api.startLayoutAnalysisRef.current();
		const newest = task();
		await act(async () => pending[1].resolve(newest));
		const stale = task();
		await act(async () => {
			reader.abort();
			pending[0].options.onDone?.("old result", 0);
			pending[0].options.onError?.("old error", false);
			pending[0].resolve(stale);
		});
		expect(stale.abort).toHaveBeenCalledOnce();
		expect(newest.abort).not.toHaveBeenCalled();
		expect(api.layoutTaskRef.current).toBe(newest);
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("removes the caller abort listener when analysis finishes", async () => {
		const owner = new AbortController();
		const remove = vi.spyOn(owner.signal, "removeEventListener");
		api.startLayoutAnalysisRef.current({ signal: owner.signal });
		const acquired = task();
		await act(async () => pending[0].resolve(acquired));
		await act(async () => pending[0].options.onDone?.("done", 1));
		owner.abort();
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(acquired.abort).not.toHaveBeenCalled();
		expect(api.layoutTaskRef.current).toBeNull();
	});
});
