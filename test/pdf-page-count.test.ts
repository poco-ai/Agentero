import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PluginRegistry } from "@embedpdf/core";
import { createPdfiumEngine } from "@embedpdf/engines/pdfium-direct-engine";
import {
	type PdfDocumentObject,
	type PdfEngine,
	PdfErrorCode,
	type PdfErrorReason,
	Task,
} from "@embedpdf/models";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPdfPageCount } from "@/lib/pdf/page-count";

const { findPdf, readPdf, getEngine } = vi.hoisted(() => ({
	findPdf: vi.fn(),
	readPdf: vi.fn(),
	getEngine: vi.fn(),
}));

vi.mock("@/lib/paper", () => ({
	findLocalPdfPath: findPdf,
	localFileToArrayBuffer: readPdf,
}));
vi.mock("@/lib/pdf/background-engine", () => ({
	acquireBackgroundPdfEngine: async () => ({
		engine: await getEngine(),
		release: () => {},
	}),
}));

function resolved<T>(value: T) {
	const task = new Task<T, PdfErrorReason>();
	task.resolve(value);
	return task;
}

const failure = { code: PdfErrorCode.Unknown, message: "PDF failure" };

function rejected<T>() {
	const task = new Task<T, PdfErrorReason>();
	task.reject(failure);
	return task;
}

function document(id: string, pageCount = 12): PdfDocumentObject {
	return {
		id,
		pageCount,
		pages: [],
		isEncrypted: false,
		isOwnerUnlocked: true,
		permissions: 0,
		normalizedRotation: true,
	};
}

// Keep the real registry, document-manager, render plugin and Tasks. Replace
// only native PDFium calls, tracking live document/buffer ownership at that boundary.
function trackedEngine() {
	const allocations = new Map<string, ArrayBuffer>();
	const open = vi.fn<PdfEngine["openDocumentBuffer"]>((file) => {
		if (allocations.has(file.id)) throw new Error("Duplicate document id");
		allocations.set(file.id, file.content);
		return resolved(document(file.id));
	});
	const close = vi.fn<PdfEngine["closeDocument"]>((doc) => {
		if (!allocations.delete(doc.id)) throw new Error("Document already closed");
		return resolved(true);
	});
	const destroy = vi.fn();
	const engine = {
		openDocumentBuffer: open,
		closeDocument: close,
		destroy,
	} as unknown as PdfEngine;
	return { engine, allocations, open, close, destroy };
}

