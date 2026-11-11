// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PdfLayoutTranslatePartial } from "@/components/viewer/pdf/hooks/use-pdf-layout-translate";
import { PdfTranslationViewerInner } from "@/components/viewer/pdf/pdf-translation-viewer-inner";

// Mount the real translation pane and recovery popover. PDF capabilities and
// preview work are unrelated to the recovery controls and are not started here.
const fixture = vi.hoisted(() => ({
	partial: null as PdfLayoutTranslatePartial | null,
	running: false,
	preparing: false,
	regions: [{ id: "cached-layout" }],
	noop: () => {},
	complete: vi.fn(),
	retranslate: vi.fn(),
	toggle: vi.fn(),
	page: vi.fn(),
	openSettings: vi.fn(),
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/shell/settings-window", () => ({
	openSettingsWindow: fixture.openSettings,
}));
vi.mock("@embedpdf/plugin-document-manager/react", () => ({
	useDocumentManagerCapability: () => ({ provides: null }),
}));
vi.mock("@embedpdf/plugin-interaction-manager/react", () => ({
	useInteractionManagerCapability: () => {},
	GlobalPointerProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@embedpdf/plugin-scroll/react", () => ({
	useScroll: () => ({ provides: null }),
}));
vi.mock("@embedpdf/plugin-zoom/react", () => ({
	useZoom: () => ({ state: { zoomLevel: 1 } }),
	ZoomGestureWrapper: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/viewer/pdf/engine-provider", () => ({
	usePdfEngineContext: () => ({ engine: null }),
}));
vi.mock("@/components/viewer/pdf/hooks/use-pdf-layout-regions", () => ({
	usePdfLayoutRegions: () => ({
		layoutRawRegions: fixture.regions,
		rawRegionsByPage: new Map(),
	}),
}));
vi.mock("@/components/viewer/pdf/hooks/use-pdf-layout-translate", () => ({
	usePdfLayoutTranslate: () => ({
		layoutTranslateItemsByPage: new Map(),
		layoutTranslatePageStateByPage: new Map(),
		layoutTranslateActive: true,
		layoutTranslateRunning: fixture.running,
		layoutTranslatePreparing: fixture.preparing,
		layoutTranslateWaiting: false,
		layoutTranslateProgress: fixture.preparing ? 0.9 : null,
		layoutTranslatePageCounts: null,
		layoutTranslatePartial: fixture.partial,
		reflowOutput: null,
		toggleLayoutTranslate: fixture.toggle,
		togglePageLayoutTranslate: fixture.page,
	}),
}));
vi.mock("@/components/viewer/pdf/hooks/use-pdf-paper-tone", () => ({
	usePdfPaperTone: () => ({ pdfTone: "light" }),
}));
vi.mock("@/components/viewer/pdf/hooks/use-pdf-reading-mode", () => ({
	usePdfReadingMode: () => {},
}));
vi.mock("@/components/viewer/pdf/hooks/use-pdf-scroll-sync", () => ({
	usePdfScrollSync: () => {},
}));
vi.mock("@/components/viewer/pdf/hooks/use-pdf-zoom-controls", () => ({
	usePdfZoomControls: () => ({ zoomRef: { current: 1 } }),
}));
vi.mock("@/components/viewer/pdf/hooks/use-reflow-display-document", () => ({
	useReflowDisplayDocument: () => null,
}));
vi.mock("@/components/viewer/pdf/hooks/use-pdf-citations", () => ({
	usePdfCitations: () => ({ citationPreview: null }),
}));
vi.mock("@/components/viewer/pdf/hooks/use-pdf-crossref-preview", () => ({
	usePdfCrossrefPreview: () => ({ crossrefPreview: null }),
}));
vi.mock("@/components/viewer/pdf/hooks/use-pdf-link-url-tip", () => ({
	usePdfLinkUrlTip: () => ({ linkUrlTip: null }),
}));
vi.mock("@/components/viewer/pdf/viewport/dockview-viewport", () => ({
	DockviewViewport: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/viewer/pdf/viewport/keyboard-scroll-handler", () => ({
	KeyboardScrollHandler: () => null,
}));
vi.mock("@/components/viewer/pdf/viewport/pan-handler", () => ({
	PanDragHandler: () => null,
}));
vi.mock("@/components/viewer/pdf/viewport/pdf-scroller", () => ({
	PdfScroller: () => null,
}));
vi.mock("@/components/viewer/pdf/viewport/wheel-zoom-handler", () => ({
	WheelZoomHandler: () => null,
}));
vi.mock("@/components/viewer/pdf/layers/page-layers", () => ({
	PdfPageLayers: () => null,
}));
vi.mock("@/lib/pdf/layout", () => ({
	translationSourceKey: () => null,
	mirrorLayoutResultToTranslation: () => fixture.noop,
}));
vi.mock("@/lib/pdf/layout/translated-link-source", () => {
	const source = {};
	return {
		subscribeTranslatedLinkSource: () => fixture.noop,
		getTranslatedLinkSource: () => source,
	};
});
vi.mock("@/lib/pdf/link-preview-drag", () => ({
	linkPreviewDragActive: () => false,
	subscribeLinkPreviewDrag: () => fixture.noop,
}));

