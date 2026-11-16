import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";
import {
	buildReflowPage,
	buildReflowPdf,
	type ReflowOutput,
	replaceReflowPages,
} from "@/lib/pdf/reflow/export";
import { paragraphFromCharacters } from "@/lib/pdf/reflow/extract";
import { reflowOutputVersion } from "@/lib/pdf/reflow/output-version";
import {
	isRasterAllocationError,
	previewRasterScale,
	ReflowPreviewSession,
} from "@/lib/pdf/reflow/preview";
import type { ReflowDocument } from "@/lib/pdf/reflow/types";

vi.mock("@/lib/core/logger", () => ({
	logOp: (_name: string, _fields: unknown, run: () => Promise<unknown>) =>
		run(),
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/pdf/reflow/fonts", () => ({
	loadReflowFonts: vi.fn(async () => ({})),
}));
vi.mock("@/lib/pdf/reflow/export", () => ({
	buildReflowPage: vi.fn(),
	buildReflowPdf: vi.fn(),
	replaceReflowPages: vi.fn(async () => new Uint8Array([3, 4])),
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
function item(
	pageIndex: number,
	status: LayoutTranslateItem["status"] = "done",
): LayoutTranslateItem {
	return {
		id: `p${pageIndex}`,
		pageIndex,
		status,
		kind: "text",
		readingOrder: 0,
		source: "original",
		raw: "original",
		translated: status === "done" ? "translated" : undefined,
		bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 },
		reflow: paragraphFromCharacters(
			`p${pageIndex}`,
			pageIndex,
			{ x: 10, y: 10, w: 80, h: 20 },
			[],
			[],
			false,
		),
	};
}
function result(ir: ReflowDocument): ReflowOutput {
	return {
		bytes: new Uint8Array([1, 2]),
		pages: ir.pages.map((page) => ({
			index: page.index,
			width: page.width,
			height: page.height,
			paragraphs: page.paragraphs.map((p) => ({
				id: p.id,
				pageIndex: p.pageIndex,
				sourceBox: p.box,
				box: p.box,
				scale: 1,
				units: [],
				fits: true,
			})),
		})),
	};
}
const document = {
	id: "source",
	pages: Array.from({ length: 3 }, (_, index) => ({
		index,
		size: { width: 100, height: 100 },
	})),
} as PdfDocumentObject;
const render = vi.fn(() => ({ toPromise: async () => new Blob(["preview"]) }));
const close = vi.fn(() => ({ toPromise: async () => true }));
const engine = {
	openDocumentBuffer: vi.fn(() => ({ toPromise: async () => document })),
	renderPage: render,
	closeDocument: close,
} as unknown as PdfEngine;
let session: ReflowPreviewSession;
const failed = vi.fn();
beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(URL, "createObjectURL").mockImplementation(
		() => `blob:${crypto.randomUUID()}`,
	);
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	vi.mocked(buildReflowPage).mockImplementation(async (_engine, _doc, ir) =>
		result(ir),
	);
	vi.mocked(buildReflowPdf).mockImplementation(async (_engine, _doc, ir) =>
		result(ir),
	);
	session = new ReflowPreviewSession(engine, document, () => {}, failed);
});
afterEach(() => {
	session.dispose();
	vi.restoreAllMocks();
});
const settled = () => vi.waitFor(() => expect(session.busy).toBe(false));

it("caps preview bitmap memory and recognizes allocation failures", () => {
	const a4 = { width: 595.276, height: 841.89 };
	const scale = previewRasterScale(a4, 2);
	const bytes = a4.width * a4.height * (scale * 2) ** 2 * 4;
	expect(bytes).toBeLessThanOrEqual(16 * 1024 * 1024 + 1024);
	expect(previewRasterScale({ width: 100, height: 100 }, 2)).toBe(2);
	expect(
		isRasterAllocationError(new Error("Failed to allocate 32076832 bytes")),
	).toBe(true);
	expect(
		isRasterAllocationError({
			code: 1,
			message: "Error: Failed to allocate 32076832 bytes",
		}),
	).toBe(true);
	expect(isRasterAllocationError(new Error("bad page"))).toBe(false);
});

