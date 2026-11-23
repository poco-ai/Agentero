import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReflowPdf } from "@/lib/pdf/reflow/export";
import {
	FORMULA_PDF_CALL_STALL_MS,
	FormulaPdfCallStalledError,
} from "@/lib/pdf/reflow/formula-engine";
import {
	type CharacterStyle,
	REFLOW_IR_SCHEMA_VERSION,
	type ReflowDocument,
} from "@/lib/pdf/reflow/types";
import { deferred } from "./helpers/deferred";

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

const box = { x: 10, y: 10, w: 40, h: 20 };
const style: CharacterStyle = {
	font: "Times",
	size: 10,
	bold: false,
	italic: false,
	color: { r: 0, g: 0, b: 0 },
};
const ir: ReflowDocument = {
	version: REFLOW_IR_SCHEMA_VERSION,
	pages: [
		{
			index: 0,
			width: 200,
			height: 200,
			obstacles: [],
			paragraphs: [
				{
					id: "p",
					pageIndex: 0,
					box,
					characters: [{ index: 0, text: "∑", box, visualBox: box, style }],
					formulas: [
						{
							id: "0",
							text: "∑",
							box,
							characterIndexes: [0],
							baselineOffset: 0,
						},
					],
					styles: {},
					source: "∑",
					protectedText: "⟪F0⟫",
					style,
					firstLineIndent: 0,
					heading: false,
				},
			],
		},
	],
};

function engineStub(
	impl: Partial<Record<keyof PdfEngine, (...args: never[]) => unknown>>,
): PdfEngine {
	return impl as PdfEngine;
}

describe("formula PDFium call stall", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("rejects a stalled call and does not accept the late result as success", async () => {
		const redactStarted = deferred();
		const redact = deferred();
		const dedicated = engineStub({
			openDocumentBuffer: vi.fn(() => ({
				toPromise: async () => ({ pages: [{}] }),
			})),
			redactTextInRects: vi.fn(() => {
				redactStarted.resolve();
				return { toPromise: () => redact.promise };
			}),
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
			new Map([["p", "译文⟪F0⟫"]]),
			new Uint8Array(),
		).then(
			() => "ok" as const,
			(error: unknown) => {
				failure = error;
				return "err" as const;
			},
		);

		await expect(Promise.race([redactStarted.promise, pending])).resolves.toBe(
			undefined,
		);
		expect(mocks.destroyPdfEngine).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(FORMULA_PDF_CALL_STALL_MS - 1);
		expect(failure).toBeUndefined();

		await vi.advanceTimersByTimeAsync(1);
		await expect(pending).resolves.toBe("err");
		expect(failure).toBeInstanceOf(FormulaPdfCallStalledError);
		redact.resolve();
		await vi.advanceTimersByTimeAsync(0);

		expect(dedicated.saveAsCopy).not.toHaveBeenCalled();
		expect(shared.openDocumentBuffer).not.toHaveBeenCalled();
		expect(shared.redactTextInRects).not.toHaveBeenCalled();
		expect(mocks.destroyPdfEngine).toHaveBeenCalledTimes(1);
		expect(mocks.destroyPdfEngine).toHaveBeenCalledWith(dedicated);
		expect(mocks.disposePdfEngine).not.toHaveBeenCalled();
		await expect(pending).resolves.toBe("err");
	});
});
