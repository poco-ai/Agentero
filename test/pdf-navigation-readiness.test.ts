// @vitest-environment happy-dom
import { createBehaviorEmitter } from "@embedpdf/core";
import type {
	LayoutReadyEvent,
	ScrollCapability,
	ScrollScope,
} from "@embedpdf/plugin-scroll";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { usePdfNavigation } from "@/components/viewer/pdf/hooks/use-pdf-navigation";
import {
	beginPdfNavigation,
	completePdfNavigation,
	type PdfNavigationTarget,
} from "@/lib/pdf/pending-pdf-page";
import { scrollToPdfRegion } from "@/lib/pdf/region-navigation";

const mocks = vi.hoisted(() => ({
	capability: null as unknown as ScrollCapability,
	read: vi.fn(() => 7),
	write: vi.fn(),
}));
vi.mock("@embedpdf/plugin-scroll/react", () => ({
	useScrollCapability: () => ({ provides: mocks.capability }),
}));
vi.mock("@/lib/pdf/reading-position", () => ({
	readReadingPage: mocks.read,
	writeReadingPage: mocks.write,
}));
vi.mock("@/lib/pdf/region-navigation", () => ({ scrollToPdfRegion: vi.fn() }));
afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

it("waits for embed layout, navigates once per target, and restores the target on remount", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const ready = createBehaviorEmitter<LayoutReadyEvent>();
	const scope = { getMetrics: () => ({ currentPage: 1 }) } as ScrollScope;
	mocks.capability = {
		onLayoutReady: ready.on,
		forDocument: () => scope,
	} as unknown as ScrollCapability;
	const target = {
		page: 3,
		region: {
			id: "p1",
			pageIndex: 2,
			bbox: { x: 0.5, y: 0.4, w: 0.4, h: 0.1 },
		},
	};
	function Viewer({
		target,
		request,
	}: {
		target: PdfNavigationTarget;
		request?: number;
	}) {
		usePdfNavigation({
			docId: "embed::r1",
			baseDocId: "embed",
			embeddedTarget: target,
			embeddedTargetRequest: request,
			paperKey: null,
			currentPage: 1,
			totalPages: 10,
			scroll: null,
			scrollRef: useRef(null),
			docCapRef: useRef(null),
		});
		return null;
	}
	const root = createRoot(document.createElement("div"));
	try {
		await act(() => root.render(createElement(Viewer, { target })));
		expect(scrollToPdfRegion).not.toHaveBeenCalled();
		await act(() =>
			ready.emit({
				documentId: "embed::r1",
				totalPages: 10,
				pageNumber: 1,
				isInitial: true,
			}),
		);
		expect(scrollToPdfRegion).toHaveBeenCalledExactlyOnceWith(
			"embed::r1",
			target.region,
			undefined,
			scope,
			{ embedded: true },
		);
		await act(() => root.render(createElement(Viewer, { target })));
		await act(() =>
			ready.emit({
				documentId: "embed::r1",
				totalPages: 10,
				pageNumber: 3,
				isInitial: false,
			}),
		);
		expect(scrollToPdfRegion).toHaveBeenCalledOnce();
		await act(() => root.render(createElement(Viewer, { target, request: 1 })));
		expect(scrollToPdfRegion).toHaveBeenCalledTimes(2);
		expect(scrollToPdfRegion).toHaveBeenLastCalledWith(
			"embed::r1",
			target.region,
			undefined,
			scope,
			{ embedded: true },
		);
		await act(() => root.render(createElement(Viewer, { target, request: 1 })));
		expect(scrollToPdfRegion).toHaveBeenCalledTimes(2);
		const next = { ...target, region: { ...target.region, id: "p2" } };
		await act(() => root.render(createElement(Viewer, { target: next })));
		expect(scrollToPdfRegion).toHaveBeenCalledTimes(3);
		await act(() => root.render(null));
		await act(() => root.render(createElement(Viewer, { target: next })));
		expect(scrollToPdfRegion).toHaveBeenCalledTimes(4);
	} finally {
		await act(() => root.unmount());
	}
});

it("uses replayed layout readiness and capability scope for a cold citation before reading restore", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const ready = createBehaviorEmitter<LayoutReadyEvent>();
	const scrollToPage = vi.fn();
	const scope = {
		scrollToPage,
		getMetrics: () => ({ currentPage: 1 }),
	} as unknown as ScrollScope;
	mocks.capability = {
		onLayoutReady: ready.on,
		forDocument: () => scope,
	} as unknown as ScrollCapability;
	const intent = beginPdfNavigation("cold-tab");
	completePdfNavigation(intent, { page: 12 });
	// The event is emitted before the hook subscribes, just like Scroller's
	// layout effect runs before the viewer's passive subscription effect.
	ready.emit({
		documentId: "cold-tab::r1",
		totalPages: 20,
		pageNumber: 1,
		isInitial: true,
	});
	function Viewer() {
		usePdfNavigation({
			docId: "cold-tab::r1",
			baseDocId: "cold-tab",
			paperKey: "paper",
			currentPage: 1,
			totalPages: 1,
			scroll: null,
			scrollRef: { current: null },
			docCapRef: { current: null },
		});
		return null;
	}
	const root = createRoot(document.createElement("div"));
	try {
		await act(() => root.render(createElement(Viewer)));
		expect(scrollToPage).toHaveBeenCalledExactlyOnceWith({
			pageNumber: 12,
			behavior: "instant",
		});
		expect(mocks.read).not.toHaveBeenCalled();
		await act(() =>
			ready.emit({
				documentId: "cold-tab::r1",
				totalPages: 20,
				pageNumber: 12,
				isInitial: false,
			}),
		);
		expect(scrollToPage).toHaveBeenCalledOnce();
	} finally {
		await act(() => root.unmount());
	}
});
