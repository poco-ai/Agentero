// @vitest-environment jsdom

import type { PdfEngine } from "@embedpdf/models";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type PdfTextSelection,
	type UsePdfTextSelectionOptions,
	usePdfTextSelection,
} from "@/components/viewer/pdf/hooks/use-pdf-text-selection";
import {
	type UsePdfTranslationSelectionOptions,
	usePdfTranslationSelection,
} from "@/components/viewer/pdf/hooks/use-pdf-translation-selection";
import { clearSelections } from "@/lib/agent/selection-store";
import {
	clearTranslationSelectionBands,
	translationSelectionBandsFor,
} from "@/lib/pdf/layout/translation-selection-bands";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";
import {
	linkPreviewDragActive,
	resetLinkPreviewDragForTests,
} from "@/lib/pdf/link-preview-drag";

vi.mock("react-i18next", async (load) => ({
	...(await load<typeof import("react-i18next")>()),
	useTranslation: () => ({ i18n: { language: "en" } }),
}));

const items = new Map<number, readonly LayoutTranslateItem[]>([
	[
		0,
		[
			{
				id: "paragraph",
				pageIndex: 0,
				kind: "text",
				readingOrder: 0,
				bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 },
				source: "Original sentence.",
				translated: "中文译文",
				status: "done",
			},
		],
	],
]);
const docCap = {
	getDocument: () => ({ pages: [{ size: { width: 200, height: 200 } }] }),
} as UsePdfTranslationSelectionOptions["docCapRef"]["current"];
const selectionCap = {
	clear: vi.fn(),
	forDocument: () => ({
		onBeginSelection: () => () => {},
		onEndSelection: () => () => {},
		onSelectionChange: () => () => {},
	}),
} as unknown as UsePdfTextSelectionOptions["selectionCap"];
const readers = new Map<string, PdfTextSelection>();

