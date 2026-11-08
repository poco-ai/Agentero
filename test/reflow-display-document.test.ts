// @vitest-environment happy-dom

import {
	type PdfDocumentObject,
	type PdfErrorReason,
	Task,
} from "@embedpdf/models";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useReflowDisplayDocument } from "@/components/viewer/pdf/hooks/use-reflow-display-document";

type DocCap = Parameters<typeof useReflowDisplayDocument>[0];

function pdfDocument(id: string): PdfDocumentObject {
	return {
		id,
		pageCount: 1,
		pages: [],
		isEncrypted: false,
		isOwnerUnlocked: true,
		permissions: 0,
		normalizedRotation: true,
	};
}

/**
 * Shape of the document manager capability this hook relies on: the outer
 * open task resolves as soon as loading starts, the inner task when PDFium is
 * done. `closeDocument` resolves immediately.
 */
function fakeDocumentManager() {
	const loads = new Map<string, Task<PdfDocumentObject, PdfErrorReason>>();
	const closed: string[] = [];
	const manager = {
		openDocumentBuffer: vi.fn((options: { documentId: string }) => {
			const load = new Task<PdfDocumentObject, PdfErrorReason>();
			loads.set(options.documentId, load);
			const open = new Task<unknown, PdfErrorReason>();
			open.resolve({ documentId: options.documentId, task: load });
			return open;
		}),
		closeDocument: vi.fn((id: string) => {
			closed.push(id);
			const done = new Task<void, PdfErrorReason>();
			done.resolve();
			return done;
		}),
	};
	return {
		manager: manager as unknown as DocCap,
		loads,
		closed,
	};
}

let latest: string | null = null;
let root: Root | null = null;

function Probe({
	docCap,
	output,
	docId,
}: {
	docCap: DocCap;
	output: Uint8Array;
	docId: string;
}) {
	latest = useReflowDisplayDocument(docCap, output, docId);
	return null;
}

const container = document.createElement("div");
document.body.append(container);

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	latest = null;
	vi.unstubAllGlobals();
});

it("publishes the display id only after the buffer is loaded", async () => {
	const { manager, loads } = fakeDocumentManager();
	root = createRoot(container);
	await act(async () => {
		root?.render(
			createElement(Probe, {
				docCap: manager,
				output: new Uint8Array([1]),
				docId: "paper::translation::r2",
			}),
		);
	});
	expect(latest).toBeNull();
	const [displayId] = [...loads.keys()];
	if (!displayId) throw new Error("display document was not opened");

	await act(async () => {
		loads.get(displayId)?.resolve(pdfDocument(displayId));
	});
	expect(displayId).toMatch(/^reflow-display-paper::translation::r2-\d+$/);
	expect(latest).toBe(displayId);
});

it("keeps the previous display document until the replacement has loaded", async () => {
	const { manager, loads, closed } = fakeDocumentManager();
	root = createRoot(container);
	const render = (byte: number) =>
		root?.render(
			createElement(Probe, {
				docCap: manager,
				output: new Uint8Array([byte]),
				docId: "paper::translation::r2",
			}),
		);

	await act(async () => render(1));
	const [first] = [...loads.keys()];
	if (!first) throw new Error("first display document was not opened");
	await act(async () => loads.get(first)?.resolve(pdfDocument(first)));
	expect(latest).toBe(first);

	await act(async () => render(2));
	const second = [...loads.keys()][1];
	if (!second) throw new Error("replacement display document was not opened");
	expect(latest).toBe(first);
	expect(closed).toEqual([]);

	await act(async () => loads.get(second)?.resolve(pdfDocument(second)));
	expect(latest).toBe(second);
	expect(closed).toEqual([first]);
});
