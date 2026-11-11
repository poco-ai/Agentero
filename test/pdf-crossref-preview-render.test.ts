// @vitest-environment happy-dom
import {
	type PdfDocumentObject,
	type PdfEngine,
	type PdfLinkAnnoObject,
	PdfZoomMode,
} from "@embedpdf/models";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePdfCrossrefPreview } from "@/components/viewer/pdf/hooks/use-pdf-crossref-preview";
import type { PdfLinkHoverPoint } from "@/components/viewer/pdf/types";
import type {
	CitationLinkKey,
	CrossrefLinkLabelList,
} from "@/lib/pdf/citation-dest-keys";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

const { renderRegion, layout, citationLinks, crossrefLinks, citationTargets } =
	vi.hoisted(() => ({
		renderRegion: vi.fn(async () => ({ mimeType: "image/png", data: "AA==" })),
		layout: { regions: [] as PdfLayoutRegion[] },
		citationLinks: [] as CitationLinkKey[],
		crossrefLinks: [] as CrossrefLinkLabelList[number][],
		citationTargets: new Map<
			string,
			{ pageIndex: number; pdfX: number | null; pdfY: number }
		>(),
	}));
vi.mock("@/components/viewer/pdf/region-crop", () => ({
	renderPdfRegionPromptImage: renderRegion,
}));
vi.mock("@/lib/pdf/layout", () => ({ getLayoutDocumentResult: () => layout }));
vi.mock("@/lib/pdf/citation-dest-map", () => ({
	schedulePdfDestMapsBuild: ({
		onMaps,
	}: {
		onMaps: (maps: unknown) => void;
	}) => {
		onMaps({
			crossrefs: new Map([["2:740.0", "figure"]]),
			crossrefKinds: new Map(),
			crossrefLabels: new Map(),
			crossrefLinks,
			pageOrigins: [],
			cites: new Map(),
			citationLinks,
			citationTargets,
			otherNamedLinks: [],
		});
		return () => {};
	},
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	citationLinks.length = 0;
	citationTargets.clear();
	crossrefLinks.length = 0;
	layout.regions = [];
	host = document.createElement("div");
	host.innerHTML = '<div data-embed-pdf-page="0"></div>';
	document.body.append(host);
	root = createRoot(document.createElement("div"));
});

it("previews every linked author-year member in one printed group across bibliography pages", async () => {
	const source = "Evidence (Alpha 2020; Beta 2021) remains.";
	for (const [key, year, pageIndex] of [
		["a", "2020", 1],
		["b", "2021", 2],
	] as const) {
		citationLinks.push({
			pageIndex: 0,
			x: 50 + source.indexOf(year) * 5,
			y: 100,
			w: 20,
			h: 10,
			key,
		});
		citationTargets.set(key, { pageIndex, pdfX: 50, pdfY: 700 });
	}
	const row = (content: string) => ({
		content,
		rect: {
			origin: { x: 50, y: 100 },
			size: { width: content.length * 5, height: 10 },
		},
	});
	const doc = {
		pages: [0, 1, 2].map((index) => ({
			index,
			size: { width: 600, height: 800 },
		})),
	} as PdfDocumentObject;
	let preview!: ReturnType<typeof usePdfCrossrefPreview>;
	function Probe() {
		preview = usePdfCrossrefPreview({
			docId: "pdf",
			hostRef: { current: host },
			zoomRef: { current: 1 },
			paperAbsPath: "/paper",
			engineRef: {
				current: {
					getPageTextRects: (_d: unknown, page: { index: number }) => ({
						toPromise: async () => [
							row(
								[
									source,
									"Alpha, A. 2020. First paper.",
									"Beta, B. 2021. Second paper.",
								][page.index],
							),
						],
					}),
				} as unknown as PdfEngine,
			},
			docCapRef: {
				current: { getDocument: () => doc },
			} as unknown as Parameters<typeof usePdfCrossrefPreview>[0]["docCapRef"],
		});
		return null;
	}
	await act(() => root.render(createElement(Probe)));
	const part = citationLinks[0];
	const link = {
		id: "authors",
		pageIndex: 0,
		rect: {
			origin: { x: part.x, y: part.y },
			size: { width: part.w, height: part.h },
		},
		target: {
			type: "destination",
			destination: {
				pageIndex: 1,
				zoom: { mode: PdfZoomMode.XYZ, params: { x: 50, y: 700 } },
				view: [],
			},
		},
	} as unknown as PdfLinkAnnoObject;
	await act(async () =>
		preview.handleCrossrefLinkHover(link, { x: 450, y: 320 }),
	);
	expect(preview.crossrefPreview?.referenceImages).toHaveLength(2);
	expect(
		renderRegion.mock.calls.map(
			(call) => (call[0] as { pageIndex: number }).pageIndex,
		),
	).toEqual([1, 2]);
});

it("joins adjacent author and year links before recovering a stale bibliography destination in both modes", async () => {
	const source = "See Alpha and Beta (2020) for details.";
	const rect = (x: number, y: number, w: number, content: string) => ({
		content,
		rect: { origin: { x, y }, size: { width: w, height: 10 } },
	});
	const authors = {
		pageIndex: 0,
		x: 70,
		y: 100,
		w: 70,
		h: 10,
		key: "arbitrary-key",
	};
	const year = {
		pageIndex: 0,
		x: 145,
		y: 100,
		w: 30,
		h: 10,
		key: "arbitrary-key",
	};
	citationLinks.push(authors, year);
	const doc = {
		pages: [0, 1].map((index) => ({
			index,
			size: { width: 600, height: 800 },
		})),
	} as PdfDocumentObject;
	let preview!: ReturnType<typeof usePdfCrossrefPreview>;
	function Probe() {
		preview = usePdfCrossrefPreview({
			docId: "pdf",
			hostRef: { current: host },
			zoomRef: { current: 1.5 },
			paperAbsPath: "/paper",
			engineRef: {
				current: {
					getPageTextRects: (_doc: unknown, page: { index: number }) => ({
						toPromise: async () =>
							page.index === 0
								? [rect(50, 100, source.length * 5, source)]
								: [
										rect(55, 80, 100, "References"),
										rect(
											55,
											600,
											450,
											"Alpha, Anne and Ben Beta. 2020. Requested paper.",
										),
										rect(67, 614, 430, "Journal of Examples 1:1–10."),
										rect(55, 640, 450, "Other, Owen. 2021. Another paper."),
									],
					}),
				} as unknown as PdfEngine,
			},
			docCapRef: {
				current: { getDocument: () => doc },
			} as unknown as Parameters<typeof usePdfCrossrefPreview>[0]["docCapRef"],
		});
		return null;
	}
	await act(() => root.render(createElement(Probe)));
	for (const [i, part] of [authors, year].entries()) {
		const link = {
			id: String(i),
			pageIndex: 0,
			rect: {
				origin: { x: part.x, y: part.y },
				size: { width: part.w, height: part.h },
			},
			target: {
				type: "destination",
				destination: {
					pageIndex: 1,
					zoom: { mode: PdfZoomMode.XYZ, params: { x: -80, y: -60 } },
					view: [],
				},
			},
		} as unknown as PdfLinkAnnoObject;
		for (const screen of [undefined, { x: 450, y: 320 }]) {
			await act(async () => preview.handleCrossrefLinkHover(link, screen));
			expect(preview.crossrefPreview?.kind).toBe("reference");
			expect((preview.crossrefPreview?.region.y ?? 0) * 800).toBeCloseTo(595);
			expect((preview.crossrefPreview?.region.h ?? 0) * 800).toBeLessThan(40);
		}
	}
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

it.each([
	false,
	true,
])("uses the visible author and year when only the year links to a publisher bibliography ID (nearby repeated citation: %s)", async (repeated) => {
	const rect = (x: number, y: number, content: string) => ({
		content,
		rect: { origin: { x, y }, size: { width: content.length * 5, height: 10 } },
	});
	const source = "According to Open Data Institute (2023)";
	const sourceYear = 50 + source.indexOf("2023") * 5;
	citationLinks.push({
		pageIndex: 0,
		x: sourceYear,
		y: 100,
		w: 20,
		h: 10,
		key: "journal-bib-0048",
	});
	if (repeated) citationLinks.push({ ...citationLinks[0], y: 112 });
	const doc = {
		pages: [0, 1].map((index) => ({
			index,
			size: { width: 600, height: 800 },
		})),
	} as PdfDocumentObject;
	let preview!: ReturnType<typeof usePdfCrossrefPreview>;
	function Probe() {
		preview = usePdfCrossrefPreview({
			docId: "pdf",
			hostRef: { current: host },
			zoomRef: { current: 1 },
			paperAbsPath: "/paper",
			engineRef: {
				current: {
					getPageTextRects: (_: unknown, page: { index: number }) => ({
						toPromise: async () =>
							page.index === 0
								? [
										rect(50, 100, source),
										...(repeated ? [rect(50, 112, source)] : []),
									]
								: [
										rect(55, 80, "References"),
										rect(55, 120, "Other, A. 2021. Unrelated work."),
										rect(
											55,
											600,
											"Open Data Institute. 2023. Requested report.",
										),
										rect(
											55,
											614,
											"A long subtitle that stays with the report.",
										),
										rect(55, 628, "https://example.org/report"),
										rect(55, 652, "Writer, B. 2024. The next entry."),
									],
					}),
				} as unknown as PdfEngine,
			},
			docCapRef: {
				current: { getDocument: () => doc },
			} as unknown as Parameters<typeof usePdfCrossrefPreview>[0]["docCapRef"],
		});
		return null;
	}
	await act(() => root.render(createElement(Probe)));
	const link = {
		id: "year-only",
		pageIndex: 0,
		rect: {
			origin: { x: sourceYear, y: 100 },
			size: { width: 20, height: 10 },
		},
		target: {
			type: "destination",
			destination: {
				pageIndex: 1,
				zoom: { mode: PdfZoomMode.XYZ, params: { x: 0, y: 720 } },
				view: [],
			},
		},
	} as unknown as PdfLinkAnnoObject;
	await act(async () =>
		preview.handleCrossrefLinkHover(link, { x: 450, y: 320 }),
	);
	expect(preview.crossrefPreview?.kind).toBe("reference");
	expect((preview.crossrefPreview?.region.y ?? 0) * 800).toBeCloseTo(595);
	expect((preview.crossrefPreview?.region.h ?? 0) * 800).toBeGreaterThan(40);
	expect((preview.crossrefPreview?.region.h ?? 0) * 800).toBeLessThan(55);
});

it.each([
	{ reader: false, stale: false },
	{ reader: true, stale: false },
	{ reader: true, stale: true },
])("previews the native destination without focusing a wrong figure (reader: $reader, stale: $stale)", async ({
	reader,
	stale,
}) => {
	if (reader) host.innerHTML = "";
	const documentObject = {
		pages: Array.from({ length: 3 }, (_, index) => ({
			index,
			size: { width: 600, height: 800 },
		})),
	} as PdfDocumentObject;
	let preview!: ReturnType<typeof usePdfCrossrefPreview>;
	function Probe() {
		preview = usePdfCrossrefPreview({
			docId: "pdf",
			hostRef: { current: host },
			zoomRef: { current: 1.5 },
			previewZoomRef: { current: reader ? 1.8 : null },
			paperAbsPath: "/paper",
			engineRef: {
				current: {
					getPageTextRects: () => ({ toPromise: async () => [] }),
				} as unknown as PdfEngine,
			},
			docCapRef: {
				current: { getDocument: () => documentObject },
			} as unknown as Parameters<typeof usePdfCrossrefPreview>[0]["docCapRef"],
		});
		return null;
	}
	await act(() => root.render(createElement(Probe)));
	const link = {
		pageIndex: 0,
		rect: { origin: { x: 10, y: 10 }, size: { width: 20, height: 10 } },
		target: {
			type: "destination",
			destination: {
				pageIndex: 2,
				zoom: stale
					? { mode: PdfZoomMode.FitRectangle }
					: { mode: PdfZoomMode.XYZ, params: { x: 50, y: 740, z: 0 } },
				view: stale ? [0, 740, 600, 740] : [],
			},
		},
	} as unknown as PdfLinkAnnoObject;
	const anchor = reader ? { x: 450, y: 320, top: 305, bottom: 320 } : undefined;
	if (stale) {
		layout.regions = [
			{
				id: "wrong-figure",
				pageIndex: 2,
				kind: "image",
				score: 1,
				bbox: { x: 0.1, y: 0.4, w: 0.7, h: 0.3 },
				title: "Fig 11. Other caption",
			} as PdfLayoutRegion,
		];
		crossrefLinks.push({
			pageIndex: 0,
			x: 10,
			y: 10,
			w: 20,
			h: 10,
			label: { kind: "figure", number: 13 },
		});
	}
	await act(async () => preview.handleCrossrefLinkHover(link, anchor));
	if (anchor) expect(preview.crossrefPreview?.screen).toEqual(anchor);
	expect(renderRegion).toHaveBeenCalledWith(
		expect.objectContaining({
			pageIndex: 2,
			region: { x: 0, y: 0, w: 1, h: 1 },
		}),
	);
	expect(preview.crossrefPreview?.targetSize).toEqual({
		width: reader ? 1080 : 900,
		height: reader ? 1440 : 1200,
	});
	expect(preview.crossrefPreview).toMatchObject({
		page: 3,
		focusPoint: stale
			? { x: 0.5, y: 0.5 }
			: { x: 50 / 600, y: expect.closeTo(0.075) },
	});
	// Another hover on the same page reuses the raster instead of rendering it again.
	await act(async () => preview.handleCrossrefLinkHover({ ...link }, anchor));
	expect(renderRegion).toHaveBeenCalledTimes(1);
});

it.each([
	"reader",
	"pdf",
])("shows all of 1, 12 and 17 without inserting unrequested numbers after Table 2 (%s)", async (mode) => {
	const source = "Table2 [1,12,17]";
	const rects = [
		{
			content: "[1] First reference.",
			rect: { origin: { x: 40, y: 200 }, size: { width: 220, height: 9 } },
		},
		{
			content: "[2] Next reference.",
			rect: { origin: { x: 40, y: 225 }, size: { width: 220, height: 9 } },
		},
		{
			content: "[12] Twelfth reference.",
			rect: { origin: { x: 315, y: 100 }, size: { width: 220, height: 9 } },
		},
		{
			content: "[13] Next reference.",
			rect: { origin: { x: 315, y: 125 }, size: { width: 220, height: 9 } },
		},
		{
			content: "[17] Seventeenth reference.",
			rect: { origin: { x: 315, y: 250 }, size: { width: 220, height: 9 } },
		},
		{
			content: "[18] Next reference.",
			rect: { origin: { x: 315, y: 275 }, size: { width: 220, height: 9 } },
		},
	];
	const doc = {
		pages: [
			{ index: 0, size: { width: 600, height: 800 } },
			{ index: 1, size: { width: 600, height: 800 } },
		],
	} as PdfDocumentObject;
	let preview!: ReturnType<typeof usePdfCrossrefPreview>;
	function Probe() {
		preview = usePdfCrossrefPreview({
			docId: "pdf",
			hostRef: { current: host },
			zoomRef: { current: 1.5 },
			paperAbsPath: "/paper",
			engineRef: {
				current: {
					getPageTextRects: (_doc: unknown, page: { index: number }) => ({
						toPromise: async () =>
							page.index === 0
								? [
										{
											content: source,
											rect: {
												origin: { x: 50, y: 100 },
												size: { width: source.length * 5, height: 9 },
											},
										},
									]
								: rects,
					}),
				} as unknown as PdfEngine,
			},
			docCapRef: {
				current: { getDocument: () => doc },
			} as unknown as Parameters<typeof usePdfCrossrefPreview>[0]["docCapRef"],
		});
		return null;
	}
	await act(() => root.render(createElement(Probe)));
	const link = {
		id: "whole-bracket",
		pageIndex: 0,
		rect: { origin: { x: 85, y: 100 }, size: { width: 45, height: 9 } },
		target: {
			type: "destination",
			destination: {
				pageIndex: 1,
				zoom: { mode: PdfZoomMode.FitRectangle },
				view: [0, 800, 600, 800],
			},
		},
	} as unknown as PdfLinkAnnoObject;
	for (const [entry] of [
		[1, 200],
		[12, 100],
		[17, 250],
	]) {
		const point: PdfLinkHoverPoint = {
			x: 450,
			y: 320,
			...(mode === "reader"
				? { citation: { entry, range: null, entries: [1, 12, 17] } }
				: {
						sourcePoint: {
							x:
								50 +
								(source.indexOf(String(entry)) + String(entry).length / 2) * 5,
							y: 104,
						},
					}),
		};
		await act(async () => preview.handleCrossrefLinkHover(link, point));
		const state = preview.crossrefPreview;
		expect(state?.kind).toBe("reference");
		if (!state) throw new Error("Missing reference preview");
		expect(state.referenceImages).toHaveLength(3);
		expect(state.referenceEntries).toEqual([1, 12, 17]);
		expect(state.missingReferences).toEqual([]);
		const calls = renderRegion.mock.calls.map(([options]) => options);
		for (const expectedY of [200, 100, 250]) {
			expect(
				calls.some(
					(options) => Math.abs(options.region.y * 800 - (expectedY - 5)) < 1,
				),
			).toBe(true);
		}
		await act(async () => preview.handleCrossrefLinkHover(link, point));
		expect(preview.crossrefPreview).toBe(state);
	}
});

it.each([
	"citation",
	"figure",
	"table-citation",
	"section-number",
])("uses real character positions for a %s and shares the result across modes without requiring layout detection", async (kind) => {
	const documentObject = {
		pages: Array.from({ length: 2 }, (_, index) => ({
			index,
			size: { width: 600, height: 800 },
		})),
	} as PdfDocumentObject;
	const isCitation = kind === "citation" || kind === "table-citation";
	const source =
		kind === "citation"
			? "Wide prose [48,49]"
			: kind === "figure"
				? "See Figure 48"
				: "48";
	const destination =
		kind === "section-number"
			? "Section 48 Results"
			: "48. A bibliography entry";
	const glyphs = (value: string) =>
		[...value].map((_, index) => ({
			origin: { x: 50 + index * 5, y: 100 },
			size: { width: 5, height: 10 },
		}));
	const readGlyphs = vi.fn((_document, page) => ({
		toPromise: async () => glyphs(page.index === 0 ? source : destination),
	}));
	const readSlices = vi.fn((_document, slices) => ({
		toPromise: async () =>
			slices.map(
				(slice: { pageIndex: number; charIndex: number }) =>
					(slice.pageIndex === 0 ? source : destination)[slice.charIndex],
			),
	}));
	let preview!: ReturnType<typeof usePdfCrossrefPreview>;
	function Probe() {
		preview = usePdfCrossrefPreview({
			docId: "pdf",
			hostRef: { current: host },
			zoomRef: { current: 1.5 },
			paperAbsPath: "/paper",
			engineRef: {
				current: {
					getPageGlyphs: readGlyphs,
					getTextSlices: readSlices,
					getPageTextRects: () => ({
						toPromise: async () => [],
					}),
				} as unknown as PdfEngine,
			},
			docCapRef: {
				current: { getDocument: () => documentObject },
			} as unknown as Parameters<typeof usePdfCrossrefPreview>[0]["docCapRef"],
		});
		return null;
	}
	await act(() => root.render(createElement(Probe)));
	const link = {
		pageIndex: 0,
		rect: {
			origin: { x: 50 + source.indexOf("48") * 5, y: 100 },
			size: { width: 10, height: 10 },
		},
		target: {
			type: "destination",
			destination: {
				pageIndex: 1,
				zoom: { mode: PdfZoomMode.XYZ, params: { x: 50, y: 700 } },
				view: [],
			},
		},
	} as unknown as PdfLinkAnnoObject;
	await act(async () => preview.handleCrossrefLinkHover(link));
	if (kind === "section-number") {
		expect(preview.crossrefPreview).toBeNull();
		return;
	}
	expect(preview.crossrefPreview).toMatchObject({
		kind: isCitation ? "reference" : "figure",
		page: 2,
	});
	expect(readGlyphs).toHaveBeenCalledTimes(isCitation ? 2 : 1);
	// Continuous reading supplies a different screen anchor, reusing the PDF
	// source characters and bibliography crop even after its source page unmounts.
	host.innerHTML = "";
	const point = { x: 450, y: 320, top: 300, bottom: 320 };
	await act(async () => preview.handleCrossrefLinkHover(link, point));
	expect(preview.crossrefPreview?.screen).toEqual(point);
	expect(readGlyphs).toHaveBeenCalledTimes(isCitation ? 2 : 1);
	expect(renderRegion).toHaveBeenCalledTimes(1);
});

it("renders every requested entry on its own page and reports an unavailable member", async () => {
	const doc = {
		pages: [0, 1, 2].map((index) => ({
			index,
			size: { width: 600, height: 800 },
		})),
	} as PdfDocumentObject;
	citationTargets.set("mk:ref18", { pageIndex: 1, pdfX: 50, pdfY: 200 });
	citationTargets.set("mk:ref19", { pageIndex: 2, pdfX: 50, pdfY: 700 });
	const row = (n: number, y: number) => ({
		content: `${n}. Reference ${n}.`,
		rect: { origin: { x: 50, y }, size: { width: 200, height: 10 } },
	});
	let preview!: ReturnType<typeof usePdfCrossrefPreview>;
	function Probe() {
		preview = usePdfCrossrefPreview({
			docId: "pdf",
			hostRef: { current: host },
			zoomRef: { current: 1 },
			paperAbsPath: "/paper",
			engineRef: {
				current: {
					getPageTextRects: (_d: unknown, p: { index: number }) => ({
						toPromise: async () =>
							p.index === 1
								? [row(18, 600)]
								: p.index === 2
									? [row(19, 100), row(20, 140)]
									: [],
					}),
				} as unknown as PdfEngine,
			},
			docCapRef: {
				current: { getDocument: () => doc },
			} as unknown as Parameters<typeof usePdfCrossrefPreview>[0]["docCapRef"],
		});
		return null;
	}
	await act(() => root.render(createElement(Probe)));
	const link = {
		id: "cross-page",
		pageIndex: 0,
		rect: { origin: { x: 50, y: 100 }, size: { width: 40, height: 10 } },
		target: {
			type: "destination",
			destination: {
				pageIndex: 1,
				zoom: { mode: PdfZoomMode.XYZ, params: { x: 50, y: 200 } },
				view: [],
			},
		},
	} as unknown as PdfLinkAnnoObject;
	await act(async () =>
		preview.handleCrossrefLinkHover(link, {
			x: 400,
			y: 300,
			citation: { entry: 18, range: null, entries: [18, 19, 22] },
		}),
	);
	expect(preview.crossrefPreview?.referenceEntries).toEqual([18, 19]);
	expect(preview.crossrefPreview?.missingReferences).toEqual([22]);
	expect(renderRegion.mock.calls.map(([o]) => o.pageIndex)).toEqual([1, 2]);
});

it("focuses a display equation by its native coordinate, not the ordinal of inline math on the page", async () => {
	const doc = {
		pages: [0, 1].map((index) => ({
			index,
			size: { width: 600, height: 800 },
		})),
	} as PdfDocumentObject;
	const box = { x: 0.55, y: 0.48, w: 0.3, h: 0.05 };
	layout.regions = [
		{
			id: "inline-math",
			pageIndex: 1,
			kind: "formula",
			score: 1,
			bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.02 },
		},
		{ id: "equation", pageIndex: 1, kind: "formula", score: 1, bbox: box },
	] as PdfLayoutRegion[];
	crossrefLinks.push({
		pageIndex: 0,
		x: 50,
		y: 100,
		w: 10,
		h: 10,
		label: { kind: "equation", number: 1 },
	});
	let preview!: ReturnType<typeof usePdfCrossrefPreview>;
	function Probe() {
		preview = usePdfCrossrefPreview({
			docId: "pdf",
			hostRef: { current: host },
			zoomRef: { current: 1.5 },
			paperAbsPath: "/paper",
			engineRef: { current: {} as PdfEngine },
			docCapRef: {
				current: { getDocument: () => doc },
			} as unknown as Parameters<typeof usePdfCrossrefPreview>[0]["docCapRef"],
		});
		return null;
	}
	await act(() => root.render(createElement(Probe)));
	const link = {
		id: "equation-link",
		pageIndex: 0,
		rect: { origin: { x: 50, y: 100 }, size: { width: 10, height: 10 } },
		target: {
			type: "destination",
			destination: {
				pageIndex: 1,
				zoom: { mode: PdfZoomMode.XYZ, params: { x: 0, y: 400 } },
				view: [],
			},
		},
	} as unknown as PdfLinkAnnoObject;
	for (const point of [undefined, { x: 400, y: 300 }]) {
		await act(async () => preview.handleCrossrefLinkHover(link, point));
		expect(preview.crossrefPreview?.kind).toBe("equation");
		expect(preview.crossrefPreview?.region).toEqual(box);
		expect(renderRegion).toHaveBeenCalledWith(
			expect.objectContaining({ pageIndex: 1, region: box }),
		);
	}
});