it("retries a preview render at a smaller scale when wasm cannot allocate", async () => {
	const first = item(0);
	render.mockImplementationOnce(() => ({
		toPromise: async () => {
			throw new Error("Failed to allocate 32076832 bytes");
		},
	}));
	session.update([first], [], true);
	await settled();
	expect(render).toHaveBeenCalledTimes(2);
	const initial = render.mock.calls[0]?.[2] as { scaleFactor: number };
	const retry = render.mock.calls[1]?.[2] as { scaleFactor: number };
	expect(retry.scaleFactor).toBeLessThan(initial.scaleFactor);
	expect(session.decorate([first])[0]?.reflowPreview).toBeTruthy();
	expect(failed).not.toHaveBeenCalled();
});

it("reports final build work and resets progress when that output is superseded", async () => {
	const gate = deferred<ReflowOutput>();
	vi.mocked(buildReflowPdf).mockImplementationOnce(
		async (
			_engine,
			_doc,
			ir,
			_translations,
			_fonts,
			_signal,
			_commonScale,
			report,
		) => {
			report?.(0.5);
			await gate.promise;
			return result(ir);
		},
	);
	const first = item(0);
	session.update([first], [], false);
	await vi.waitFor(() => expect(session.progress).toBe(0.4));
	expect(session.output).toBeNull();
	gate.resolve(result(vi.mocked(buildReflowPdf).mock.calls[0][2]));
	await settled();
	expect(session.progress).toBe(1);
	session.update(
		[{ ...first, status: "pending", translated: undefined }],
		[],
		true,
	);
	expect(session.progress).toBe(0);
});

it("publishes a finished page during translation and preserves it across other batches", async () => {
	const first = item(0),
		second = item(1, "pending");
	session.update([first, second], [], true);
	await settled();
	const url = session.decorate([first])[0].reflowPreview;
	expect(url).toBeTruthy();
	expect(session.decorate([second])[0].reflowPreview).toBeUndefined();
	expect(session.output).toBeNull();
	session.update([{ ...first }, { ...second, status: "running" }], [], true);
	await settled();
	expect(session.decorate([first])[0].reflowPreview).toBe(url);
	expect(buildReflowPage).toHaveBeenCalledTimes(1);
	expect(buildReflowPdf).not.toHaveBeenCalled();
});

it("builds the final cached PDF while untranslated blocks remain pending", async () => {
	const cached = item(0);
	const missing = { ...item(0, "pending"), id: "missing" };
	session.update([cached, missing], [], false);
	await settled();
	expect(buildReflowPdf).toHaveBeenCalledTimes(1);
	const call = vi.mocked(buildReflowPdf).mock.calls[0];
	expect(call[2].pages[0].paragraphs).toHaveLength(2);
	expect([...call[3].entries()]).toEqual([[cached.id, cached.translated]]);
	expect(session.output).toEqual(new Uint8Array([1, 2]));
	expect(buildReflowPage).not.toHaveBeenCalled();
	expect(failed).not.toHaveBeenCalled();
});

it("waits for the entire page and retains failed IR paragraphs as obstacles", async () => {
	const first = item(0),
		pending = { ...item(0, "pending"), id: "other" };
	session.update([first, pending], [], true);
	await settled();
	expect(buildReflowPage).not.toHaveBeenCalled();
	session.update([first, { ...pending, status: "error" }], [], true);
	await settled();
	const call = vi.mocked(buildReflowPage).mock.calls[0];
	expect(call[2].pages[0].paragraphs).toHaveLength(2);
	expect([...call[3].keys()]).toEqual([first.id]);
});

it("keeps an in-flight page alive when another page changes and serializes builders", async () => {
	const first = item(0),
		second = item(1, "pending"),
		gate = deferred<ReflowOutput>();
	vi.mocked(buildReflowPage).mockReturnValueOnce(gate.promise);
	session.update([first, second], [], true);
	await vi.waitFor(() => expect(buildReflowPage).toHaveBeenCalledTimes(1));
	session.update(
		[first, { ...second, status: "done", translated: "next" }],
		[],
		true,
	);
	expect(vi.mocked(buildReflowPage).mock.calls[0][5]?.aborted).toBe(false);
	expect(buildReflowPage).toHaveBeenCalledTimes(1);
	gate.resolve(result(vi.mocked(buildReflowPage).mock.calls[0][2]));
	await settled();
	expect(buildReflowPage).toHaveBeenCalledTimes(2);
	expect(session.decorate([first, second]).every((i) => i.reflowPreview)).toBe(
		true,
	);
});

