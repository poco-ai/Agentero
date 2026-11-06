// @vitest-environment happy-dom
import {
	PluginRegistry,
	setDocumentLoaded,
	startLoadingDocument,
} from "@embedpdf/core";
import { PDFContext, type PDFContextState } from "@embedpdf/core/react";
import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { ScrollPlugin, ScrollPluginPackage } from "@embedpdf/plugin-scroll";
import { SpreadPluginPackage } from "@embedpdf/plugin-spread";
import { ViewportPluginPackage } from "@embedpdf/plugin-viewport";
import { ZoomPlugin, ZoomPluginPackage } from "@embedpdf/plugin-zoom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePdfReadingMode } from "@/components/viewer/pdf/hooks/use-pdf-reading-mode";
import { DockviewViewport } from "@/components/viewer/pdf/viewport/dockview-viewport";
import { KeyboardScrollHandler } from "@/components/viewer/pdf/viewport/keyboard-scroll-handler";
import { PdfScroller } from "@/components/viewer/pdf/viewport/pdf-scroller";
import { settingsStore } from "@/lib/settings/react-store";

const docId = "paginated-test";
const originalSettings = settingsStore.getState();
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	settingsStore.setState({
		pdfScrollStrategy: "paginated",
		pdfSpreadMode: "odd",
	});
});
afterEach(() => {
	settingsStore.setState(originalSettings);
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("shows one page, turns via wheel/keys/links, and preserves the page when returning to continuous mode", async () => {
	const registry = new PluginRegistry({} as PdfEngine);
	registry.registerPlugin(ViewportPluginPackage, { viewportGap: 10 });
	registry.registerPlugin(SpreadPluginPackage);
	registry.registerPlugin(ScrollPluginPackage);
	registry.registerPlugin(ZoomPluginPackage, { defaultZoomLevel: 1 });
	await registry.initialize();
	registry.getStore().dispatchToCore(startLoadingDocument(docId));
	registry.getStore().dispatchToCore(
		setDocumentLoaded(docId, {
			id: docId,
			pageCount: 3,
			pages: [800, 100, 900].map((height, index) => ({
				index,
				size: { width: 600, height },
			})),
		} as PdfDocumentObject),
	);
	const scroll = registry
		.getPlugin<ScrollPlugin>(ScrollPlugin.id)
		?.provides()
		.forDocument(docId);
	if (!scroll) throw new Error("Scroll plugin did not initialize");
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	let notifyResize = () => {};
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				notifyResize = callback;
			}
			observe() {}
			disconnect() {}
		},
	);
	function Viewer() {
		usePdfReadingMode(docId);
		return createElement(DockviewViewport, {
			documentId: docId,
			hostRef: { current: container },
			// biome-ignore lint/correctness/noChildrenProp: required by DockviewViewportProps
			children: [
				createElement(KeyboardScrollHandler, {
					documentId: docId,
					active: true,
					hostRef: { current: container },
				}),
				createElement(PdfScroller, {
					documentId: docId,
					renderPage: (page) =>
						createElement(
							"span",
							{ "data-test-page": page.pageNumber },
							page.pageNumber,
						),
				}),
			],
		});
	}
	const settle = () => act(() => vi.advanceTimersByTimeAsync(250));
	try {
		await act(() =>
			root.render(
				createElement(
					PDFContext.Provider,
					{ value: { registry, pluginsReady: true } as PDFContextState },
					createElement(Viewer),
				),
			),
		);
		const viewport = container.firstElementChild as HTMLDivElement;
		for (const key of ["offsetWidth", "clientWidth", "scrollWidth"])
			Object.defineProperty(viewport, key, { get: () => 700 });
		for (const key of ["offsetHeight", "clientHeight"])
			Object.defineProperty(viewport, key, { get: () => 600 });
		Object.defineProperty(viewport, "scrollHeight", { get: () => 2600 });
		viewport.scrollTo = vi.fn((options: ScrollToOptions) => {
			viewport.scrollTop = options.top ?? viewport.scrollTop;
			viewport.scrollLeft = options.left ?? viewport.scrollLeft;
			viewport.dispatchEvent(new Event("scroll"));
		}) as typeof viewport.scrollTo;
		notifyResize();
		await settle();
		await act(() =>
			registry
				.getPlugin<ZoomPlugin>(ZoomPlugin.id)
				?.provides()
				.forDocument(docId)
				.requestZoom(1),
		);
		await settle();
		const visiblePages = () =>
			[...container.querySelectorAll("[data-test-page]")].map((el) =>
				Number(el.getAttribute("data-test-page")),
			);

		expect(visiblePages()).toEqual([1]);
		const arrow = async (
			key: "ArrowDown" | "ArrowUp",
			target?: EventTarget,
		) => {
			await act(() =>
				(target ?? viewport).dispatchEvent(
					new KeyboardEvent("keydown", {
						key,
						bubbles: true,
						cancelable: true,
					}),
				),
			);
			await settle();
		};
		// Paginated layout: arrows turn pages from the focused/hovered reader.
		await arrow("ArrowDown");
		expect(scroll.getCurrentPage()).toBe(2);
		expect(visiblePages()).toEqual([2]);
		await arrow("ArrowUp");
		expect(scroll.getCurrentPage()).toBe(1);
		// A field keeps its own arrow keys.
		const arrowField = document.createElement("input");
		viewport.append(arrowField);
		await arrow("ArrowDown", arrowField);
		expect(scroll.getCurrentPage()).toBe(1);
		arrowField.remove();
		await act(() =>
			viewport.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "PageUp",
					bubbles: true,
					cancelable: true,
				}),
			),
		);
		await settle();
		expect(scroll.getCurrentPage()).toBe(1);
		// Scroll within the tall page before turning at its lower edge.
		const wheel = async (time: number, deltaY: number) => {
			const event = new WheelEvent("wheel", {
				deltaY,
				bubbles: true,
				cancelable: true,
			});
			Object.defineProperty(event, "timeStamp", { value: time });
			await act(() => {
				viewport.dispatchEvent(event);
				viewport.dispatchEvent(new Event("scroll"));
			});
			await settle();
		};
		await wheel(0, 1000);
		expect(scroll.getCurrentPage()).toBe(1);
		await wheel(200, 100);
		expect(scroll.getCurrentPage()).toBe(2);
		expect(visiblePages()).toEqual([2]);
		// A short page followed by a tall page must not silently select its neighbour.
		await wheel(216, 100);
		expect(scroll.getCurrentPage()).toBe(2);
		await wheel(500, 100);
		expect(scroll.getCurrentPage()).toBe(3);
		expect(visiblePages()).toEqual([3]);
		await act(() =>
			viewport.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "PageDown",
					bubbles: true,
					cancelable: true,
				}),
			),
		);
		await settle();
		expect(scroll.getCurrentPage()).toBe(3);
		const field = document.createElement("input");
		viewport.append(field);
		await act(() =>
			field.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "PageUp",
					bubbles: true,
					cancelable: true,
				}),
			),
		);
		await settle();
		expect(scroll.getCurrentPage()).toBe(3);
		field.remove();
		await act(() =>
			viewport.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "PageUp",
					bubbles: true,
					cancelable: true,
				}),
			),
		);
		await settle();
		expect(scroll.getCurrentPage()).toBe(2);
		await act(() => scroll.scrollToPage({ pageNumber: 1, behavior: "smooth" }));
		await settle();
		expect(visiblePages()).toEqual([1]);
		expect(vi.mocked(viewport.scrollTo).mock.lastCall?.[0]).toMatchObject({
			behavior: "instant",
		});
		await act(() =>
			scroll.scrollToPage({ pageNumber: 3, behavior: "instant" }),
		);
		await settle();
		await act(() =>
			settingsStore.setState({
				pdfScrollStrategy: "horizontal",
				pdfSpreadMode: "none",
			}),
		);
		await settle();
		expect(scroll.getCurrentPage()).toBe(3);
		expect(viewport.style.overflowY).not.toBe("hidden");
		await act(() =>
			settingsStore.setState({
				pdfScrollStrategy: "vertical",
				pdfSpreadMode: "none",
			}),
		);
		await settle();
		// Continuous layout: arrows scroll the reading position instead of turning.
		const beforeArrow = viewport.scrollTop;
		await act(() =>
			viewport.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "ArrowDown",
					bubbles: true,
					cancelable: true,
				}),
			),
		);
		expect(viewport.scrollTop).toBe(beforeArrow + 72);
		await act(() =>
			viewport.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "ArrowUp",
					bubbles: true,
					cancelable: true,
				}),
			),
		);
		expect(viewport.scrollTop).toBe(beforeArrow);
	} finally {
		await act(() => root.unmount());
		container.remove();
		await registry.destroy();
	}
});
