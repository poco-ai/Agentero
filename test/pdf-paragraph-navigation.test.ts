import type { PdfDocumentObject } from "@embedpdf/models";
import type { ScrollScope } from "@embedpdf/plugin-scroll";
import { afterEach, expect, it, vi } from "vitest";
import {
	clearLayoutVaultState,
	layoutAnalysisStore,
	layoutKindFromCitationFragment,
} from "@/lib/pdf/layout/store";
import { scrollToPdfRegion } from "@/lib/pdf/region-navigation";
import layout from "./fixtures/pdf-paragraph-anchors/layout.json";

afterEach(() => {
	clearLayoutVaultState();
	vi.useRealTimers();
});

it("scrolls and flashes the exact paragraph box", () => {
	vi.useFakeTimers();
	const block = layout.regions.find((region) => region.id === "body-2");
	expect(block).toBeDefined();
	if (!block) throw new Error("missing paragraph fixture");
	const scrollToPage = vi.fn();
	const document = {
		pages: [{ size: { width: 600, height: 800 } }],
	} as unknown as PdfDocumentObject;
	scrollToPdfRegion(
		"paragraph-document",
		{
			id: block.id,
			pageIndex: block.pageIndex,
			bbox: block.bbox,
			kind: layoutKindFromCitationFragment("2#p2"),
		},
		document,
		{ scrollToPage } as unknown as ScrollScope,
	);
	expect(scrollToPage).toHaveBeenCalledWith({
		pageNumber: 1,
		behavior: "instant",
		pageCoordinates: { x: 330, y: 120 },
		alignX: 0,
		alignY: 18,
	});
	const focused = layoutAnalysisStore.getState().focused;
	expect(focused).toMatchObject({
		flash: true,
		region: { bbox: block.bbox, kind: "text" },
	});
	vi.runAllTimers();
	expect(layoutAnalysisStore.getState().focused).toBeNull();
});

it("scrolls and flashes a section heading at its raw column bbox", () => {
	vi.useFakeTimers();
	const heading = layout.regions.find((region) => region.id === "h21");
	expect(heading).toBeDefined();
	if (!heading) throw new Error("missing heading fixture");
	const scrollToPage = vi.fn();
	const document = {
		pages: [{ size: { width: 600, height: 800 } }],
	} as unknown as PdfDocumentObject;
	scrollToPdfRegion(
		"section-document",
		{
			id: heading.id,
			pageIndex: heading.pageIndex,
			bbox: heading.bbox,
			kind: layoutKindFromCitationFragment("2"),
		},
		document,
		{ scrollToPage } as unknown as ScrollScope,
	);
	expect(scrollToPage).toHaveBeenCalledWith({
		pageNumber: 1,
		behavior: "instant",
		pageCoordinates: { x: 330, y: 320 },
		alignX: 0,
		alignY: 18,
	});
	expect(layoutAnalysisStore.getState().focused).toMatchObject({
		flash: true,
		region: { bbox: heading.bbox, kind: "header" },
	});
});

it("positions an embedded heading at its raw bbox without taking the main viewer's focus", () => {
	const scrollToPage = vi.fn();
	const region = {
		id: "heading-2.1",
		pageIndex: 0,
		bbox: { x: 0.55, y: 0.3, w: 0.35, h: 0.02 },
		kind: "header" as const,
	};
	const focused = layoutAnalysisStore.getState().focused;
	scrollToPdfRegion(
		"embed-document",
		region,
		{
			pages: [{ size: { width: 600, height: 800 } }],
		} as unknown as PdfDocumentObject,
		{ scrollToPage } as unknown as ScrollScope,
		{ embedded: true },
	);
	expect(scrollToPage).toHaveBeenCalledExactlyOnceWith({
		pageNumber: 1,
		behavior: "instant",
		pageCoordinates: { x: 330, y: 240 },
		alignX: 0,
		alignY: 18,
	});
	expect(layoutAnalysisStore.getState().focused).toBe(focused);
});