it("discards superseded page results and retains the last preview on retry", async () => {
	const first = item(0),
		gate = deferred<ReflowOutput>();
	vi.mocked(buildReflowPage).mockReturnValueOnce(gate.promise);
	session.update([first], [], true);
	await vi.waitFor(() => expect(buildReflowPage).toHaveBeenCalledTimes(1));
	session.update([{ ...first, translated: "replacement" }], [], true);
	expect(vi.mocked(buildReflowPage).mock.calls[0][5]?.aborted).toBe(true);
	gate.resolve(result(vi.mocked(buildReflowPage).mock.calls[0][2]));
	await settled();
	expect(render).toHaveBeenCalledTimes(1);
	const url = session.decorate([first])[0].reflowPreview;
	session.update(
		[{ ...first, status: "running", translated: undefined }],
		[],
		true,
	);
	expect(session.decorate([first])[0].reflowPreview).toBe(url);
	expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(url);
});

it("finalizes the whole PDF while rendering only changed layouts", async () => {
	const items = [item(0), item(1)];
	session.update(items, [], true);
	await settled();
	const urls = session.decorate(items).map((i) => i.reflowPreview);
	vi.mocked(buildReflowPdf).mockImplementationOnce(async (_e, _d, ir) => {
		const built = result(ir);
		built.pages[1].paragraphs[0].scale = 0.85;
		return built;
	});
	session.update(items, [], false);
	expect(session.output).toBeNull();
	await settled();
	expect(render).toHaveBeenCalledTimes(3);
	expect(session.decorate(items)[0].reflowPreview).toBe(urls[0]);
	expect(session.decorate(items)[1].reflowPreview).not.toBe(urls[1]);
	expect(session.output).toEqual(new Uint8Array([1, 2]));
	session.update(
		items.map((i) => ({ ...i })),
		[],
		false,
	);
	await settled();
	expect(buildReflowPdf).toHaveBeenCalledTimes(1);
});

it("publishes each final page before the remaining pages finish rendering", async () => {
	const gate = deferred<Blob>(),
		items = [item(0), item(1)];
	render.mockImplementationOnce(() => ({ toPromise: async () => new Blob() }));
	render.mockImplementationOnce(() => ({ toPromise: () => gate.promise }));
	session.update(items, [], false);
	await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
	expect(session.decorate(items)[0].reflowPreview).toBeTruthy();
	expect(session.decorate(items)[1].reflowPreview).toBeUndefined();
	expect(session.output).toBeNull();
	gate.resolve(new Blob());
	await settled();
	expect(session.output).not.toBeNull();
});

it("keeps obsolete display bytes unavailable for export and ignores a late result after disposal", async () => {
	const items = [item(0)];
	session.update(items, [], false);
	await settled();
	const url = session.decorate(items)[0].reflowPreview;
	const gate = deferred<ReflowOutput>();
	vi.mocked(buildReflowPdf).mockReturnValueOnce(gate.promise);
	const previous = session.output;
	session.update([{ ...items[0], translated: "new" }], [], false);
	expect(session.output).toBe(previous);
	expect(session.ready).toBe(false);
	await vi.waitFor(() => expect(buildReflowPdf).toHaveBeenCalledTimes(2));
	session.dispose();
	gate.resolve(result(vi.mocked(buildReflowPdf).mock.calls[1][2]));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(render).toHaveBeenCalledTimes(1);
	expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
	expect(session.output).toBeNull();
	expect(failed).not.toHaveBeenCalled();
});

it("continues other pages after a build failure without retrying every batch", async () => {
	vi.mocked(buildReflowPage).mockRejectedValueOnce(new Error("bad page"));
	const items = [item(0), item(1)];
	session.update(items, [], true);
	await settled();
	expect(failed).toHaveBeenCalledTimes(1);
	expect(session.decorate(items)[1].reflowPreview).toBeTruthy();
	session.update(items, [], true);
	await settled();
	expect(buildReflowPage).toHaveBeenCalledTimes(2);
});

it("invalidates a page when its IR changes even if the translated text is unchanged", async () => {
	const original = item(0);
	session.update([original], [], true);
	await settled();
	const url = session.decorate([original])[0].reflowPreview;
	const changed = item(0);
	if (!changed.reflow) throw new Error("Missing fixture IR");
	changed.reflow = { ...changed.reflow, box: { x: 15, y: 10, w: 80, h: 20 } };
	session.update([changed], [], true);
	await settled();
	expect(buildReflowPage).toHaveBeenCalledTimes(2);
	expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
	expect(session.decorate([changed])[0].reflowPreview).not.toBe(url);
});

