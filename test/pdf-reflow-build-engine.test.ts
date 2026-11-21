import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReflowBuildEngine } from "@/lib/pdf/reflow/builder";

const createEngine = vi.fn<() => Promise<PdfEngine>>();
const releaseEngine = vi.fn();
vi.mock("@/lib/pdf/background-engine", () => ({
	acquireBackgroundPdfEngine: async () => ({
		engine: await createEngine(),
		release: releaseEngine,
	}),
}));

function doc(id: string): PdfDocumentObject {
	return { id } as unknown as PdfDocumentObject;
}
function engine(options: { worker?: boolean } = {}): PdfEngine {
	return {
		whenReady:
			options.worker === false
				? undefined
				: () => ({ toPromise: async () => {} }),
		saveAsCopy: vi.fn(() => ({
			toPromise: async () => new Uint8Array([1, 2, 3]).buffer,
		})),
		openDocumentBuffer: vi.fn(() => ({ toPromise: async () => doc("own") })),
		closeDocument: vi.fn(() => ({
			wait(onSuccess: () => void) {
				onSuccess();
			},
			toPromise: async () => true,
		})),
		closeAllDocuments: vi.fn(() => ({
			wait(onSuccess: () => void) {
				onSuccess();
			},
			toPromise: async () => true,
		})),
	} as unknown as PdfEngine;
}

beforeEach(() => {
	createEngine.mockReset();
	releaseEngine.mockReset();
});

describe("ReflowBuildEngine", () => {
	it("spawns a dedicated worker engine with a private document copy", async () => {
		const shared = engine();
		const dedicated = engine();
		createEngine.mockResolvedValue(dedicated);
		const builder = new ReflowBuildEngine({
			engine: shared,
			document: doc("src"),
		});
		const target = await builder.get();
		expect(target.engine).toBe(dedicated);
		expect(target.document).not.toBe(doc("src"));
		expect(shared.saveAsCopy).toHaveBeenCalledTimes(1);
		expect(dedicated.openDocumentBuffer).toHaveBeenCalledTimes(1);
		// A second get reuses the same instance without another copy.
		await expect(builder.get()).resolves.toBe(target);
		expect(shared.saveAsCopy).toHaveBeenCalledTimes(1);
		expect(createEngine).toHaveBeenCalledTimes(1);
	});

	it("idle() closes the private document and releases its background engine lease", async () => {
		const shared = engine();
		const dedicated = engine();
		createEngine.mockResolvedValue(dedicated);
		const builder = new ReflowBuildEngine({
			engine: shared,
			document: doc("src"),
		});
		await builder.get();
		builder.idle();
		expect(dedicated.closeDocument).toHaveBeenCalledTimes(1);
		expect(releaseEngine).toHaveBeenCalledTimes(1);
		expect(shared.closeDocument).not.toHaveBeenCalled();
		const next = engine();
		createEngine.mockResolvedValue(next);
		const target = await builder.get();
		expect(target.engine).toBe(next);
	});

	it("falls back to the shared pair when the worker cannot start", async () => {
		const shared = engine();
		createEngine.mockRejectedValue(new Error("worker timeout"));
		const builder = new ReflowBuildEngine({
			engine: shared,
			document: doc("src"),
		});
		await expect(builder.get()).resolves.toMatchObject({ engine: shared });
		// The failure is sticky: no respawn attempts on later builds.
		createEngine.mockClear();
		await expect(builder.get()).resolves.toMatchObject({ engine: shared });
		expect(createEngine).not.toHaveBeenCalled();
		// Teardown must never dispose the shared viewer engine.
		builder.dispose();
		expect(releaseEngine).not.toHaveBeenCalled();
	});

	it("rejects a direct (non-worker) engine instead of running builds on the main thread", async () => {
		const shared = engine();
		createEngine.mockResolvedValue(engine({ worker: false }));
		const builder = new ReflowBuildEngine({
			engine: shared,
			document: doc("src"),
		});
		await expect(builder.get()).resolves.toMatchObject({ engine: shared });
		expect(releaseEngine).toHaveBeenCalledTimes(1);
	});

	it("cleans up a spawn that resolves after dispose", async () => {
		const shared = engine();
		const dedicated = engine();
		let openResolve!: (value: PdfDocumentObject) => void;
		const pendingDoc = new Promise<PdfDocumentObject>(
			(resolve) => (openResolve = resolve),
		);
		const open = vi.fn(() => ({ toPromise: () => pendingDoc }));
		createEngine.mockResolvedValue({
			...dedicated,
			openDocumentBuffer: open,
		} as unknown as PdfEngine);
		const builder = new ReflowBuildEngine({
			engine: shared,
			document: doc("src"),
		});
		const pending = builder.get();
		await vi.waitFor(() => expect(open).toHaveBeenCalled());
		builder.dispose();
		openResolve(doc("late"));
		await expect(pending).resolves.toMatchObject({ engine: shared });
		expect(dedicated.closeDocument).toHaveBeenCalledTimes(1);
		expect(releaseEngine).toHaveBeenCalledTimes(1);
	});
});