describe("PDF page-count resource lifetime", () => {
	beforeEach(() => {
		findPdf.mockReset().mockResolvedValue("/vault/papers/a/a.pdf");
		readPdf.mockReset().mockResolvedValue(new ArrayBuffer(16));
		getEngine.mockReset();
	});
	afterEach(() => vi.restoreAllMocks());

	it("balances repeated opens/closes and destroys each registry, keeping the shared engine", async () => {
		const tracked = trackedEngine();
		getEngine.mockResolvedValue(tracked.engine);
		const destroyRegistry = vi.spyOn(PluginRegistry.prototype, "destroy");
		for (let i = 0; i < 16; i++) {
			expect(await getPdfPageCount("/vault/papers/a")).toBe(12);
			expect(tracked.allocations.size).toBe(0);
		}
		expect(tracked.open).toHaveBeenCalledTimes(16);
		expect(tracked.close).toHaveBeenCalledTimes(16);
		expect(destroyRegistry).toHaveBeenCalledTimes(16);
		for (const registry of destroyRegistry.mock.contexts) {
			expect(registry.isDestroyed()).toBe(true);
			expect(registry.getAllPlugins()).toEqual([]);
		}
		expect(tracked.destroy).not.toHaveBeenCalled();
	});

	it("uses distinct ids for concurrent probes in the same millisecond and closes only its own docs", async () => {
		vi.spyOn(Date, "now").mockReturnValue(123456);
		const tracked = trackedEngine();
		const otherBytes = new ArrayBuffer(32);
		tracked.allocations.set("headless-layout-other", otherBytes);
		const pending: Array<{
			id: string;
			task: Task<PdfDocumentObject, PdfErrorReason>;
		}> = [];
		tracked.open.mockImplementation((file) => {
			if (tracked.allocations.has(file.id)) throw new Error("Duplicate id");
			tracked.allocations.set(file.id, file.content);
			const task = new Task<PdfDocumentObject, PdfErrorReason>();
			pending.push({ id: file.id, task });
			return task;
		});
		getEngine.mockResolvedValue(tracked.engine);
		const first = getPdfPageCount("/vault/papers/a");
		const second = getPdfPageCount("/vault/papers/b");
		await vi.waitFor(() => expect(pending).toHaveLength(2));
		expect(new Set(pending.map(({ id }) => id)).size).toBe(2);
		pending[0].task.resolve(document(pending[0].id, 7));
		expect(await first).toBe(7);
		expect(tracked.allocations.has(pending[1].id)).toBe(true);
		pending[1].task.resolve(document(pending[1].id, 23));
		expect(await second).toBe(23);
		expect(tracked.close).toHaveBeenCalledTimes(2);
		expect([...tracked.allocations]).toEqual([
			["headless-layout-other", otherBytes],
		]);
		expect(tracked.destroy).not.toHaveBeenCalled();
	});

	it.each([
		"initialize",
		"pluginsReady",
	] as const)("destroys the registry when %s fails", async (method) => {
		const tracked = trackedEngine();
		getEngine.mockResolvedValue(tracked.engine);
		vi.spyOn(PluginRegistry.prototype, method).mockRejectedValueOnce(failure);
		const destroyRegistry = vi.spyOn(PluginRegistry.prototype, "destroy");
		expect(await getPdfPageCount("/vault/papers/a")).toBeNull();
		expect(destroyRegistry).toHaveBeenCalledTimes(1);
		expect(destroyRegistry.mock.contexts[0].getAllPlugins()).toEqual([]);
		expect(tracked.open).not.toHaveBeenCalled();
	});

	it("tears down the error state when PDF opening fails", async () => {
		const tracked = trackedEngine();
		tracked.open.mockImplementationOnce(() => rejected());
		getEngine.mockResolvedValue(tracked.engine);
		const destroyRegistry = vi.spyOn(PluginRegistry.prototype, "destroy");
		expect(await getPdfPageCount("/vault/papers/a")).toBeNull();
		expect(destroyRegistry).toHaveBeenCalledTimes(1);
		expect(destroyRegistry.mock.contexts[0].getAllPlugins()).toEqual([]);
		expect(tracked.allocations.size).toBe(0);
		expect(tracked.close).not.toHaveBeenCalled();
	});

	it.each([
		"empty",
		"read failure",
	])("closes an opened PDF after %s", async (mode) => {
		const tracked = trackedEngine();
		tracked.open.mockImplementationOnce((file) => {
			tracked.allocations.set(file.id, file.content);
			const doc = document(file.id, 0);
			if (mode === "read failure") {
				Object.defineProperty(doc, "pageCount", {
					get: () => {
						throw failure;
					},
				});
			}
			return resolved(doc);
		});
		getEngine.mockResolvedValue(tracked.engine);
		expect(await getPdfPageCount("/vault/papers/a")).toBeNull();
		expect(tracked.close).toHaveBeenCalledTimes(1);
		expect(tracked.allocations.size).toBe(0);
	});

	it("still destroys the registry and retries when explicit close fails", async () => {
		const tracked = trackedEngine();
		tracked.close.mockImplementationOnce(() => rejected());
		getEngine.mockResolvedValue(tracked.engine);
		const destroyRegistry = vi.spyOn(PluginRegistry.prototype, "destroy");
		expect(await getPdfPageCount("/vault/papers/a")).toBe(12);
		expect(destroyRegistry).toHaveBeenCalledTimes(1);
		expect(tracked.close).toHaveBeenCalledTimes(2);
		expect(tracked.allocations.size).toBe(0);
	});

	it("preserves the count if registry teardown reports an error after closing", async () => {
		const tracked = trackedEngine();
		getEngine.mockResolvedValue(tracked.engine);
		const destroy = PluginRegistry.prototype.destroy;
		vi.spyOn(PluginRegistry.prototype, "destroy").mockImplementationOnce(
			async function () {
				await destroy.call(this);
				throw failure;
			},
		);
		expect(await getPdfPageCount("/vault/papers/a")).toBe(12);
		expect(tracked.allocations.size).toBe(0);
	});
});

// --- real PDFium engine (merged from pdf-page-count-native) ---

it("balances native document and tracked WASM allocations with the real PDFium engine", async () => {
	const require = createRequire(import.meta.url);
	const wasm = await readFile(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
	const engine = await createPdfiumEngine(
		`data:application/wasm;base64,${wasm.toString("base64")}`,
		{ fontFallback: null },
	);
	findPdf.mockResolvedValue("/smoke/a.pdf");
	getEngine.mockResolvedValue(engine);
	const pdf = await PDFDocument.create();
	for (let i = 0; i < 3; i++) pdf.addPage();
	const bytes = await pdf.save();
	readPdf.mockImplementation(async () => bytes.slice().buffer);
	// SDK-private counters are used only here to verify live native ownership;
	// WASM heap capacity need not shrink after a document is released.
	const native = (
		engine as unknown as {
			executor: {
				cache: { docs: Map<string, unknown> };
				memoryManager: {
					getStats(): { totalAllocated: number; allocationCount: number };
				};
			};
		}
	).executor;
	const stats = () => {
		const { totalAllocated, allocationCount } = native.memoryManager.getStats();
		return { docs: native.cache.docs.size, totalAllocated, allocationCount };
	};
	const open = vi.spyOn(engine, "openDocumentBuffer");
	const close = vi.spyOn(engine, "closeDocument");
	const baseline = stats();
	try {
		expect(baseline).toEqual({
			docs: 0,
			totalAllocated: 0,
			allocationCount: 0,
		});
		for (let i = 0; i < 32; i++) {
			expect(await getPdfPageCount("/smoke")).toBe(3);
			expect(stats()).toEqual(baseline);
		}
		expect(
			await Promise.all(
				Array.from({ length: 8 }, () => getPdfPageCount("/smoke")),
			),
		).toEqual(Array(8).fill(3));
		expect(stats()).toEqual(baseline);
		readPdf.mockResolvedValueOnce(new ArrayBuffer(20));
		expect(await getPdfPageCount("/smoke")).toBeNull();
		expect(stats()).toEqual(baseline);
		expect(open).toHaveBeenCalledTimes(41);
		expect(close).toHaveBeenCalledTimes(40);
	} finally {
		await engine.destroy().toPromise();
		vi.restoreAllMocks();
	}
});