it("closes a preview document and suppresses late images when cleared during rendering", async () => {
	const gate = deferred<Blob>(),
		first = item(0);
	render.mockImplementationOnce(() => ({ toPromise: () => gate.promise }));
	session.update([first], [], true);
	await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
	session.update([], [], false);
	gate.resolve(new Blob());
	await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
	expect(URL.createObjectURL).not.toHaveBeenCalled();
	expect(session.output).toBeNull();
	expect(failed).not.toHaveBeenCalled();
	// The same content is eligible again after a user clears and restarts it.
	session.update([first], [], true);
	await settled();
	expect(session.decorate([first])[0].reflowPreview).toBeTruthy();
});

it("routes builds and preview renders through the dedicated build engine", async () => {
	const dedicatedRender = vi.fn(() => ({
		toPromise: async () => new Blob(["preview"]),
	}));
	const dedicated = {
		openDocumentBuffer: vi.fn(() => ({ toPromise: async () => document })),
		renderPage: dedicatedRender,
		closeDocument: close,
	} as unknown as PdfEngine;
	const ownDoc = { id: "own" } as PdfDocumentObject;
	const provider = {
		get: vi.fn(async () => ({ engine: dedicated, document: ownDoc })),
		idle: vi.fn(),
		dispose: vi.fn(),
	};
	session = new ReflowPreviewSession(
		engine,
		document,
		() => {},
		failed,
		provider,
	);
	session.update([item(0)], [], true);
	await settled();
	expect(provider.get).toHaveBeenCalled();
	const call = vi.mocked(buildReflowPage).mock.calls[0];
	expect(call[0]).toBe(dedicated);
	expect(call[1]).toBe(ownDoc);
	expect(dedicated.openDocumentBuffer).toHaveBeenCalledTimes(1);
	expect(dedicatedRender).toHaveBeenCalledTimes(1);
	// The viewer engine stays untouched by the whole build.
	expect(engine.openDocumentBuffer).not.toHaveBeenCalled();
	session.dispose();
	expect(provider.dispose).toHaveBeenCalled();
});

