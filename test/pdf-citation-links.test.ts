import type { PdfDestinationObject, PdfLinkTarget } from "@embedpdf/models";
import { PdfActionType, PdfZoomMode } from "@embedpdf/models";
import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	CitationLinkLayer,
	detectPdfTextLinks,
	excludeOverlappingPdfTextLinks,
	getLinkDestination,
} from "@/components/viewer/pdf/layers/citation-links";

function dest(mode: PdfZoomMode, view: number[]): PdfDestinationObject {
	return {
		pageIndex: 2,
		zoom: { mode } as PdfDestinationObject["zoom"],
		view,
	};
}

function target(destination: PdfDestinationObject): PdfLinkTarget {
	return { type: "destination", destination };
}

function actionTarget(destination: PdfDestinationObject): PdfLinkTarget {
	return {
		type: "action",
		action: { type: PdfActionType.Goto, destination },
	};
}

describe("getLinkDestination", () => {
	it("returns null for missing target", () => {
		expect(getLinkDestination(undefined)).toBeNull();
	});

	it("reads /XYZ y from direct destination", () => {
		const d = dest(PdfZoomMode.XYZ, [0, 500, 1]);
		// Type cast: the real runtime object carries params for XYZ mode.
		(
			d as PdfDestinationObject & {
				zoom: { params: { x: number; y: number; zoom: number } };
			}
		).zoom = {
			mode: PdfZoomMode.XYZ,
			params: { x: 0, y: 500, zoom: 1 },
		};
		expect(getLinkDestination(target(d))).toEqual({ pageIndex: 2, pdfY: 500 });
	});

	it("reads /XYZ y from GoTo action", () => {
		const d = dest(PdfZoomMode.XYZ, [0, 600, 0]);
		(
			d as PdfDestinationObject & {
				zoom: { params: { x: number; y: number; zoom: number } };
			}
		).zoom = {
			mode: PdfZoomMode.XYZ,
			params: { x: 0, y: 600, zoom: 0 },
		};
		expect(getLinkDestination(actionTarget(d))).toEqual({
			pageIndex: 2,
			pdfY: 600,
		});
	});

	it("reads /FitR top from view array", () => {
		const d = dest(PdfZoomMode.FitRectangle, [0, 10, 500, 800]);
		expect(getLinkDestination(target(d))).toEqual({ pageIndex: 2, pdfY: 800 });
	});

	it("reads /FitH top from view array", () => {
		const d = dest(PdfZoomMode.FitHorizontal, [750]);
		expect(getLinkDestination(target(d))).toEqual({ pageIndex: 2, pdfY: 750 });
	});

	it("falls back to pdfY 0 for page-only destinations", () => {
		const d = dest(PdfZoomMode.FitPage, []);
		expect(getLinkDestination(target(d))).toEqual({ pageIndex: 2, pdfY: 0 });
	});

	it("falls back to pdfY 0 when /FitR view is incomplete", () => {
		const d = dest(PdfZoomMode.FitRectangle, [0, 10]);
		expect(getLinkDestination(target(d))).toEqual({ pageIndex: 2, pdfY: 0 });
	});
});

describe("detectPdfTextLinks", () => {
	it("turns a plain HTTPS text rectangle into an external link", () => {
		expect(
			detectPdfTextLinks([
				{
					content: "https://github.com/microsoft/microxcaling",
					rect: {
						origin: { x: 322, y: 766 },
						size: { width: 152, height: 9 },
					},
					font: { family: "NimbusRomNo9L-Regu", size: 9 },
				},
			]),
		).toEqual([
			{
				url: "https://github.com/microsoft/microxcaling",
				rect: {
					origin: { x: 322, y: 766 },
					size: { width: 152, height: 9 },
				},
			},
		]);
	});

	it("turns an arXiv identifier into its abstract URL without sentence punctuation", () => {
		const links = detectPdfTextLinks([
			{
				content: "arXiv:2505.22375.",
				rect: {
					origin: { x: 170, y: 734 },
					size: { width: 74, height: 7 },
				},
				font: { family: "Times-Roman", size: 7 },
			},
		]);

		expect(links).toHaveLength(1);
		expect(links[0]?.url).toBe("https://arxiv.org/abs/2505.22375");
	});

	it("detects every URL and arXiv identifier in one text rectangle", () => {
		const links = detectPdfTextLinks([
			{
				content:
					"https://example.com/one arXiv:2505.22375 https://example.com/two",
				rect: {
					origin: { x: 0, y: 20 },
					size: { width: 690, height: 10 },
				},
				font: { family: "Times-Roman", size: 10 },
			},
		]);

		expect(links.map(({ url }) => url)).toEqual([
			"https://example.com/one",
			"https://arxiv.org/abs/2505.22375",
			"https://example.com/two",
		]);
	});

	it("turns a legacy arXiv identifier into its abstract URL", () => {
		const links = detectPdfTextLinks([
			{
				content: "arXiv:hep-th/9901001",
				rect: {
					origin: { x: 10, y: 20 },
					size: { width: 100, height: 10 },
				},
				font: { family: "Times-Roman", size: 10 },
			},
		]);

		expect(links.map(({ url }) => url)).toEqual([
			"https://arxiv.org/abs/hep-th/9901001",
		]);
	});

	it("removes sentence punctuation from a plain HTTPS URL", () => {
		const links = detectPdfTextLinks([
			{
				content: "https://example.com/paper.",
				rect: {
					origin: { x: 10, y: 20 },
					size: { width: 100, height: 10 },
				},
				font: { family: "Times-Roman", size: 10 },
			},
		]);

		expect(links).toHaveLength(1);
		expect(links[0]?.url).toBe("https://example.com/paper");
	});

	it("limits the hit rectangle to the matched part of a text rectangle", () => {
		expect(
			detectPdfTextLinks([
				{
					content: "See https://example.com now",
					rect: {
						origin: { x: 0, y: 20 },
						size: { width: 270, height: 10 },
					},
					font: { family: "Times-Roman", size: 10 },
				},
			]),
		).toEqual([
			{
				url: "https://example.com",
				rect: {
					origin: { x: 40, y: 20 },
					size: { width: 190, height: 10 },
				},
			},
		]);
	});
});

describe("excludeOverlappingPdfTextLinks", () => {
	it("keeps only detected links without an intersecting native annotation", () => {
		const overlappingRect = {
			origin: { x: 10, y: 20 },
			size: { width: 100, height: 10 },
		};
		const separateRect = {
			origin: { x: 10, y: 40 },
			size: { width: 100, height: 10 },
		};

		expect(
			excludeOverlappingPdfTextLinks(
				[
					{ url: "https://example.com/annotated", rect: overlappingRect },
					{ url: "https://example.com/plain", rect: separateRect },
				],
				[{ rect: overlappingRect }],
			),
		).toEqual([{ url: "https://example.com/plain", rect: separateRect }]);
	});
});

describe("CitationLinkLayer", () => {
	it("renders a hit target for a detected text link without native annotations", () => {
		const html = renderToStaticMarkup(
			createElement(
				CitationLinkLayer as unknown as ComponentType<Record<string, unknown>>,
				{
					links: [],
					textLinks: [
						{
							url: "https://example.com",
							rect: {
								origin: { x: 10, y: 20 },
								size: { width: 100, height: 10 },
							},
						},
					],
					pageWidthPt: 200,
					pageHeightPt: 100,
					label: "PDF link",
					onActivate: () => undefined,
					onTextActivate: () => undefined,
					onHover: () => undefined,
				},
			),
		);

		expect(html).toContain('aria-label="https://example.com"');
		expect(html).toContain('title="https://example.com"');
	});
});