function Reader({
	id,
	active,
	enabled = true,
	engine = null,
}: {
	id: string;
	active: boolean;
	enabled?: boolean;
	engine?: PdfEngine | null;
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const zoomRef = useRef(1);
	const selection = usePdfTextSelection({
		selectionCap,
		docCap,
		docId: id,
		hostRef,
		zoomRef,
		isActive: active,
		paperRelPath: id,
		paperAbsPath: null,
	});
	readers.set(id, selection);
	usePdfTranslationSelection({
		enabled,
		hostRef,
		zoomRef,
		engineRef: useRef(engine),
		docCapRef: useRef(docCap),
		docId: id,
		itemsByPage: items,
		...selection,
		paperRelPath: id,
		paperAbsPath: null,
	});
	return createElement(
		"div",
		{ ref: hostRef, "data-reader": id },
		createElement(
			"div",
			{ "data-embed-pdf-page": "0" },
			createElement(
				"div",
				{
					"data-layout-item": "paragraph",
					"data-reflow-selection": "true",
					className: "pdf-translate-selection",
				},
				"中文译文",
			),
		),
	);
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let frames: Map<number, FrameRequestCallback>;
let visibility: Map<Element, (visible: boolean) => void>;

async function flushFrames() {
	await act(async () => {
		while (frames.size) {
			const batch = [...frames.values()];
			frames.clear();
			for (const callback of batch) callback(0);
		}
	});
}

async function pick(id: string, { release = true } = {}) {
	const text = container.querySelector(
		`[data-reader="${id}"] [data-layout-item]`,
	)?.firstChild;
	if (!text) throw new Error(`missing translated text in ${id}`);
	const range = document.createRange();
	range.selectNodeContents(text);
	range.getClientRects = () =>
		[new DOMRect(20, 20, 60, 15)] as unknown as DOMRectList;
	await act(async () => {
		text.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
		if (release)
			text.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
	});
	await flushFrames();
}

function copySelection(): string | undefined {
	const setData = vi.fn();
	const event = new Event("copy", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", { value: { setData } });
	document.dispatchEvent(event);
	expect(event.defaultPrevented).toBe(true);
	return setData.mock.calls.at(-1)?.[1];
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	frames = new Map();
	let frameId = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++frameId, callback);
		return frameId;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	visibility = new Map();
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(private callback: IntersectionObserverCallback) {}
			observe(element: Element) {
				visibility.set(element, (isIntersecting) =>
					this.callback(
						[
							{ target: element, isIntersecting },
						] as IntersectionObserverEntry[],
						this as unknown as IntersectionObserver,
					),
				);
			}
			disconnect() {}
		},
	);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
		new DOMRect(0, 0, 200, 200),
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(() => root.unmount());
	window.getSelection()?.removeAllRanges();
	container.remove();
	for (const id of readers.keys()) clearTranslationSelectionBands(id);
	readers.clear();
	clearSelections();
	resetLinkPreviewDragForTests();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("keeps bands, menu, and Chinese copy across A → B → A with both readers mounted", async () => {
	const render = (active: string, enabledB = true, mountB = true) =>
		act(() =>
			root.render([
				createElement(Reader, { key: "A", id: "A", active: active === "A" }),
				mountB &&
					createElement(Reader, {
						key: "B",
						id: "B",
						active: active === "B",
						enabled: enabledB,
					}),
			]),
		);
	await render("A");
	for (const id of ["A", "B", "A"]) {
		await render(id);
		await pick(id);
		const other = id === "A" ? "B" : "A";
		expect(translationSelectionBandsFor(id, 0)).toHaveLength(1);
		expect(translationSelectionBandsFor(other, 0)).toHaveLength(0);
		expect(readers.get(id)?.selectionMenu).toMatchObject({
			fromTranslation: true,
			copyText: "中文译文",
			anchor: { quote: "Original sentence." },
		});
		expect(copySelection()).toBe("中文译文");
	}
	// Disabling and then unmounting an unrelated viewer must not erase A.
	await render("A", false);
	expect(translationSelectionBandsFor("A", 0)).toHaveLength(1);
	await render("A", true);
	await pick("A");
	expect(translationSelectionBandsFor("A", 0)).toHaveLength(1);
	await render("A", true, false);
	expect(translationSelectionBandsFor("A", 0)).toHaveLength(1);
	expect(copySelection()).toBe("中文译文");
});

it("lets a visible unfocused split pane select and resets a drag when it becomes hidden", async () => {
	await act(() =>
		root.render([
			createElement(Reader, { key: "A", id: "A", active: false }),
			createElement(Reader, { key: "B", id: "B", active: true }),
		]),
	);
	await pick("A");
	expect(translationSelectionBandsFor("A", 0)).toHaveLength(1);
	expect(translationSelectionBandsFor("B", 0)).toHaveLength(0);
	await pick("A", { release: false });
	expect(linkPreviewDragActive()).toBe(true);
	const host = container.querySelector('[data-reader="A"]');
	if (!host) throw new Error("missing reader A");
	await act(() => visibility.get(host)?.(false));
	expect(translationSelectionBandsFor("A", 0)).toHaveLength(0);
	expect(linkPreviewDragActive()).toBe(false);
	expect(window.getSelection()?.toString()).toBe("");
	await act(() => visibility.get(host)?.(true));
	await pick("A");
	expect(translationSelectionBandsFor("A", 0)).toHaveLength(1);
	expect(linkPreviewDragActive()).toBe(false);
});

it("discards a pending source lookup when the reader is hidden and can select after returning", async () => {
	let finish!: (glyphs: never[]) => void;
	const lookup = new Promise<never[]>((resolve) => {
		finish = resolve;
	});
	const engine = {
		getPageGlyphs: () => ({ toPromise: () => lookup }),
		getTextSlices: () => ({ toPromise: async () => [] }),
	} as unknown as PdfEngine;
	await act(() =>
		root.render(createElement(Reader, { id: "A", active: true, engine })),
	);
	await pick("A");
	expect(readers.get("A")?.selectionMenu).toBeNull();
	const host = container.querySelector('[data-reader="A"]');
	if (!host) throw new Error("missing reader A");
	await act(() => visibility.get(host)?.(false));
	await act(async () => finish([]));
	expect(readers.get("A")?.selectionMenu).toBeNull();
	expect(translationSelectionBandsFor("A", 0)).toHaveLength(0);
	expect(linkPreviewDragActive()).toBe(false);
	await act(() => visibility.get(host)?.(true));
	await pick("A");
	expect(readers.get("A")?.selectionMenu?.copyText).toBe("中文译文");
	expect(translationSelectionBandsFor("A", 0)).toHaveLength(1);
	expect(copySelection()).toBe("中文译文");
});