it("releases the build engine once the queue drains", async () => {
	const provider = {
		get: vi.fn(async () => ({ engine, document })),
		idle: vi.fn(),
		dispose: vi.fn(),
	};
	session = new ReflowPreviewSession(
		engine,
		document,
		() => {},
		failed,
		provider,
	);
	vi.useFakeTimers();
	try {
		session.update([item(0)], [], true);
		// Drain the serial queue with microtasks only; fake timers never fire.
		for (let i = 0; i < 50 && session.busy; i++) await Promise.resolve();
		expect(provider.idle).not.toHaveBeenCalled();
		vi.advanceTimersByTime(30_000);
		expect(provider.idle).toHaveBeenCalledTimes(1);
		// Restarting a translation cancels a pending release; a settled queue
		// schedules a fresh one.
		session.update([item(1)], [], true);
		for (let i = 0; i < 50 && session.busy; i++) await Promise.resolve();
		session.update([item(1)], [], true);
		vi.advanceTimersByTime(30_000);
		expect(provider.idle).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});

it("keeps the build engine alive when a rebuild starts before the idle deadline", async () => {
	const provider = {
		get: vi.fn(async () => ({ engine, document })),
		idle: vi.fn(),
		dispose: vi.fn(),
	};
	session = new ReflowPreviewSession(
		engine,
		document,
		() => {},
		failed,
		provider,
	);
	vi.useFakeTimers();
	try {
		session.update([item(0)], [], false);
		for (let i = 0; i < 50 && session.busy; i++) await Promise.resolve();
		// The first build finished; the release deadline is armed (30s).
		const gate = deferred<ReflowOutput>();
		vi.mocked(buildReflowPdf).mockImplementationOnce(
			async (_engine, _doc, ir) => {
				await gate.promise;
				return result(ir);
			},
		);
		// A hide-one-page style rebuild enqueues a new final key inside the
		// deadline window. Releasing the engine now would leave every
		// in-flight PDFium RPC unsettled and wedge the serial queue.
		session.update([{ ...item(0), translated: "changed" }], [], false);
		for (let i = 0; i < 200 && session.busy !== true; i++)
			await Promise.resolve();
		vi.advanceTimersByTime(30_000);
		expect(provider.idle).not.toHaveBeenCalled();
		expect(session.busy).toBe(true);
		const ir = vi.mocked(buildReflowPdf).mock.calls.at(-1)?.[2];
		if (!ir) throw new Error("final build was not invoked");
		gate.resolve(result(ir));
		for (let i = 0; i < 200 && session.busy; i++) await Promise.resolve();
		expect(session.busy).toBe(false);
		// Once the queue drains again the deadline is re-armed and fires.
		vi.advanceTimersByTime(30_000);
		expect(provider.idle).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});

it("keeps other pages and the old display while completing only one page", async () => {
	const first = item(0);
	const second = item(1);
	const missing = { ...item(1, "error"), id: "missing" };
	const initial = [first, second, missing];
	session.update(initial, [], false);
	await settled();
	const output = session.output;
	const urls = session.decorate(initial).map((i) => i.reflowPreview);
	if (!output) throw new Error("Initial output missing");
	const retry = [first, second, { ...missing, status: "running" as const }];
	session.update(retry, [], true);
	await settled();
	expect(session.output).toBe(output);
	expect(session.ready).toBe(false);
	expect(session.decorate(retry).map((i) => i.reflowPreview)).toEqual(urls);
	expect(buildReflowPage).not.toHaveBeenCalled();
	const completed = [
		first,
		second,
		{ ...missing, status: "done" as const, translated: "filled" },
	];
	const gate = deferred<ReflowOutput>();
	vi.mocked(buildReflowPdf).mockReturnValueOnce(gate.promise);
	session.update(completed, [], false);
	await vi.waitFor(() => expect(buildReflowPdf).toHaveBeenCalledTimes(2));
	expect(session.output).toBe(output);
	expect(session.decorate(completed)[0].reflowPreview).toBe(urls[0]);
	const call = vi.mocked(buildReflowPdf).mock.calls[1];
	expect(call[2].pages.map((page) => page.index)).toEqual([1]);
	expect(call[6]).toBe(false);
	gate.resolve(result(call[2]));
	await settled();
	expect(replaceReflowPages).toHaveBeenCalledWith(
		output,
		new Uint8Array([1, 2]),
		[1],
	);
	expect(session.ready).toBe(true);
	const decorated = session.decorate(completed);
	expect(decorated[0].reflowPreview).toBe(urls[0]);
	expect(decorated[1].reflowPreview).not.toBe(urls[1]);
	if (!session.output) throw new Error("Updated output missing");
	expect(
		decorated[0].reflowPreviewSources?.has(reflowOutputVersion(output)),
	).toBe(true);
	expect(
		decorated[1].reflowPreviewSources?.has(reflowOutputVersion(output)),
	).toBe(false);
	expect(
		decorated[0].reflowPreviewSources?.has(reflowOutputVersion(session.output)),
	).toBe(true);
	expect(
		decorated[1].reflowPreviewSources?.has(reflowOutputVersion(session.output)),
	).toBe(true);
	expect(render).toHaveBeenCalledTimes(3);
	expect(failed).not.toHaveBeenCalled();
});

it("does not rebuild completed pages when preparation returns equivalent IR objects", async () => {
	const items = [item(0), item(1)];
	session.update(items, [], false);
	await settled();
	const output = session.output;
	const copied = structuredClone(items);
	session.update(copied, [], true);
	await settled();
	session.update(copied, [], false);
	await settled();
	expect(buildReflowPage).not.toHaveBeenCalled();
	expect(buildReflowPdf).toHaveBeenCalledTimes(1);
	expect(session.output).toBe(output);
	expect(session.ready).toBe(true);
});

it("keeps glyph IR out of update keys while translation batches reuse it", async () => {
	const first = item(0);
	if (!first.reflow) throw new Error("Missing paragraph IR");
	const serialize = vi.fn(() => []);
	Object.defineProperty(first.reflow.characters, "toJSON", {
		value: serialize,
	});
	session.update([first], [], false);
	await settled();
	for (let index = 0; index < 10; index++) {
		session.update([{ ...first, progress: index / 10 }], [], false);
	}
	await settled();
	expect(serialize).not.toHaveBeenCalled();
	expect(buildReflowPdf).toHaveBeenCalledTimes(1);
	expect(session.ready).toBe(true);
});

it("rebuilds only the changed page when rehydrated IR has different geometry", async () => {
	const items = [item(0), item(1)];
	session.update(items, [], false);
	await settled();
	const copied = structuredClone(items);
	if (!copied[1].reflow) throw new Error("Missing paragraph IR");
	copied[1].reflow.box.y += 10;
	session.update(copied, [], false);
	await settled();
	expect(buildReflowPdf).toHaveBeenCalledTimes(2);
	expect(
		vi.mocked(buildReflowPdf).mock.calls[1][2].pages.map((page) => page.index),
	).toEqual([1]);
	expect(session.ready).toBe(true);
});

it("keeps old page previews until replacement succeeds and survives a failed build", async () => {
	const items = [item(0), item(1)];
	session.update(items, [], false);
	await settled();
	const output = session.output;
	const urls = session.decorate(items).map((i) => i.reflowPreview);
	vi.mocked(buildReflowPdf).mockRejectedValueOnce(new Error("page failed"));
	session.update([items[0], { ...items[1], translated: "changed" }], [], false);
	await settled();
	expect(session.output).toBe(output);
	expect(session.decorate(items).map((i) => i.reflowPreview)).toEqual(urls);
	expect(session.ready).toBe(false);
	expect(failed).toHaveBeenCalledTimes(1);
});

it("publishes a changed streaming page above the retained document without changing other pages", async () => {
	const items = [item(0), item(1)];
	session.update(items, [], false);
	await settled();
	const output = session.output;
	const urls = session.decorate(items).map((i) => i.reflowPreview);
	const changed = [items[0], { ...items[1], translated: "changed" }];
	session.update(changed, [], true);
	await settled();
	expect(session.output).toBe(output);
	expect(buildReflowPage).toHaveBeenCalledTimes(1);
	expect(vi.mocked(buildReflowPage).mock.calls[0][2].pages[0].index).toBe(1);
	const decorated = session.decorate(changed);
	if (!output) throw new Error("Initial output missing");
	expect(decorated[0].reflowPreview).toBe(urls[0]);
	expect(
		decorated[0].reflowPreviewSources?.has(reflowOutputVersion(output)),
	).toBe(true);
	expect(
		decorated[1].reflowPreviewSources?.has(reflowOutputVersion(output)),
	).toBe(false);
	expect(decorated[1].reflowPreview).not.toBe(urls[1]);
});

it("keeps unfinished retranslation pages when the run is cancelled", async () => {
	const items = [item(0), item(1)];
	session.update(items, [], false);
	await settled();
	const output = session.output;
	const urls = session.decorate(items).map((entry) => entry.reflowPreview);
	const pending = items.map((entry) => ({
		...entry,
		status: "pending" as const,
	}));
	session.update(pending, [], true);
	await settled();
	const cancelled = [{ ...items[0], translated: "new text" }, pending[1]];
	session.update(cancelled, [], false);
	await settled();
	expect(buildReflowPage).not.toHaveBeenCalled();
	const call = vi.mocked(buildReflowPdf).mock.calls[1];
	expect(call[2].pages.map((page) => page.index)).toEqual([0]);
	expect(call[3].get(items[1].id)).toBe(items[1].translated);
	expect(session.decorate(cancelled)[1].reflowPreview).toBe(urls[1]);
	expect(replaceReflowPages).toHaveBeenCalledWith(
		output,
		expect.any(Uint8Array),
		[0],
	);
});

it("keeps the selection text aligned with the retained page until replacement succeeds", async () => {
	const first = {
		...item(0),
		sentences: [
			{ source: "original", quote: "original", translated: "translated" },
		],
	};
	session.update([first], [], false);
	await settled();
	const gate = deferred<ReflowOutput>();
	vi.mocked(buildReflowPdf).mockReturnValueOnce(gate.promise);
	const changed = {
		...first,
		translated: "replacement",
		sentences: [{ ...first.sentences[0], translated: "replacement" }],
	};
	session.update([changed], [], false);
	await vi.waitFor(() => expect(buildReflowPdf).toHaveBeenCalledTimes(2));
	expect(session.decorate([changed])[0].translated).toBe(first.translated);
	expect(session.decorate([changed])[0].sentences).toEqual(first.sentences);
	gate.resolve(result(vi.mocked(buildReflowPdf).mock.calls[1][2]));
	await settled();
	expect(session.decorate([changed])[0].translated).toBe(changed.translated);
	expect(session.decorate([changed])[0].sentences).toEqual(changed.sentences);
});
