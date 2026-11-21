import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReflowPdf } from "@/lib/pdf/reflow/export";
import {
	FORMULA_PDF_CALL_STALL_MS,
	FormulaPdfCallStalledError,
} from "@/lib/pdf/reflow/formula-engine";
import type { ReflowDocument } from "@/lib/pdf/reflow/types";

const mocks = vi.hoisted(() => ({
	createPdfEngine: vi.fn(),
	destroyPdfEngine: vi.fn(),
	disposePdfEngine: vi.fn(),
}));

vi.mock("@/lib/pdf/engine", () => ({
	createPdfEngine: mocks.createPdfEngine,
	destroyPdfEngine: mocks.destroyPdfEngine,
	disposePdfEngine: mocks.disposePdfEngine,
}));

const ir = {
	version: 2,
	pages: [
		{
			index: 0,
			width: 200,
			height: 200,
			paragraphs: [
				{
					id: "p",
					formulas: [{ id: "f", box: { x: 10, y: 10, w: 40, h: 20 } }],
				},
			],
		},
	],
} as ReflowDocument;

function engineStub(
	impl: Partial<Record<keyof PdfEngine, (...args: never[]) => unknown>>,
): PdfEngine {
	return impl as PdfEngine;
}

async function drain(): Promise<void> {
	for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

describe("formula PDFium call stall", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("rejects a stalled call and does not accept the late result as success", async () => {
		let finishRedact: (() => void) | undefined;
		const redact = new Promise<void>((resolve) => {
			finishRedact = resolve;
		});
		const dedicated = engineStub({
			openDocumentBuffer: vi.fn(() => ({
				toPromise: async () => ({ pages: [{}] }),
			})),
			redactTextInRects: vi.fn(() => ({ toPromise: () => redact })),
			saveAsCopy: vi.fn(() => ({
				toPromise: async () => new Uint8Array([9]).buffer,
			})),
			closeDocument: vi.fn(() => ({ toPromise: async () => undefined })),
		});
		const shared = engineStub({
			saveAsCopy: vi.fn(() => ({
				toPromise: async () => new Uint8Array([1]).buffer,
			})),
			extractPages: vi.fn(() => ({
				toPromise: async () => new Uint8Array([2]).buffer,
			})),
			openDocumentBuffer: vi.fn(),
			redactTextInRects: vi.fn(),
			closeDocument: vi.fn(),
		});
		mocks.createPdfEngine.mockResolvedValue(dedicated);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		let failure: unknown;
		const pending = buildReflowPdf(
			shared,
			{} as PdfDocumentObject,
			ir,
			new Map([["p", "译文"]]),
			new Uint8Array(),
		).then(
			() => "ok" as const,
			(error: unknown) => {
				failure = error;
				return "err" as const;
			},
		);

		await drain();
		expect(dedicated.redactTextInRects).toHaveBeenCalled();
		expect(mocks.destroyPdfEngine).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(FORMULA_PDF_CALL_STALL_MS - 1);
		await drain();
		expect(failure).toBeUndefined();

		await vi.advanceTimersByTimeAsync(1);
		await expect(pending).resolves.toBe("err");
		expect(failure).toBeInstanceOf(FormulaPdfCallStalledError);
		finishRedact?.();
		await drain();

		expect(dedicated.saveAsCopy).not.toHaveBeenCalled();
		expect(shared.openDocumentBuffer).not.toHaveBeenCalled();
		expect(shared.redactTextInRects).not.toHaveBeenCalled();
		expect(mocks.destroyPdfEngine).toHaveBeenCalledTimes(1);
		expect(mocks.destroyPdfEngine).toHaveBeenCalledWith(dedicated);
		expect(mocks.disposePdfEngine).not.toHaveBeenCalled();
		await expect(pending).resolves.toBe("err");
	});
});
