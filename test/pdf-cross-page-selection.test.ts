// @vitest-environment happy-dom

import {
	PluginRegistry,
	setDocumentLoaded,
	startLoadingDocument,
} from "@embedpdf/core";
import {
	type PdfDocumentObject,
	type PdfEngine,
	type PdfPageGeometry,
	PdfTaskHelper,
	type Rect,
} from "@embedpdf/models";
import {
	type EmbedPdfPointerEvent,
	type InteractionManagerPlugin,
	InteractionManagerPluginPackage,
} from "@embedpdf/plugin-interaction-manager";
import {
	type SelectionPlugin,
	SelectionPluginPackage,
} from "@embedpdf/plugin-selection";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type PdfTextSelection,
	type UsePdfTextSelectionOptions,
	usePdfTextSelection,
} from "@/components/viewer/pdf/hooks/use-pdf-text-selection";
import { clearSelections } from "@/lib/agent/selection-store";
import {
	clearLayoutDocumentResult,
	setLayoutDocumentResult,
} from "@/lib/pdf/layout/store";
import type {
	PdfLayoutDocumentResult,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";

const geometry: PdfPageGeometry = {
	runs: [
		{
			charStart: 0,
			fontSize: 12,
			rect: { x: 10, y: 20, width: 100, height: 20 },
			glyphs: Array.from({ length: 10 }, (_, index) => ({
				x: 10 + index * 10,
				y: 20,
				width: 10,
				height: 20,
				flags: 0,
			})),
		},
	],
};

let registry: PluginRegistry;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let selection: PdfTextSelection;
let interaction: ReturnType<InteractionManagerPlugin["provides"]>;
let capability: ReturnType<SelectionPlugin["provides"]>;
let unregisterPages: (() => void)[];
let ended: ReturnType<typeof vi.fn>;
let engine: PdfEngine;
let headers: Map<number, readonly Rect[]>;
let ensureMargins: (
	pages: readonly number[],
) => Promise<ReadonlyMap<number, readonly Rect[]>>;

function pointer(
	page: number | null,
	key: "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel",
	x = 55,
) {
	const event: EmbedPdfPointerEvent = {
		clientX: x,
		clientY: 30,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		metaKey: false,
		target: {},
		currentTarget: {},
		stopImmediatePropagation: () => {},
		isImmediatePropagationStopped: () => false,
	};
	const scope =
		page == null
			? ({ type: "global", documentId: "doc" } as const)
			: ({ type: "page", documentId: "doc", pageIndex: page } as const);
	interaction
		.getHandlersForScope(scope)
		?.[key]?.({ x, y: 30 }, event, "pointerMode");
}

async function begin(page: number) {
	await act(() => {
		host.dispatchEvent(
			new MouseEvent("pointerdown", { bubbles: true, clientY: 300 }),
		);
		pointer(page, "onPointerDown", 15);
		pointer(page, "onPointerMove", 35);
	});
}

async function release(page: number | null, clientY = 350) {
	await act(async () => {
		host.dispatchEvent(
			new MouseEvent("pointerup", {
				bubbles: true,
				clientX: 155,
				clientY,
			}),
		);
		if (page != null) pointer(page, "onPointerUp");
		// Native pointerup bubbles from the page provider to the document provider.
		pointer(null, "onPointerUp");
	});
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	engine = {
		getPageGeometry: () => PdfTaskHelper.resolve(geometry),
		getTextSlices: () => PdfTaskHelper.resolve(["cross-page quote"]),
	} as unknown as PdfEngine;
	headers = new Map();
	ensureMargins = async () => headers;
	registry = new PluginRegistry(engine);
	registry.registerPlugin(InteractionManagerPluginPackage);
	registry.registerPlugin(SelectionPluginPackage);
	await registry.initialize();
	const doc = {
		id: "doc",
		pageCount: 2,
		pages: [0, 1].map((index) => ({
			index,
			size: { width: 600, height: 800 },
		})),
	} as PdfDocumentObject;
	registry.getStore().dispatchToCore(startLoadingDocument("doc"));
	registry.getStore().dispatchToCore(setDocumentLoaded("doc", doc));
	const plugin = registry.getPlugin<SelectionPlugin>("selection");
	const manager = registry.getPlugin<InteractionManagerPlugin>(
		"interaction-manager",
	);
	if (!plugin || !manager) throw new Error("Missing PDF selection plugins");
	capability = plugin.provides();
	interaction = manager.provides();
	unregisterPages = [0, 1].map((pageIndex) =>
		plugin.registerSelectionOnPage({
			documentId: "doc",
			pageIndex,
			onRectsChange: () => {},
		}),
	);
	ended = vi.fn();
	capability.forDocument("doc").onEndSelection(ended);
	host = document.createElement("div");
	for (const index of [0, 1]) {
		const page = document.createElement("div");
		page.setAttribute("data-embed-pdf-page", String(index));
		vi.spyOn(page, "getBoundingClientRect").mockReturnValue(
			new DOMRect(100, 200 + index * 820, 600, 800),
		);
		host.append(page);
	}
	document.body.append(host);
	const container = document.createElement("div");
	host.append(container);
	root = createRoot(container);
	const options = {
		ensureSelectionTextExclusions: (pages: readonly number[]) =>
			ensureMargins(pages),
		engine,
		selectionTextExclusionsByPage: headers,
		selectionCap: capability,
		docCap: { getDocument: () => doc },
		docId: "doc",
		hostRef: { current: host },
		zoomRef: { current: 1 },
		isActive: true,
		paperRelPath: "paper.pdf",
		paperAbsPath: null,
	} as UsePdfTextSelectionOptions;
	function Probe() {
		selection = usePdfTextSelection(options);
		return null;
	}
	await act(() => root.render(createElement(Probe)));
});

