// @vitest-environment happy-dom
import { createRequire } from "node:module";
import {
	PluginRegistry,
	setDocumentLoaded,
	startLoadingDocument,
} from "@embedpdf/core";
import { PDFContext, type PDFContextState } from "@embedpdf/core/react";
import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { RenderPluginPackage } from "@embedpdf/plugin-render";
import { ScrollPlugin, ScrollPluginPackage } from "@embedpdf/plugin-scroll";
import {
	type Tile,
	TilingPlugin,
	TilingPluginPackage,
} from "@embedpdf/plugin-tiling";
import {
	ViewportPlugin,
	ViewportPluginPackage,
} from "@embedpdf/plugin-viewport";
import { ZoomMode, ZoomPlugin, ZoomPluginPackage } from "@embedpdf/plugin-zoom";
import { ZoomGestureWrapper } from "@embedpdf/plugin-zoom/react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DockviewViewport } from "@/components/viewer/pdf/viewport/dockview-viewport";

const docId = "gutter";
const gutter = 212;

async function createRegistry(
	zoomPackage = ZoomPluginPackage,
	viewportPaddingRight?: number,
) {
	const registry = new PluginRegistry({} as PdfEngine);
	registry.registerPlugin(ViewportPluginPackage, { viewportGap: 20 });
	registry.registerPlugin(ScrollPluginPackage);
	registry.registerPlugin(RenderPluginPackage);
	registry.registerPlugin(TilingPluginPackage);
	registry.registerPlugin(zoomPackage, {
		defaultZoomLevel: ZoomMode.FitWidth,
		viewportPaddingRight,
	});
	await registry.initialize();
	registry.getStore().dispatchToCore(startLoadingDocument(docId));
	registry.getStore().dispatchToCore(
		setDocumentLoaded(docId, {
			id: docId,
			pageCount: 1,
			pages: [{ index: 0, size: { width: 600, height: 800 } }],
		} as PdfDocumentObject),
	);
	const viewport = registry.getPlugin<ViewportPlugin>(ViewportPlugin.id);
	const zoom = registry.getPlugin<ZoomPlugin>(ZoomPlugin.id);
	const scroll = registry.getPlugin<ScrollPlugin>(ScrollPlugin.id);
	const tiling = registry.getPlugin<TilingPlugin>(TilingPlugin.id);
	if (!viewport || !zoom || !scroll || !tiling) {
		throw new Error("PDF plugins did not initialize");
	}
	return {
		registry,
		viewport,
		zoom: zoom.provides().forDocument(docId),
		scroll: scroll.provides().forDocument(docId),
		tiling: tiling.provides().forDocument(docId),
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("keeps high-resolution tiles over the whole scrollport after zoom and split resize", async () => {
	const { registry, viewport, zoom, scroll, tiling } = await createRegistry();
	const container = document.createElement("div");
	const root = createRoot(container);
	let tiles: Record<number, Tile[]> = {};
	const unsubscribe = tiling.onTileRendering((next) => {
		tiles = next;
	});
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
	try {
		await act(() =>
			root.render(
				createElement(
					PDFContext.Provider,
					{ value: { registry } as PDFContextState },
					createElement(DockviewViewport, {
						documentId: docId,
						hostRef: { current: container },
						// biome-ignore lint/correctness/noChildrenProp: required by DockviewViewportProps
						children: "page",
					}),
				),
			),
		);
		const element = container.firstElementChild as HTMLDivElement;
		let width = 900;
		for (const key of ["offsetWidth", "clientWidth", "scrollWidth"]) {
			Object.defineProperty(element, key, { get: () => width });
		}
		for (const key of ["offsetHeight", "clientHeight", "scrollHeight"]) {
			Object.defineProperty(element, key, { get: () => 800 });
		}
		const resize = async () => {
			notifyResize();
			await act(() => vi.advanceTimersByTimeAsync(200));
		};
		await resize();
		expect(
			viewport.provides().forDocument(docId).getMetrics().clientWidth,
		).toBe(900);
		expect(zoom.getState().currentZoomLevel).toBe(1.433);
		// No side gutter: the reading surface is the whole scrollport.
		expect(element.style.paddingRight).toBe("20px");

		zoom.requestZoom(2);
		await act(() => vi.advanceTimersByTimeAsync(200));
		// Pan to the left edge: the page is wider than the viewport, so the
		// visible strip needs the column beyond x = 512.
		element.scrollLeft = 0;
		await resize();
		expect(scroll.getMetrics().pageVisibilityMetrics[0].scaled).toMatchObject({
			pageX: 0,
			visibleWidth: 900,
		});
		expect(tiles[0].some((tile) => tile.col === 1)).toBe(true);

		width = 760;
		element.scrollLeft = 100;
		await resize();
		expect(zoom.getState().currentZoomLevel).toBe(2);
		expect(scroll.getMetrics().pageVisibilityMetrics[0].scaled).toMatchObject({
			pageX: 100,
			visibleWidth: 760,
		});
		expect(tiles[0].some((tile) => tile.col === 1)).toBe(true);
	} finally {
		unsubscribe();
		await act(() => root.unmount());
		await registry.destroy();
	}
});

it.each([
	"import",
	"require",
])("%s: preserves fit-width, zoom focus, and default zero padding without changing viewport metrics", async (mode) => {
	const zoomPackage: typeof ZoomPluginPackage =
		mode === "import"
			? ZoomPluginPackage
			: createRequire(import.meta.url)("@embedpdf/plugin-zoom")
					.ZoomPluginPackage;
	for (const padding of [undefined, gutter]) {
		const { registry, viewport, zoom } = await createRegistry(
			zoomPackage,
			padding,
		);
		try {
			viewport.setViewportResizeMetrics(docId, {
				width: 900,
				clientWidth: 900,
				height: 800,
				clientHeight: 800,
				scrollWidth: 900,
				scrollHeight: 800,
				scrollLeft: 0,
				scrollTop: 0,
				clientLeft: 0,
				clientTop: 0,
			});
			await vi.advanceTimersByTimeAsync(200);
			expect(zoom.getState().currentZoomLevel).toBe(padding ? 1.08 : 1.433);
			const onZoom = vi.fn();
			zoom.onZoomChange(onZoom);
			zoom.requestZoom(2);
			expect(onZoom.mock.lastCall?.[0]).toMatchObject({
				center: { vx: padding ? 344 : 450, vy: 400 },
			});
			expect(onZoom.mock.lastCall?.[0].desiredScrollLeft).toBeCloseTo(
				padding ? 276 : 170,
			);
			zoom.zoomToArea(0, {
				origin: { x: 0, y: 0 },
				size: { width: 600, height: 200 },
			});
			expect(zoom.getState().currentZoomLevel).toBe(padding ? 1.08 : 1.43);
			expect(viewport.provides().forDocument(docId).getMetrics()).toMatchObject(
				{
					width: 900,
					clientWidth: 900,
				},
			);
		} finally {
			await registry.destroy();
		}
	}
});

it("centers the zoom gesture in the reading box", async () => {
	const observed: { target: Element; notify: () => void }[] = [];
	vi.stubGlobal(
		"ResizeObserver",
		class {
			private notify: () => void;
			constructor(callback: () => void) {
				this.notify = callback;
			}
			observe(target: Element) {
				observed.push({ target, notify: this.notify });
			}
			disconnect() {}
		},
	);
	const { registry } = await createRegistry(ZoomPluginPackage, gutter);
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	let pageWidth = 0;
	try {
		await act(() =>
			root.render(
				createElement(
					PDFContext.Provider,
					{ value: { registry } as PDFContextState },
					createElement(DockviewViewport, {
						documentId: docId,
						hostRef: { current: container },
						// biome-ignore lint/correctness/noChildrenProp: required by DockviewViewportProps
						children: createElement(
							ZoomGestureWrapper,
							{
								documentId: docId,
								enablePinch: false,
								enableWheel: false,
							},
							"page",
						),
					}),
				),
			),
		);
		const viewport = container.firstElementChild as HTMLDivElement;
		for (const key of ["offsetWidth", "clientWidth", "scrollWidth"]) {
			Object.defineProperty(viewport, key, { get: () => 900 });
		}
		for (const key of ["offsetHeight", "clientHeight", "scrollHeight"]) {
			Object.defineProperty(viewport, key, { get: () => 800 });
		}
		observed.find((entry) => entry.target === viewport)?.notify();
		await act(() => vi.advanceTimersByTimeAsync(200));

		const gesture = viewport.firstElementChild as HTMLDivElement;
		expect(viewport.style.paddingRight).toBe("20px");
		Object.defineProperty(gesture, "offsetWidth", { get: () => pageWidth });
		const notifyGesture = observed.find(
			(entry) => entry.target === gesture,
		)?.notify;
		expect(notifyGesture).toBeTypeOf("function");

		// Fit-width already fills the reading box, so there is no leftover margin.
		pageWidth = 900 - 40;
		notifyGesture?.();
		expect(gesture.style.marginLeft).toBe("0px");

		pageWidth = 400;
		notifyGesture?.();
		expect(gesture.style.marginLeft).toBe("230px");
	} finally {
		await act(() => root.unmount());
		container.remove();
		await registry.destroy();
	}
});