let host: HTMLDivElement;
let root: Root;

async function renderPane() {
	await act(() =>
		root.render(
			createElement(PdfTranslationViewerInner, {
				docId: "paper::translation",
				paperAbsPath: "/vault/papers/a",
			}),
		),
	);
}

function action(key: string) {
	const button = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find((node) => node.textContent === `pdf.layoutTranslate.${key}`);
	if (!button) throw new Error(`Missing translation recovery action: ${key}`);
	return button;
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	fixture.running = false;
	fixture.preparing = false;
	fixture.partial = {
		pendingRequired: 1,
		translatedCount: 1,
		totalCount: 2,
		pageRange: { start: 2, end: 2 },
		visible: true,
		open: true,
		completionFailed: false,
		onOpenChange: (open) => {
			if (fixture.partial) fixture.partial = { ...fixture.partial, open };
		},
		onCompleteMissing: fixture.complete,
		onRetranslateAll: fixture.retranslate,
	};
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(() => root.unmount());
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

it("offers completion in the idle translation pane and keeps recovery after closing", async () => {
	await renderPane();
	expect(
		host.querySelector("[data-full-text-translate-partial]"),
	).not.toBeNull();
	expect(fixture.toggle).not.toHaveBeenCalled();
	const close = document.querySelector<HTMLButtonElement>(
		'button[aria-label="pdf.layoutTranslate.close"]',
	);
	expect(close).not.toBeNull();
	await act(() => close?.click());
	await renderPane();
	expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
	const trigger = host.querySelector<HTMLButtonElement>(
		"[data-full-text-translate-partial]",
	);
	expect(trigger).not.toBeNull();
	await act(() => trigger?.click());
	await renderPane();
	await act(() => action("completeMissing").click());
	expect(fixture.complete).toHaveBeenCalledOnce();
	expect(fixture.retranslate).not.toHaveBeenCalled();
	expect(fixture.toggle).not.toHaveBeenCalled();
});

it("keeps the warning collapsed until clicked and tracks its expanded state", async () => {
	if (fixture.partial) fixture.partial = { ...fixture.partial, open: false };
	await renderPane();
	const trigger = host.querySelector<HTMLButtonElement>(
		"[data-full-text-translate-partial]",
	);
	expect(trigger).not.toBeNull();
	expect(trigger?.getAttribute("aria-expanded")).toBe("false");
	expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
	await act(() => trigger?.click());
	await renderPane();
	expect(trigger?.getAttribute("aria-expanded")).toBe("true");
	expect(
		document.querySelector('[data-slot="popover-content"]'),
	).not.toBeNull();
	await act(() => trigger?.click());
	await renderPane();
	expect(trigger?.getAttribute("aria-expanded")).toBe("false");
	expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
});

it("requires confirmation before the translation pane retranslates everything", async () => {
	await renderPane();
	await act(() => action("retranslateAll").click());
	expect(fixture.retranslate).not.toHaveBeenCalled();
	await act(() => action("retranslateConfirm").click());
	expect(fixture.retranslate).toHaveBeenCalledOnce();
	expect(fixture.complete).not.toHaveBeenCalled();
	expect(fixture.toggle).not.toHaveBeenCalled();
});

it("opens translation settings from partial recovery without starting a translation", async () => {
	await renderPane();
	const buttons = [
		...document.querySelectorAll<HTMLButtonElement>(
			'[data-slot="popover-content"] button',
		),
	];
	expect(buttons.map((button) => button.textContent).filter(Boolean)).toEqual([
		"pdf.layoutTranslate.openSettings",
		"pdf.layoutTranslate.completeMissing",
		"pdf.layoutTranslate.retranslateAll",
	]);
	await act(() => action("openSettings").click());
	expect(fixture.openSettings).toHaveBeenCalledExactlyOnceWith("translate");
	expect(fixture.complete).not.toHaveBeenCalled();
	expect(fixture.retranslate).not.toHaveBeenCalled();
	expect(fixture.toggle).not.toHaveBeenCalled();
});

it("keeps recovery usable while cached pages build and hides it during translation", async () => {
	fixture.preparing = true;
	await renderPane();
	expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
	await act(() => action("completeMissing").click());
	expect(fixture.complete).toHaveBeenCalledOnce();

	fixture.preparing = false;
	fixture.running = true;
	if (fixture.partial) fixture.partial = { ...fixture.partial, visible: false };
	await renderPane();
	expect(host.querySelector("[data-full-text-translate-partial]")).toBeNull();
});
