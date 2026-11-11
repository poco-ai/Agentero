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
import { LayoutTranslateOverlay } from "@/components/viewer/pdf/layers/layout-translate-overlay";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";
import { reflowOutputVersion } from "@/lib/pdf/reflow/output-version";

vi.mock("@/components/viewer/pdf/layers/reflow-page-overlay", () => ({
	ReflowPageOverlay: ({
		renderDocumentId,
		preview,
	}: {
		renderDocumentId?: string;
		preview: string;
	}) =>
		createElement("div", {
			"data-render-document": renderDocumentId,
			"data-preview": preview,
		}),
}));

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

let latest: ReturnType<typeof useReflowDisplayDocument> = null;
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
	expect(latest?.id).toBe(displayId);
});

it("exposes a small display descriptor for a large PDF without forwarding its bytes", async () => {
	const { manager, loads } = fakeDocumentManager();
	const output = new Uint8Array(26 * 1024 * 1024);
	function LargePdf() {
		latest = useReflowDisplayDocument(manager, output, "large-paper");
		return null;
	}
	root = createRoot(container);
	await act(async () => root?.render(createElement(LargePdf)));
	const [id] = [...loads.keys()];
	await act(async () => loads.get(id)?.resolve(pdfDocument(id)));
	expect(latest).toEqual({ id, version: reflowOutputVersion(output) });
	expect(JSON.stringify(latest).length).toBeLessThan(128);
	// A single version must identify the loader and preview membership without
	// exposing the byte array to React's development performance prop walker.
	expect(reflowOutputVersion(output)).toBe(latest?.version);
	expect(reflowOutputVersion(output.slice())).not.toBe(latest?.version);
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
	expect(latest?.id).toBe(first);

	await act(async () => render(2));
	const second = [...loads.keys()][1];
	if (!second) throw new Error("replacement display document was not opened");
	expect(latest?.id).toBe(first);
	expect(closed).toEqual([]);

	await act(async () => loads.get(second)?.resolve(pdfDocument(second)));
	expect(latest?.id).toBe(second);
	expect(closed).toEqual([first]);
});

it("keeps the previous loaded display when a replacement fails", async () => {
	const { manager, loads, closed } = fakeDocumentManager();
	root = createRoot(container);
	const render = (byte: number) =>
		root?.render(
			createElement(Probe, {
				docCap: manager,
				output: new Uint8Array([byte]),
				docId: "paper",
			}),
		);
	await act(async () => render(1));
	const [first] = [...loads.keys()];
	await act(async () => loads.get(first)?.resolve(pdfDocument(first)));
	await act(async () => render(2));
	const second = [...loads.keys()][1];
	await act(async () =>
		loads.get(second)?.reject({ message: "bad replacement" } as PdfErrorReason),
	);
	expect(latest?.id).toBe(first);
	expect(closed).toEqual([second]);
});

it.each([
	"resolve",
	"reject",
] as const)("keeps new page previews above the old document while its replacement loads (%s)", async (outcome) => {
	const { manager, loads } = fakeDocumentManager();
	const oldOutput = new Uint8Array([1]);
	const newOutput = new Uint8Array([2]);
	const unchangedSources = new WeakSet([
		reflowOutputVersion(oldOutput),
		reflowOutputVersion(newOutput),
	]);
	const changedSources = new WeakSet([reflowOutputVersion(newOutput)]);
	function Pages({ output }: { output: Uint8Array }) {
		const display = useReflowDisplayDocument(manager, output, "paper");
		return [unchangedSources, changedSources].map((sources, pageIndex) =>
			createElement(LayoutTranslateOverlay, {
				key: pageIndex,
				items: [
					{
						id: `p${pageIndex}`,
						pageIndex,
						source: "Source",
						status: "done",
						kind: "text",
						readingOrder: 0,
						bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 },
						reflowPreview: `blob:page-${pageIndex}`,
						reflowPreviewSources: sources,
					},
				] as LayoutTranslateItem[],
				pageIndex,
				zoom: 1,
				pageWidthPx: 200,
				pageHeightPx: 200,
				reflowDocumentId: display?.id,
				reflowDocumentVersion: display?.version,
			}),
		);
	}
	root = createRoot(container);
	await act(async () =>
		root?.render(createElement(Pages, { output: oldOutput })),
	);
	const [first] = [...loads.keys()];
	await act(async () => loads.get(first)?.resolve(pdfDocument(first)));
	await act(async () =>
		root?.render(createElement(Pages, { output: newOutput })),
	);
	const second = [...loads.keys()][1];
	const renderedPages = () => [...container.querySelectorAll("[data-preview]")];
	expect(
		renderedPages().map((page) => page.getAttribute("data-render-document")),
	).toEqual([first, null]);
	await act(async () => {
		if (outcome === "resolve") loads.get(second)?.resolve(pdfDocument(second));
		else
			loads
				.get(second)
				?.reject({ message: "bad replacement" } as PdfErrorReason);
	});
	expect(
		renderedPages().map((page) => page.getAttribute("data-render-document")),
	).toEqual(outcome === "resolve" ? [second, second] : [first, null]);
});