afterEach(async () => {
	clearLayoutDocumentResult("doc");
	await act(() => root.unmount());
	for (const unregister of unregisterPages) unregister();
	await registry.destroy();
	host.remove();
	clearSelections();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("finishes a downward cross-page drag and opens the menu on the second page", async () => {
	await begin(0);
	await act(() => pointer(1, "onPointerMove"));
	await release(1);
	expect(ended).toHaveBeenCalledTimes(1);
	expect(capability.getState("doc").selecting).toBe(false);
	expect(selection.isSelecting).toBe(false);
	expect(selection.selectionMenu?.anchor.page).toBe(2);
	expect(selection.selectionMenu?.anchor.quote).toBe("cross-page quote");
	expect(selection.selectionMenu?.pages).toHaveLength(2);
	expect(
		selection.selectionMenu?.anchor.selectionPages?.map(({ page }) => page),
	).toEqual([1, 2]);
});

it("anchors upward cross-page drags to the first page after the start page unmounts", async () => {
	await begin(1);
	await act(() => pointer(0, "onPointerMove"));
	unregisterPages[1]?.();
	host.querySelector('[data-embed-pdf-page="1"]')?.remove();
	// Scrolling while selecting can put the cursor below its initial client Y
	// even though the selection extended to an earlier page.
	await release(0, 350);
	expect(ended).toHaveBeenCalledTimes(1);
	expect(selection.selectionMenu?.anchor.page).toBe(1);
	expect(selection.selectionMenu?.screen.side).toBe("above");
	expect(selection.selectionMenu?.screen.cursorX).toBe(155);
});

it("finishes a drag released in the gap between pages", async () => {
	await begin(0);
	await act(() => pointer(1, "onPointerMove"));
	await release(null);
	expect(ended).toHaveBeenCalledTimes(1);
	expect(capability.getState("doc").selecting).toBe(false);
	expect(selection.selectionMenu?.anchor.page).toBe(2);
});

it("settles same-page releases once and permits a new cross-page drag", async () => {
	await begin(0);
	await release(0);
	expect(ended).toHaveBeenCalledTimes(1);
	await begin(1);
	await act(() => pointer(0, "onPointerMove"));
	await release(0);
	expect(ended).toHaveBeenCalledTimes(2);
	expect(selection.selectionMenu?.anchor.page).toBe(1);
});

it("uses a mounted selection page when the endpoint page has unmounted", async () => {
	await begin(0);
	await act(() => pointer(1, "onPointerMove"));
	unregisterPages[1]?.();
	host.querySelector('[data-embed-pdf-page="1"]')?.remove();
	await release(null);
	expect(selection.selectionMenu?.anchor.page).toBe(1);
	expect(selection.selectionMenu?.pages).toHaveLength(2);
});

it("preserves a recovered caption when the user deliberately starts the cross-page drag there", async () => {
	headers.set(0, [
		{ origin: { x: 10, y: 20 }, size: { width: 30, height: 20 } },
	]);
	await begin(0);
	await act(() => pointer(1, "onPointerMove"));
	await release(1);
	expect(selection.selectionMenu?.pages[0].segmentRects[0].origin.x).toBe(10);
	expect(selection.selectionMenu?.anchor.quote).toBe("cross-page quote");
});

it("clears a cancelled cross-page drag without opening a menu", async () => {
	await begin(0);
	await act(() => {
		pointer(1, "onPointerMove");
		pointer(null, "onPointerCancel");
	});
	expect(ended).not.toHaveBeenCalled();
	expect(capability.getState("doc").selection).toBeNull();
	expect(selection.isSelecting).toBe(false);
	expect(selection.selectionMenu).toBeNull();
});

it.each([
	{ kind: "table" as const },
	{ kind: "figure_title" as const },
	{ kind: "formula_number" as const },
	{ kind: "text" as const, label: "vision_footnote" },
	{ kind: "text" as const, label: "footer" },
	{ kind: "text" as const, label: "seal" },
	{ kind: "text" as const, label: "reference_content" },
])("excludes margins and intervening $kind blocks from the menu, translation quote and copy", async (insertion) => {
	const table = {
		id: "table",
		pageIndex: 0,
		...insertion,
		rect: { x: 40, y: 20, w: 20, h: 20 },
	} as PdfLayoutRegion;
	const endCaption = {
		...table,
		id: "end-caption",
		pageIndex: 1,
		kind: "figure_title",
		rect: { x: 50, y: 20, w: 10, h: 20 },
	} as PdfLayoutRegion;
	setLayoutDocumentResult({
		documentId: "doc",
		updatedAt: 0,
		rawRegions: [table, endCaption],
		regions: [table, endCaption],
		counts: {},
	} as PdfLayoutDocumentResult);
	headers.set(1, [
		{ origin: { x: 10, y: 20 }, size: { width: 30, height: 20 } },
	]);
	const extract = vi
		.spyOn(engine, "getTextSlices")
		.mockImplementation((_doc, requests) =>
			PdfTaskHelper.resolve(
				requests.map(
					({ pageIndex, charIndex, charCount }) =>
						`${pageIndex}:${charIndex}:${charCount}`,
				),
			),
		);
	await begin(0);
	await act(() => pointer(1, "onPointerMove"));
	await release(1);
	expect(extract).toHaveBeenCalledWith(expect.anything(), [
		{ pageIndex: 0, charIndex: 0, charCount: 3 },
		{ pageIndex: 0, charIndex: 5, charCount: 5 },
		{ pageIndex: 1, charIndex: 3, charCount: 1 },
	]);
	expect(selection.selectionMenu?.anchor.quote).toBe("0:0:3 0:5:5 1:3:1");
	expect(selection.selectionMenu?.pages[0].segmentRects).toHaveLength(2);
	expect(selection.selectionMenu?.pages[1].segmentRects[0].origin.x).toBe(40);
	const setData = vi.fn();
	const event = new Event("copy", { cancelable: true });
	Object.defineProperty(event, "clipboardData", { value: { setData } });
	document.dispatchEvent(event);
	expect(setData).toHaveBeenCalledWith("text/plain", "0:0:3 0:5:5 1:3:1");
});

it("isolates native selection on page drags and releases that isolation for a direct comment click", () => {
	const page = host.querySelector("[data-embed-pdf-page]");
	if (!page) throw new Error("Missing PDF page");
	const canvas = document.createElement("canvas");
	page.append(canvas);
	const down = new MouseEvent("pointerdown", {
		bubbles: true,
		cancelable: true,
	});
	canvas.dispatchEvent(down);
	expect(down.defaultPrevented).toBe(true);
	expect(host.hasAttribute("data-pdf-drag-selection")).toBe(true);
	const comment = document.createElement("div");
	comment.setAttribute("data-pdf-chrome", "");
	comment.textContent = "comment text";
	page.append(comment);
	const click = new MouseEvent("pointerdown", {
		bubbles: true,
		cancelable: true,
	});
	comment.dispatchEvent(click);
	expect(click.defaultPrevented).toBe(false);
	expect(host.hasAttribute("data-pdf-drag-selection")).toBe(false);
});

it("waits for margin detection on a fast cross-page release and cancels it when dismissed", async () => {
	let resolve!: (value: ReadonlyMap<number, readonly Rect[]>) => void;
	ensureMargins = () =>
		new Promise((done) => {
			resolve = done;
		});
	await begin(0);
	await act(() => pointer(1, "onPointerMove"));
	await release(1);
	expect(selection.selectionMenu).toBeNull();
	expect(selection.isSelecting).toBe(true);
	await act(() => selection.closeSelectionMenu());
	await act(async () => resolve(headers));
	expect(selection.selectionMenu).toBeNull();
});
