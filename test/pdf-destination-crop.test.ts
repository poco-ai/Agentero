// Synthetic text only; labels and geometry exercise the crop boundaries.
import { describe, expect, it } from "vitest";
import {
	pickDestinationContinuation,
	pickDestinationRegion,
	pickDestinationRegions,
} from "@/lib/pdf/destination-crop";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

function region(
	pageIndex: number,
	kind: PdfLayoutRegion["kind"],
	bbox: PdfLayoutRegion["bbox"],
	title?: string,
	id = "r",
): PdfLayoutRegion {
	return { pageIndex, kind, bbox, score: 1, id, title };
}

function textRect(
	x: number,
	y: number,
	width: number,
	height: number,
	content: string,
) {
	return { rect: { origin: { x, y }, size: { width, height } }, content };
}

describe("pickDestinationRegion", () => {
	it.each([
		"R Core Team. 2026. Software.",
		"Beta, B., C. Gamma,",
		"Beta, B., C. Gamma, … Delta,",
	])("stops before an institutional or wrapped author list: %s", (next) => {
		const crop = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 50,
			pdfY: 700,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Alpha (2020)",
			textRects: [
				textRect(50, 100, 400, 8, "Alpha, A. 2020. Requested paper."),
				textRect(50, 111, 400, 8, next),
				textRect(68, 122, 380, 8, "R. D. (2018). Next entry title."),
				textRect(68, 133, 380, 8, "Other publisher."),
			],
		})[0];
		expect((crop.bbox.y + crop.bbox.h) * 800).toBeLessThan(111);
	});
	it("stops before an edited work whose author has a lowercase editor suffix", () => {
		const crop = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 50,
			pdfY: 700,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Alpha (2026)",
			textRects: [
				textRect(50, 100, 240, 8, "Alpha. A modern article. Library 2026."),
				textRect(60, 111, 220, 8, "https://example.org/modern."),
				textRect(50, 122, 240, 8, "Beta, ed. 1807. A separate edited work."),
				textRect(60, 133, 220, 8, "Different publisher."),
			],
		})[0];
		expect((crop.bbox.y + crop.bbox.h) * 800).toBeLessThan(122);
	});
	it.each([
		["Rowman & Littlefield."],
		["Science and Technology Press."],
		[
			"Relationships and Phylogeography of the Genus Example Liu,",
			"2000 (Orthoptera) Reveal Speciation Processes.",
			"Journal 45: 144–159.",
		],
	])("does not borrow the next year for a title or publisher continuation: %s", (...tail) => {
		const crop = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 50,
			pdfY: 700,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Alpha (2020)",
			textRects: [
				textRect(50, 100, 240, 8, "Alpha, A. 2020. Requested paper."),
				...tail.map((line, i) => textRect(50, 111 + i * 11, 240, 8, line)),
				textRect(
					50,
					116 + tail.length * 11,
					240,
					8,
					"Be ta , B ., et al. 2 021. Next paper.",
				),
			],
		})[0];
		expect((crop.bbox.y + crop.bbox.h) * 800).toBeGreaterThan(
			108 + tail.length * 11,
		);
		expect((crop.bbox.y + crop.bbox.h) * 800).toBeLessThan(
			116 + tail.length * 11,
		);
	});
	it("bounds a next-page continuation at the actual column gutter", () => {
		const source = {
			pageIndex: 2,
			pdfX: 310,
			pdfY: 70,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Alpha (2020)",
			textRects: [
				textRect(310, 730, 240, 8, "Alpha, A. 2020. Requested paper."),
				textRect(320, 741, 230, 8, "Journal and continued title"),
			],
		};
		const crop = pickDestinationRegions(source)[0];
		const continuation = pickDestinationContinuation(crop, source, {
			...source,
			pageIndex: 3,
			textRects: [
				textRect(60, 50, 220, 8, "Remaining title and publisher."),
				textRect(60, 61, 220, 8, "https://example.org/requested."),
				textRect(50, 72, 230, 8, "Beta, B. 2021. Next entry."),
				textRect(310, 50, 20, 8, "Other,"),
				textRect(335, 50, 210, 8, "C. 2022. Unrelated column."),
				textRect(320, 61, 220, 8, "Unrelated continuation."),
			],
		});
		expect(continuation).not.toBeNull();
		expect(
			((continuation?.bbox.x ?? 0) + (continuation?.bbox.w ?? 0)) * 600,
		).toBeLessThan(300);
	});
	it.each([
		false,
		true,
	])("keeps an entry's continuation across a %s page boundary", (nextPage) => {
		const source = {
			pageIndex: 2,
			pdfX: nextPage ? 310 : 50,
			pdfY: 70,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Alpha (2020)",
			textRects: [
				textRect(
					nextPage ? 310 : 50,
					730,
					230,
					8,
					"Alpha, A. 2020. Requested paper.",
				),
				textRect(
					nextPage ? 320 : 60,
					741,
					220,
					8,
					"Journal 5. https://example.org/long/",
				),
			],
		};
		const tail = [
			textRect(
				nextPage ? 60 : 320,
				61,
				210,
				8,
				"Service-in-Oriented-Systems.pdf.",
			),
			textRect(nextPage ? 50 : 310, 20, 210, 8, "JOURNAL HEADER"),
			textRect(nextPage ? 60 : 320, 50, 210, 8, "remaining-identifier/"),
			textRect(
				nextPage ? 50 : 310,
				72,
				230,
				8,
				"Beta, B. 2 021. Another paper.",
			),
			textRect(
				nextPage ? 60 : 320,
				83,
				210,
				8,
				"Different journal, pages 1–4.",
			),
		];
		if (!nextPage) source.textRects.push(...tail);
		const crop = pickDestinationRegions(source)[0];
		const target = nextPage
			? { ...source, pageIndex: 3, textRects: tail }
			: source;
		const continuation = pickDestinationContinuation(crop, source, target);
		expect(continuation).not.toBeNull();
		expect(continuation?.pageIndex).toBe(nextPage ? 3 : 2);
		expect((continuation?.bbox.y ?? 0) * 800).toBeGreaterThan(30);
		expect(
			((continuation?.bbox.y ?? 0) + (continuation?.bbox.h ?? 0)) * 800,
		).toBeLessThan(72);
		expect(
			((continuation?.bbox.y ?? 0) + (continuation?.bbox.h ?? 0)) * 800,
		).toBeGreaterThan(69);
		// A fully concluded column must not absorb the next bibliography entry.
		target.textRects = target.textRects.filter(
			(r) =>
				!r.content.startsWith("remaining") &&
				!r.content.startsWith("Service-in-"),
		);
		expect(pickDestinationContinuation(crop, source, target)).toBeNull();
	});
	it("does not classify an author-year bibliography as numbered from a page-range tail", () => {
		const crops = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 50,
			pdfY: 700,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Alpha (2020)",
			textRects: [
				textRect(50, 100, 240, 8, "Alpha, A. 2020. Requested paper."),
				textRect(50, 111, 240, 8, "Journal 1: 118–"),
				textRect(50, 122, 240, 8, "124. https://doi.org/example."),
				textRect(50, 140, 240, 8, "Beta, B. 2021. Another paper."),
				textRect(50, 151, 240, 8, "Other journal 2: 3–8."),
			],
		});
		expect(crops).toHaveLength(1);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 800).toBeGreaterThan(130);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 800).toBeLessThan(140);
	});
	it.each([
		["Alpha (2019)", "Alpha, A. 2 019. Requested paper."],
		["Alpha Jr (2019)", "Alpha, A., Jr., and B. Beta. 2019. Requested paper."],
		["ARA (2019)", "Academic Research Association. 2019. Requested report."],
		[
			"ARA (2025)",
			"ARAResearch Initiative. Report for 2026. 2025. Requested report.",
		],
		[
			"U.S. Department of Commerce (2025)",
			"U.S. Department ofCommerce. 2025. Requested report.",
		],
		[
			"Alpha, Beta, and Gamma (2019)",
			"Alpha, A. 2019. Requested chapter, edited by B. Beta and C. Gamma.",
		],
		[
			"Beta, Gamma, et al. (2019)",
			"Alpha, A., B. Beta, C. Gamma, et al. 2019. Requested paper.",
		],
		[
			"IQ-Child, Alpha et al. (2019)",
			"Alpha, A. 2019. Intelligence test (IQ-Child).",
		],
	])("resolves native-linked author variants without losing entry identity: %s", (citationText, entry) => {
		const crops = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 50,
			pdfY: 700,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText,
			textRects: [
				textRect(50, 100, 240, 8, entry),
				textRect(50, 130, 240, 8, "Other, A. 2021. Unrelated entry."),
			],
		});
		expect(crops).toHaveLength(1);
		expect(crops[0].bbox.y * 800).toBeLessThan(100);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 800).toBeLessThan(130);
	});
	it("does not count the bibliography heading as part of the first author's identity", () => {
		const crops = pickDestinationRegions({
			pageIndex: 2,
			pdfX: null,
			pdfY: 115,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Alpha (2020)",
			textRects: [
				textRect(310, 685, 80, 7, "RE FE RE N CE S"),
				textRect(310, 700, 240, 8, "Alpha, A., B. Beta, and"),
				textRect(320, 711, 220, 8, "C. Gamma. 2020. Requested paper."),
			],
		});
		expect(crops).toHaveLength(1);
		expect(crops[0].bbox.y * 800).toBeGreaterThan(692);
	});
	it("reads a flush-left wrapped bibliography heading and stops at the next reference", () => {
		const crops = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 50,
			pdfY: 700,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Alpha et al. (2019)",
			textRects: [
				textRect(50, 100, 240, 8, "Alpha, A., B. Beta, C. Gamma, and D."),
				textRect(50, 111, 240, 8, "Delta. 2019. Requested paper."),
				textRect(50, 122, 240, 8, "Journal 3: 1–8."),
				textRect(50, 140, 240, 8, "Next, A. 2021. Another reference."),
			],
		});
		expect(crops).toHaveLength(1);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 800).toBeGreaterThan(130);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 800).toBeLessThan(140);
	});
	it.each([
		"Alpha, A. 20 19. Requested paper.",
		"Alpha, A.2019. Requested paper.",
	])("normalizes year spacing in the entry heading: %s", (entry) => {
		expect(
			pickDestinationRegions({
				pageIndex: 2,
				pdfX: 50,
				pdfY: 700,
				pageWidthPt: 600,
				pageHeightPt: 800,
				citationText: "Alpha (2019)",
				textRects: [textRect(50, 100, 240, 8, entry)],
			}),
		).toHaveLength(1);
	});
	it("uses a complete native-linked author identity when the year follows the title", () => {
		const crops = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 0,
			pdfY: 690,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Research Blog (2025)",
			textRects: [
				textRect(50, 100, 240, 8, "Research Blog. The requested article (4"),
				textRect(60, 111, 220, 8, "December 2025). 2025. Available online."),
				textRect(50, 140, 240, 8, "Other, A. 2021. Different paper."),
			],
		});
		expect(crops).toHaveLength(1);
		expect(crops[0].bbox.y * 800).toBeLessThan(100);
	});
	it("uses the native anchor to distinguish same-author same-year bibliography entries", () => {
		const crops = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 0,
			pdfY: 480,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Alpha et al. (2022)",
			textRects: [
				textRect(
					310,
					200,
					240,
					8,
					"Alpha, A., B. Beta. 2022. First reference.",
				),
				textRect(320, 211, 220, 8, "First continuation."),
				textRect(
					310,
					313,
					240,
					8,
					"Alpha, A., C. Gamma. 2022. Second reference.",
				),
				textRect(320, 324, 220, 8, "Second continuation."),
			],
		});
		expect(crops).toHaveLength(1);
		expect(crops[0].bbox.y * 800).toBeGreaterThan(300);
	});
	it("follows a long author heading until its publication year", () => {
		const crops = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 50,
			pdfY: 700,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Alpha et al. (2026)",
			textRects: [
				textRect(50, 100, 240, 8, "Alpha, A., B. Beta, C. Gamma, D. Delta,"),
				...Array.from({ length: 6 }, (_, i) =>
					textRect(
						60,
						111 + i * 11,
						220,
						8,
						"E. Epsilon, F. Theta, G. Lambda,",
					),
				),
				textRect(60, 177, 220, 8, "and H. Omega. 2026. Requested paper."),
				textRect(60, 188, 220, 8, "Journal 1: 1–8."),
				textRect(50, 210, 240, 8, "Next, A. 2021. Another reference."),
			],
		});
		expect(crops).toHaveLength(1);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 800).toBeGreaterThan(196);
	});
	it.each([
		["Smything (2020)", "Smythang, A. 2020. Requested reference."],
		[
			"Alpha et al. (2024)",
			"Alpha, A., and B. Beta. 2025. Requested reference.",
		],
	])("recovers a unique minor citation inconsistency on the linked bibliography page: %s", (citationText, entry) => {
		const crops = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 0,
			pdfY: 100,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText,
			textRects: [
				textRect(50, 100, 240, 8, entry),
				textRect(60, 111, 220, 8, "Journal 3(4): 1–8."),
				textRect(50, 130, 240, 8, "Next, A. 2020. Next reference."),
			],
		});
		expect(crops).toHaveLength(1);
		expect(crops[0].bbox.y * 800).toBeLessThan(100);
	});
	it("does not choose between two similarly named or adjacent-year entries", () => {
		for (const [citationText, entries] of [
			[
				"Smything (2020)",
				["Smythang, A. 2020. First.", "Smythong, B. 2020. Second."],
			],
			["Alpha (2024)", ["Alpha, A. 2023. First.", "Alpha, A. 2025. Second."]],
		] as const) {
			expect(
				pickDestinationRegions({
					pageIndex: 2,
					pdfX: 0,
					pdfY: 100,
					pageWidthPt: 600,
					pageHeightPt: 800,
					citationText,
					textRects: entries.map((entry, i) =>
						textRect(50, 100 + i * 30, 240, 8, entry),
					),
				}),
			).toEqual([]);
		}
	});
	it.each([
		[
			"Global Weather Organization (2019)",
			"Global WeatherOrganization. 2019. Requested manual.",
		],
		[
			"Alpha and Data Lab (2024)",
			"Alpha and DataLab. 2024. Requested dataset.",
		],
		[
			"Institute in Washington, D.C. (2025)",
			"Institute in Washington, D.C. 2025. Requested report.",
		],
	])("matches institutional authors despite missing PDF word spaces: %s", (citationText, entry) => {
		const crops = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 0,
			pdfY: 750,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText,
			textRects: [
				textRect(50, 300, 240, 8, entry),
				textRect(60, 311, 220, 8, "https://example.org/report."),
				textRect(50, 330, 240, 8, "Other, A. 2020. A different entry."),
			],
		});
		expect(crops).toHaveLength(1);
		expect(crops[0].bbox.y * 800).toBeLessThan(300);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 800).toBeLessThan(330);
	});
	it("joins a justified reference heading without crossing the repeated column gutter", () => {
		const crops = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 0,
			pdfY: 100,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Alpha (2017)",
			textRects: [
				textRect(50, 100, 30, 8, "Alpha,"),
				textRect(98, 100, 8, 8, "P."),
				textRect(125, 100, 24, 8, "2017."),
				textRect(170, 100, 110, 8, "Requested title."),
				textRect(60, 111, 220, 8, "Requested continuation."),
				textRect(50, 130, 240, 8, "Next, A. 2020. Next reference."),
				textRect(310, 100, 240, 8, "Other, B. 2021. Other column."),
				textRect(320, 111, 220, 8, "Other column continuation."),
			],
		});
		expect(crops).toHaveLength(1);
		expect(crops[0].bbox.y * 800).toBeLessThan(100);
		expect((crops[0].bbox.x + crops[0].bbox.w) * 600).toBeLessThan(310);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 800).toBeLessThan(130);
	});
	it("keeps an institutional heading when the year begins the next line", () => {
		const crops = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 0,
			pdfY: 100,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "RDA Research and Data Working Group (2025)",
			textRects: [
				textRect(50, 100, 240, 8, "Previous, A. 2020. Other reference."),
				textRect(60, 111, 220, 8, "Previous continuation."),
				textRect(50, 130, 240, 8, "RDA Research and Data Working Group."),
				textRect(60, 141, 220, 8, "2025. Requested report."),
				textRect(60, 152, 220, 8, "https://example.org/requested."),
				textRect(50, 170, 240, 8, "Next, A. 2021. Next reference."),
			],
		});
		expect(crops).toHaveLength(1);
		expect(crops[0].bbox.y * 800).toBeGreaterThan(120);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 800).toBeGreaterThan(160);
	});
	it("keeps a verified institutional entry beside a staggered biography column", () => {
		const crops = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 0,
			pdfY: 100,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Global Weather Organization (2019)",
			textRects: [
				textRect(313, 219, 230, 8, "Other column biography."),
				textRect(
					45,
					221,
					240,
					8,
					"Global WeatherOrganization. 2019. Requested manual.",
				),
				textRect(55, 232, 220, 8, "Requested manual continuation."),
				textRect(314, 232, 230, 8, "More biography in the other column."),
				textRect(45, 255, 240, 8, "Next, A. 2020. Next reference."),
			],
		});
		expect(crops).toHaveLength(1);
		expect(crops[0].bbox.x * 600).toBeLessThan(45);
		expect((crops[0].bbox.x + crops[0].bbox.w) * 600).toBeLessThan(310);
	});
	it("does not snap a verified dotted institutional author to the preceding entry", () => {
		const crops = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 0,
			pdfY: 700,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Institute of Research in Washington, D.C. (2025)",
			textRects: [
				textRect(50, 300, 240, 8, "Previous, A. 2013. Other reference."),
				textRect(60, 311, 220, 8, "Other continuation."),
				textRect(
					50,
					323,
					240,
					8,
					"Institute ofResearchin Washington, D.C. 2025. Report.",
				),
				textRect(60, 334, 220, 8, "Requested continuation."),
				textRect(50, 346, 240, 8, "Next, A. 2020. Next reference."),
			],
		});
		expect(crops).toHaveLength(1);
		expect(crops[0].bbox.y * 800).toBeGreaterThan(316);
	});
	it("keeps an identity-matched long author list instead of snapping to the previous reference", () => {
		const [crop] = pickDestinationRegions({
			pageIndex: 2,
			pdfX: 0,
			pdfY: 650,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Alpha et al. (2007)",
			textRects: [
				textRect(50, 100, 230, 8, "Previous, A. 1984. Unrelated book."),
				textRect(60, 111, 210, 8, "New York: Publisher."),
				textRect(50, 124, 230, 8, "Alpha, K., D. Beta, B. Gamma, and K."),
				textRect(60, 135, 220, 8, "Delta. 2007. The requested paper."),
				textRect(60, 146, 220, 8, "Journal 1(1): 3–35."),
				textRect(50, 161, 230, 8, "Next, G., A. Writer, F. Other, and R."),
				textRect(60, 172, 220, 8, "Person. 2017. Another reference."),
			],
		});
		expect(crop.bbox.y * 800).toBeGreaterThan(118);
		expect((crop.bbox.y + crop.bbox.h) * 800).toBeLessThan(161);
	});
	it("does not guess a nearby author-year entry from a bare year and stale native coordinate", () => {
		expect(
			pickDestinationRegions({
				pageIndex: 1,
				pdfX: 50,
				pdfY: 700,
				pageWidthPt: 600,
				pageHeightPt: 800,
				citationText: "2020",
				textRects: [
					textRect(50, 100, 250, 10, "Other, A. 2021. A different paper."),
				],
			}),
		).toEqual([]);
	});
	it("keeps the matched author-year entry even without a space after its surname comma", () => {
		const [crop] = pickDestinationRegions({
			pageIndex: 3,
			pdfX: 0,
			pdfY: 700,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Alpha (2004)",
			textRects: [
				textRect(307, 667, 240, 8, "Previous, B. 2011. An unrelated book."),
				textRect(317, 678, 200, 8, "London: Publisher."),
				textRect(307, 690, 240, 8, "Alpha,J. S. 2004. Requested book."),
				textRect(317, 701, 200, 8, "New York: Publisher."),
			],
		});
		expect(crop.bbox.y * 800).toBeGreaterThan(684);
		expect((crop.bbox.y + crop.bbox.h) * 800).toBeGreaterThan(709);
	});
	it("matches a surname citation to a given-name-first bibliography entry", () => {
		const crops = pickDestinationRegions({
			pageIndex: 11,
			pdfX: 67,
			pdfY: 593,
			pageWidthPt: 595,
			pageHeightPt: 842,
			citationText: "Williams et al., 2018",
			textRects: [
				textRect(
					72,
					252,
					218,
					9,
					"Adina Williams, Nikita Nangia, and Samuel R Bow-",
				),
				textRect(
					83,
					263,
					207,
					9,
					"man. 2018. A broad-coverage challenge corpus",
				),
				textRect(
					83,
					274,
					207,
					9,
					"for sentence understanding through inference. In",
				),
				textRect(83, 285, 34, 7, "NAACL."),
				textRect(
					72,
					304,
					218,
					9,
					"Other Author, Second Writer. 2019. Another paper.",
				),
			],
		});
		expect(crops).toHaveLength(1);
		expect(crops[0].bbox.y * 842).toBeLessThanOrEqual(252);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 842).toBeGreaterThanOrEqual(
			292,
		);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 842).toBeLessThan(304);
	});
	it("keeps a first-line-indented author entry when the year starts the second line", () => {
		const crop = pickDestinationRegion({
			pageIndex: 17,
			pdfX: 50,
			pdfY: 382,
			pageWidthPt: 595,
			pageHeightPt: 842,
			textRects: [
				textRect(50, 451, 72, 7, "doi:10.1084/jem.20162152"),
				textRect(
					56,
					463,
					234,
					7,
					"Moradi-Chaleshtori, M., Shojaei, S., and Hashemi, S. M.",
				),
				textRect(
					50,
					471,
					240,
					7,
					"(2021). Transfer of miRNA in tumor-derived exosomes suppresses breast tumor cell",
				),
				textRect(
					50,
					479,
					240,
					7,
					"invasion and migration by inducing M1 polarization in macrophages.",
				),
				textRect(
					50,
					487,
					240,
					7,
					"Life Sci. 282, 119800. doi:10.1016/j.lfs.2021.119800",
				),
				textRect(
					56,
					499,
					234,
					7,
					"Mosser, D. M., and Edwards, J. P. (2008). Exploring macrophages.",
				),
				textRect(50, 507, 180, 7, "Nat. Rev. Immunol. 8, 958–969."),
			],
		});
		expect((crop.bbox.y + crop.bbox.h) * 842).toBeGreaterThanOrEqual(494);
		expect((crop.bbox.y + crop.bbox.h) * 842).toBeLessThan(499);
	});
	it("stops an author-year crop before a new entry with initials", () => {
		const crop = pickDestinationRegion({
			pageIndex: 22,
			pdfX: 48,
			pdfY: 541,
			pageWidthPt: 493,
			pageHeightPt: 700,
			textRects: [
				textRect(
					48,
					160,
					290,
					9,
					"LAMB, H. 1932 Hydrodynamics. Cambridge University Press.",
				),
				textRect(
					48,
					172,
					380,
					9,
					"LAUGA, E. & POWERS, T.R. 2009 The hydrodynamics of swimming microorganisms.",
				),
				textRect(62, 184, 200, 9, "Rep. Prog. Phys. 72 (9), 096601."),
			],
		});
		expect((crop.bbox.y + crop.bbox.h) * 700).toBeLessThan(172);
	});
	it("bounds a bibliography entry with raised numbers and no punctuation", () => {
		const crops = pickDestinationRegions({
			pageIndex: 7,
			pdfX: 315,
			pdfY: 209,
			pageWidthPt: 612,
			pageHeightPt: 810,
			entryIndex: 24,
			textRects: [
				textRect(315, 600, 7, 4, "24"),
				textRect(322, 602, 230, 7, "M. Inaba, T. Muta, and M. Kobayashi,"),
				textRect(322, 611, 230, 7, "Hydrogen-terminated diamond transistors."),
				textRect(322, 620, 170, 7, "Appl. Phys. Lett. 109, 033503 (2016)."),
				textRect(315, 635, 7, 4, "25"),
				textRect(
					322,
					637,
					230,
					7,
					"S. Sze and K. Ng, Physics of Semiconductor Devices.",
				),
			],
		});
		expect(crops[0].entryMatched).toBe(true);
		expect(crops[0].bbox.y * 810).toBeLessThanOrEqual(600);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 810).toBeGreaterThanOrEqual(
			627,
		);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 810).toBeLessThan(635);
	});
	it.each([
		{ number: 8, labelY: 121, labelHeight: 10, bodyY: 127 },
		{ number: 11, labelY: 215, labelHeight: 6, bodyY: 217 },
	])("joins a detached raised bibliography label $number to its author line", ({
		number,
		labelY,
		labelHeight,
		bodyY,
	}) => {
		const crop = pickDestinationRegion({
			pageIndex: 7,
			pdfX: 315,
			pdfY: 810 - labelY,
			pageWidthPt: 612,
			pageHeightPt: 810,
			entryIndex: number,
			textRects: [
				textRect(315, labelY, 4, labelHeight, String(number).padStart(2, "0")),
				textRect(
					319,
					bodyY,
					237,
					7,
					"N. Author, Second Author, and Third Author,",
				),
				textRect(
					319,
					bodyY + 9,
					210,
					7,
					"A complete reference title, Journal 12, 34 (2025).",
				),
				textRect(315, bodyY + 25, 5, 4, String(number + 1).padStart(2, "0")),
				textRect(
					320,
					bodyY + 27,
					230,
					7,
					"B. Author, The following reference.",
				),
			],
		});
		expect(crop.entryMatched).toBe(true);
		expect(crop.bbox.y * 810).toBeLessThanOrEqual(labelY);
		expect((crop.bbox.y + crop.bbox.h) * 810).toBeGreaterThanOrEqual(
			bodyY + 16,
		);
		expect((crop.bbox.y + crop.bbox.h) * 810).toBeLessThan(bodyY + 25);
	});
	it("recovers an author-year entry from its full linked identity when the original destination is stale", () => {
		const crops = pickDestinationRegions({
			pageIndex: 4,
			pdfX: -80,
			pdfY: -60,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "Alpha-Smith, Beta, and Gamma (2013)",
			textRects: [
				textRect(55, 80, 120, 15, "References"),
				textRect(
					55,
					620,
					480,
					10,
					"Alpha-Smith, Anne, Ben Beta, and Carol Gamma. 2013.",
				),
				textRect(67, 634, 440, 10, "The requested title. Journal 89:495–510."),
				textRect(
					55,
					660,
					480,
					10,
					"Alpha-Smith, Anne, Ben Beta, and Dan Delta. 2013.",
				),
				textRect(
					67,
					674,
					440,
					10,
					"A different paper with the same first author and year.",
				),
			],
		});
		expect(crops).toHaveLength(1);
		expect(crops[0].entryMatched).toBe(true);
		expect(crops[0].bbox.y * 800).toBeLessThanOrEqual(620);
		expect(crops[0].bbox.y * 800).toBeGreaterThan(610);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 800).toBeGreaterThanOrEqual(
			644,
		);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 800).toBeLessThan(660);
	});
	it("does not display a guessed entry when author-year text is ambiguous or absent from the target page", () => {
		for (const citationText of [
			"Alpha et al. (2020)",
			"Missing and Writer (2020)",
		]) {
			expect(
				pickDestinationRegions({
					pageIndex: 3,
					pdfX: 50,
					// Midway between the two entries: the native anchor cannot
					// disambiguate this same-author/year pair.
					pdfY: 185,
					pageWidthPt: 600,
					pageHeightPt: 800,
					citationText,
					textRects: [
						textRect(
							50,
							600,
							460,
							10,
							"Alpha, Anne and Ben Beta. 2020. First paper.",
						),
						textRect(
							50,
							630,
							460,
							10,
							"Alpha, Anne and Carol Gamma. 2020. Second paper.",
						),
					],
				}),
			).toEqual([]);
		}
	});
	it("matches a wrapped author list with diacritics and an explicit year suffix", () => {
		const crops = pickDestinationRegions({
			pageIndex: 3,
			pdfX: 0,
			pdfY: 800,
			pageWidthPt: 600,
			pageHeightPt: 800,
			citationText: "García et al. (2021b)",
			textRects: [
				textRect(
					50,
					200,
					460,
					10,
					"García, Ana, Ben Beta, and Carol Gamma. 2021a. Other work.",
				),
				textRect(50, 230, 460, 10, "García, Ana, Ben Beta, Carol Gamma, and"),
				textRect(62, 244, 460, 10, "Dan Delta. 2021b. The requested paper."),
				textRect(62, 258, 460, 10, "Journal of Examples 12:1–20."),
				textRect(50, 285, 460, 10, "Omega, Owen. 2022. Next reference."),
			],
		});
		expect(crops).toHaveLength(1);
		expect(crops[0].bbox.y * 800).toBeGreaterThan(220);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 800).toBeGreaterThanOrEqual(
			268,
		);
		expect((crops[0].bbox.y + crops[0].bbox.h) * 800).toBeLessThan(285);
	});
	it("keeps an indented author-year continuation with the entry it belongs to", () => {
		const result = pickDestinationRegion({
			pageIndex: 57,
			pdfX: 42,
			pdfY: 420,
			pageWidthPt: 612,
			pageHeightPt: 800,
			textRects: [
				textRect(42, 383, 255, 9, "Alpha, M., J. Author, and T. H."),
				textRect(52, 394, 245, 8, "Beta, M. Degen, and T. H."),
				textRect(52, 404, 170, 9, "Writer (2019), Nature 576, 411."),
				textRect(42, 414, 254, 9, "Gamma (1983), Another reference."),
				textRect(315, 383, 255, 9, "Other (2021), Neighbouring column."),
				textRect(315, 403, 255, 9, "Delta (1986), Neighbouring entry."),
			],
		});
		expect(result.bbox.y * 800).toBeLessThanOrEqual(383);
		expect((result.bbox.y + result.bbox.h) * 800).toBeGreaterThanOrEqual(413);
		expect((result.bbox.y + result.bbox.h) * 800).toBeLessThanOrEqual(414);
		expect((result.bbox.x + result.bbox.w) * 612).toBeLessThan(315);
	});
	it("recovers a unique entry in a numbered bibliography when an XYZ anchor has the wrong vertical position", () => {
		const result = pickDestinationRegion({
			pageIndex: 8,
			pdfX: 0,
			pdfY: 68,
			pageWidthPt: 600,
			pageHeightPt: 800,
			entryIndex: 4,
			textRects: [
				textRect(310, 77, 240, 9, "[4] First author. Reference."),
				textRect(323, 87, 220, 9, "Journal 2025, 11, 1234."),
				textRect(310, 97, 240, 9, "[5] Next author. Another reference."),
				textRect(55, 700, 240, 9, "[3] Bottom of the left column."),
			],
		});
		expect(result.entryMatched).toBe(true);
		expect(result.bbox.x * 600).toBeGreaterThan(300);
		expect(result.bbox.y * 800).toBeLessThanOrEqual(77);
		expect((result.bbox.y + result.bbox.h) * 800).toBeLessThan(97);
	});
	it("does not guess between repeated distant entry numbers", () => {
		const result = pickDestinationRegion({
			pageIndex: 8,
			pdfX: 0,
			pdfY: 68,
			pageWidthPt: 600,
			pageHeightPt: 800,
			entryIndex: 4,
			textRects: [
				textRect(40, 70, 220, 9, "[4] First numbered list."),
				textRect(40, 90, 220, 9, "[5] Following item."),
				textRect(315, 70, 220, 9, "[4] Second numbered list."),
				textRect(315, 90, 220, 9, "[5] Following item."),
			],
		});
		expect(result.entryMatched).toBe(false);
	});
	it("recognizes a dot-numbered label attached to the author and keeps flush-left continuations", () => {
		const result = pickDestinationRegion({
			pageIndex: 9,
			pdfX: 307,
			pdfY: 200,
			pageWidthPt: 600,
			pageHeightPt: 800,
			entryIndex: 24,
			textRects: [
				textRect(306, 555, 240, 9, "23. Previous author. Reference."),
				textRect(306, 600, 240, 9, "24.M. Author, T. Other, Reference title."),
				textRect(306, 610, 240, 9, "Journal of Devices 1"),
				textRect(306, 620, 240, 9, "(2007): 380-386, https://doi.org/"),
				textRect(306, 630, 200, 9, "10.1049/example.1234."),
				textRect(306, 650, 240, 9, "25. Next author. Another reference."),
			],
		});
		expect(result.entryMatched).toBe(true);
		expect(result.bbox.y * 800).toBeLessThanOrEqual(600);
		expect((result.bbox.y + result.bbox.h) * 800).toBeGreaterThanOrEqual(639);
		expect((result.bbox.y + result.bbox.h) * 800).toBeLessThan(650);
	});
	it("finds parenthesized bibliography labels without cutting at a crystal plane in the entry", () => {
		const result = pickDestinationRegion({
			pageIndex: 6,
			pdfX: 0,
			pdfY: 36,
			pageWidthPt: 600,
			pageHeightPt: 800,
			entryIndex: 3,
			pageOnly: true,
			textRects: [
				textRect(40, 350, 220, 9, "(3) Author. Research on crystals."),
				textRect(52, 362, 205, 9, "(0001) N-polar material. Journal 29."),
				textRect(40, 380, 220, 9, "(4) Next author. Another paper."),
			],
		});
		expect(result.entryMatched).toBe(true);
		expect(result.bbox.y * 800).toBeLessThanOrEqual(350);
		expect((result.bbox.y + result.bbox.h) * 800).toBeGreaterThan(371);
		expect((result.bbox.y + result.bbox.h) * 800).toBeLessThan(380);
	});
	it("finds one numbered entry even when a FitR link points to the page top", () => {
		const result = pickDestinationRegion({
			pageIndex: 6,
			pdfX: 0,
			pdfY: 800,
			pageWidthPt: 600,
			pageHeightPt: 800,
			entryIndex: 1,
			pageOnly: true,
			textRects: [
				textRect(40, 190, 220, 9, "[1] First reference."),
				textRect(52, 202, 205, 9, "First entry continuation."),
				textRect(40, 216, 220, 9, "[2] Second reference."),
				textRect(315, 55, 220, 9, "[9] Right-column reference."),
			],
		});
		expect(result.entryMatched).toBe(true);
		expect(result.bbox.y * 800).toBeLessThanOrEqual(190);
		expect((result.bbox.y + result.bbox.h) * 800).toBeLessThan(216);
		expect((result.bbox.x + result.bbox.w) * 600).toBeLessThan(315);
	});
	it("keeps a range in numeric order across bibliography columns without unrelated entries", () => {
		const crops = pickDestinationRegions({
			pageIndex: 6,
			pdfX: 0,
			pdfY: 800,
			pageWidthPt: 600,
			pageHeightPt: 800,
			entryIndex: 8,
			endEntryIndex: 11,
			pageOnly: true,
			textRects: [
				textRect(40, 390, 220, 9, "[7] Not requested."),
				textRect(40, 415, 220, 9, "[8] End of left column."),
				textRect(315, 55, 220, 9, "[9] Top of right column."),
				textRect(315, 80, 220, 9, "[10] Next reference."),
				textRect(315, 105, 220, 9, "[11] Last requested."),
				textRect(315, 130, 220, 9, "[12] Not requested."),
			],
		});
		expect(crops).toHaveLength(4);
		expect(crops.every((c) => c.entryMatched)).toBe(true);
		expect(crops.map((c) => Math.round(c.bbox.y * 800))).toEqual([
			410, 50, 75, 100,
		]);
		expect((crops[0].bbox.x + crops[0].bbox.w) * 600).toBeLessThan(315);
		expect((crops[3].bbox.y + crops[3].bbox.h) * 800).toBeLessThan(130);
	});
	it("keeps the full range when an XYZ destination points at its last entry", () => {
		const crops = pickDestinationRegions({
			pageIndex: 6,
			pdfX: 40,
			pdfY: 800 - 330,
			pageWidthPt: 600,
			pageHeightPt: 800,
			entryIndex: 8,
			endEntryIndex: 12,
			textRects: Array.from({ length: 6 }, (_, index) =>
				textRect(
					40,
					70 + index * 65,
					220,
					9,
					`[${8 + index}] Reference entry.`,
				),
			),
		});
		expect(crops).toHaveLength(5);
		expect(crops.map((crop) => Math.round(crop.bbox.y * 800))).toEqual([
			65, 130, 195, 260, 325,
		]);
	});
	it("stops a glyph-based 11-13 preview before entry 14", () => {
		const textRects = Array.from({ length: 7 }, (_, index) => {
			const value = `${11 + index}. Author (2025) Reference entry.`;
			return [...value].map((content, charIndex) =>
				textRect(50 + charIndex * 5, 100 + index * 20, 5, 9, content),
			);
		}).flat();
		const result = pickDestinationRegion({
			pageIndex: 19,
			pdfX: 50,
			pdfY: 700,
			pageWidthPt: 600,
			pageHeightPt: 800,
			textRects,
			entryIndex: 11,
			endEntryIndex: 13,
		});
		expect(result.entryMatched).toBe(true);
		expect(result.bbox.y * 800).toBeLessThanOrEqual(100);
		expect((result.bbox.y + result.bbox.h) * 800).toBeGreaterThanOrEqual(149);
		expect((result.bbox.y + result.bbox.h) * 800).toBeLessThan(160);
	});
	it.each([
		19,
		null,
	])("finds a reference whose label is right of the destination margin (entryIndex=%s)", (entryIndex) => {
		const result = pickDestinationRegion({
			pageIndex: 31,
			pdfX: 45.828,
			pdfY: 720 - 590.689,
			pageWidthPt: 486,
			pageHeightPt: 720,
			entryIndex,
			textRects: [
				textRect(45, 58, 395, 8, "Sample continuation."),
				textRect(53, 593, 12, 8, "[19] "),
				textRect(70, 593, 81, 8, "Sample continuation."),
				textRect(153, 593, 189, 8, "Sample continuation."),
				textRect(344, 593, 29, 8, "Sample continuation."),
				textRect(53, 603, 12, 8, "[20] "),
				textRect(70, 603, 292, 8, "Sample continuation."),
			],
		});
		expect(result.entryMatched).toBe(entryIndex != null);
		expect(result.bbox.y * 720).toBeLessThanOrEqual(593);
		expect((result.bbox.y + result.bbox.h) * 720).toBeLessThan(603);
		expect((result.bbox.x + result.bbox.w) * 486).toBeGreaterThanOrEqual(373);
	});

	it("includes a spaced URL and its small punctuation without joining the other column", () => {
		const result = pickDestinationRegion({
			pageIndex: 10,
			pdfX: 311.978,
			pdfY: 713.362,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects: [
				textRect(54, 81, 246, 8, "[1] Sample reference."),
				textRect(313, 81, 12, 7, "[18] "),
				textRect(331, 81, 70, 8, "Sample continuation."),
				textRect(411, 81, 43, 8, "https://example.org/sample"),
				textRect(455, 85, 1, 1, "."),
				textRect(456, 81, 107, 8, "Sample continuation."),
				textRect(330, 89, 25, 8, "Sample continuation."),
				textRect(356, 94, 1, 1, "."),
				textRect(313, 99, 12, 7, "[19] "),
				textRect(331, 99, 226, 8, "Sample continuation."),
			],
		});
		expect(result.bbox.x * 612).toBeGreaterThanOrEqual(307);
		expect((result.bbox.x + result.bbox.w) * 612).toBeGreaterThanOrEqual(563);
		expect((result.bbox.y + result.bbox.h) * 792).toBeGreaterThanOrEqual(97);
		expect((result.bbox.y + result.bbox.h) * 792).toBeLessThan(99);
	});

	it("does not treat repeated detached URLs on entry rows as a neighbouring column", () => {
		const result = pickDestinationRegion({
			pageIndex: 10,
			pdfX: 50,
			pdfY: 720,
			pageWidthPt: 612,
			pageHeightPt: 792,
			entryIndex: 1,
			textRects: [
				textRect(50, 72, 70, 9, "[1] Sample reference."),
				textRect(200, 72, 200, 9, "https://example.org/sample"),
				textRect(50, 100, 70, 9, "[2] Sample reference."),
				textRect(200, 100, 200, 9, "https://example.org/sample"),
			],
		});
		expect((result.bbox.x + result.bbox.w) * 612).toBeGreaterThanOrEqual(400);
		expect((result.bbox.y + result.bbox.h) * 792).toBeLessThan(100);
	});

	it("finds the start of a range when fewer digits indent its marker beyond the anchor", () => {
		const result = pickDestinationRegion({
			pageIndex: 14,
			pdfX: 317.88,
			pdfY: 281.876,
			pageWidthPt: 612,
			pageHeightPt: 792,
			entryIndex: 8,
			endEntryIndex: 12,
			textRects: [
				textRect(324, 283, 236, 9, "[8] Sample reference."),
				textRect(324, 306, 236, 9, "[9] Sample reference."),
				textRect(319, 329, 241, 9, "[10] Sample reference."),
				textRect(319, 352, 241, 9, "[11] Sample reference."),
				textRect(319, 375, 241, 9, "[12] Sample reference."),
				textRect(319, 398, 241, 9, "[13] Sample reference."),
			],
		});
		expect(result.entryMatched).toBe(true);
		expect(result.bbox.y * 792).toBeLessThanOrEqual(283);
		expect((result.bbox.y + result.bbox.h) * 792).toBeGreaterThanOrEqual(384);
		expect((result.bbox.y + result.bbox.h) * 792).toBeLessThan(398);
	});

	it("keeps a left reference separate from right prose beneath a full-width page header", () => {
		const result = pickDestinationRegion({
			pageIndex: 14,
			pdfX: 53.798,
			pdfY: 792 - 165.38,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects: [
				textRect(54, 62, 504, 7, "Sample continuation."),
				textRect(55, 168, 10, 7, "[50] "),
				textRect(69, 168, 226, 7, "Sample continuation."),
				textRect(69, 176, 225, 7, "Sample continuation."),
				textRect(69, 184, 226, 7, "Sample continuation."),
				textRect(70, 192, 33, 7, "Sample continuation."),
				textRect(102, 192, 193, 7, "Sample continuation."),
				textRect(55, 200, 10, 7, "[51] "),
				textRect(69, 200, 226, 7, "Sample continuation."),
				textRect(318, 170, 240, 9, "Sample continuation."),
				textRect(318, 181, 172, 9, "Sample continuation."),
			],
		});
		expect((result.bbox.x + result.bbox.w) * 612).toBeLessThan(318);
		expect((result.bbox.y + result.bbox.h) * 792).toBeGreaterThan(198.99);
		expect((result.bbox.y + result.bbox.h) * 792).toBeLessThan(200);
	});

	it("keeps sparse appendix headings in the neighbouring column out of the reference", () => {
		const result = pickDestinationRegion({
			pageIndex: 18,
			pdfX: 54,
			pdfY: 343.207,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects: [
				textRect(55, 457, 15, 9, "[56] "),
				textRect(76, 457, 219, 9, "Sample continuation."),
				textRect(75, 469, 220, 9, "Sample continuation."),
				textRect(76, 481, 219, 9, "Sample continuation."),
				textRect(76, 493, 220, 9, "Sample continuation."),
				textRect(76, 505, 68, 9, "Sample continuation."),
				textRect(55, 526, 15, 9, "[57] "),
				textRect(76, 526, 220, 9, "Sample continuation."),
				textRect(318, 463, 59, 11, "Appendices"),
				textRect(318, 503, 203, 11, "Sample continuation."),
			],
		});
		expect((result.bbox.x + result.bbox.w) * 612).toBeLessThan(318);
		expect((result.bbox.y + result.bbox.h) * 792).toBeGreaterThanOrEqual(514);
		expect((result.bbox.y + result.bbox.h) * 792).toBeLessThan(526);
	});

	it("ignores a vertical watermark overlapping several reference rows", () => {
		const result = pickDestinationRegion({
			pageIndex: 4,
			pdfX: 53.945,
			pdfY: 326.614,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects: [
				textRect(5, 302, 19, 188, "Sample continuation."),
				textRect(49, 425, 251, 8, "Sample continuation."),
				textRect(55, 471, 10, 9, "[9] "),
				textRect(71, 471, 229, 9, "Sample continuation."),
				textRect(71, 482, 230, 9, "Sample continuation."),
				textRect(71, 494, 229, 9, "Sample continuation."),
				textRect(71, 506, 134, 10, "Sample continuation."),
				textRect(50, 518, 15, 9, "[10] "),
				textRect(71, 518, 229, 9, "Sample continuation."),
			],
		});
		expect(result.bbox.x * 612).toBeGreaterThanOrEqual(44);
		expect(result.bbox.y * 792).toBeGreaterThan(460);
		expect(result.bbox.y * 792).toBeLessThanOrEqual(471);
		expect((result.bbox.y + result.bbox.h) * 792).toBeGreaterThanOrEqual(516);
		expect((result.bbox.y + result.bbox.h) * 792).toBeLessThan(518);
	});

	it("isolates single reference entry from [N] marker until the next marker [N+1]", () => {
		const textRects = [
			textRect(50, 72, 240, 9, "[1] Sample reference."),
			textRect(65, 82, 220, 9, "Sample continuation."),
			textRect(65, 92, 40, 9, "2025."),

			textRect(50, 104, 240, 9, "[2] Sample reference."),
		];

		const result = pickDestinationRegion({
			pageIndex: 11,
			pdfX: 50,
			pdfY: 722,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
		});

		expect(result.pageIndex).toBe(11);

		expect(result.bbox.y).toBeLessThanOrEqual(72 / 792);

		const bottomPt = (result.bbox.y + result.bbox.h) * 792;
		expect(bottomPt).toBeLessThan(104);
	});

	it("clamps full-width layout regions to a single column when the document is two-column", () => {
		const regions = [
			region(8, "text", { x: 0.52, y: 0.1, w: 0.42, h: 0.4 }),

			region(8, "text", { x: 0.05, y: 0.1, w: 0.88, h: 0.8 }),
		];

		const result = pickDestinationRegion({
			pageIndex: 8,
			pdfX: 45,
			pdfY: 554.4,
			pageWidthPt: 612,
			pageHeightPt: 792,
			regions,
		});

		expect(result.bbox.w).toBeLessThanOrEqual(0.46);
		expect(result.bbox.x + result.bbox.w).toBeLessThanOrEqual(0.5);
	});

	it("aligns to layout text regions when textRects are absent", () => {
		const regions = [
			region(
				8,
				"text",
				{ x: 0.06, y: 0.1, w: 0.42, h: 0.8 },
				undefined,
				"col-1",
			),
			region(
				8,
				"text",
				{ x: 0.52, y: 0.1, w: 0.42, h: 0.8 },
				undefined,
				"col-2",
			),
		];

		const result = pickDestinationRegion({
			pageIndex: 8,
			pdfX: 324,
			pdfY: 554.4,
			pageWidthPt: 612,
			pageHeightPt: 792,
			regions,
		});
		expect(result.pageIndex).toBe(8);
		expect(result.bbox.x).toBe(0.52);
		expect(result.bbox.w).toBe(0.42);
		expect(result.bbox.y).toBeCloseTo(0.3 - 0.015, 2);
	});

	it("uses column geometry heuristic when regions and textRects are absent", () => {
		const left = pickDestinationRegion({
			pageIndex: 5,
			pdfX: 40,
			pdfY: 400,
			pageWidthPt: 612,
			pageHeightPt: 792,
		});
		expect(left.pageIndex).toBe(5);
		expect(left.bbox.x).toBeLessThan(0.4);
		expect(left.bbox.w).toBeLessThanOrEqual(0.46);

		const right = pickDestinationRegion({
			pageIndex: 5,
			pdfX: 320,
			pdfY: 400,
			pageWidthPt: 612,
			pageHeightPt: 792,
		});
		expect(right.pageIndex).toBe(5);
		expect(right.bbox.x).toBeGreaterThanOrEqual(0.48);
		expect(right.bbox.x + right.bbox.w).toBeLessThanOrEqual(0.98);
	});

	it("does not hijack distant entryIndex when far from destination anchor", () => {
		const textRects = [
			textRect(50, 72, 240, 9, "[4] Sample reference."),

			textRect(50, 400, 240, 9, "[18] Sample reference."),
		];

		const result = pickDestinationRegion({
			pageIndex: 11,
			pdfX: 50,
			pdfY: 792 - 400,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
			entryIndex: 4,
		});

		expect(result.bbox.y * 792).toBeGreaterThanOrEqual(390);
	});
	it("reports entryMatched only when the [N] / N. line is found", () => {
		const textRects = [
			textRect(50, 72, 240, 9, "[7] Sample reference."),
			textRect(50, 84, 240, 9, "8.  Sample reference."),
		];
		const base = {
			pageIndex: 3,
			pdfX: 50,
			pdfY: 792 - 72,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
		};
		expect(pickDestinationRegion({ ...base, entryIndex: 7 }).entryMatched).toBe(
			true,
		);
		expect(pickDestinationRegion({ ...base, entryIndex: 8 }).entryMatched).toBe(
			true,
		);

		expect(pickDestinationRegion({ ...base, entryIndex: 2 }).entryMatched).toBe(
			false,
		);
		expect(pickDestinationRegion(base).entryMatched).toBe(false);

		expect(
			pickDestinationRegion({ ...base, textRects: undefined, entryIndex: 7 })
				.entryMatched,
		).toBe(false);
	});

	it("crops a short single-line entry to its text width near the right page edge", () => {
		const textRects = [textRect(560, 300, 30, 9, "[3] Sample reference.")];
		const result = pickDestinationRegion({
			pageIndex: 0,
			pdfX: 560,
			pdfY: 792 - 300,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
			entryIndex: 3,
		});
		expect(result.bbox.w * 612).toBeCloseTo(42);
		expect(result.bbox.x * 612).toBeCloseTo(554);
		expect(result.bbox.x + result.bbox.w).toBeLessThanOrEqual(0.98 + 1e-9);
	});

	it("uses actual line bounds when the gutter is not at the page centre", () => {
		const textRects = [
			textRect(50, 72, 30, 9, "[1] Sample reference."),
			textRect(370, 72, 190, 9, "[10] Sample reference."),
			textRect(50, 84, 280, 9, "[2] Sample reference."),
			textRect(65, 96, 265, 9, "Sample continuation."),
			textRect(370, 84, 190, 9, "[11] Sample reference."),
			textRect(50, 108, 280, 9, "[3] Sample reference."),
		];
		const base = {
			pageIndex: 0,
			pdfX: 50,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
		};
		const short = pickDestinationRegion({
			...base,
			pdfY: 792 - 72,
			entryIndex: 1,
		});
		expect(short.bbox.w * 612).toBeCloseTo(42);
		const wrapped = pickDestinationRegion({
			...base,
			pdfY: 792 - 84,
			entryIndex: 2,
		});
		const right = (wrapped.bbox.x + wrapped.bbox.w) * 612;
		expect(right).toBeCloseTo(336);
		expect((wrapped.bbox.y + wrapped.bbox.h) * 792).toBeGreaterThanOrEqual(105);
		expect((wrapped.bbox.y + wrapped.bbox.h) * 792).toBeLessThan(108);
	});

	it("does not read a labelled entry's continuation line as an author-year start", () => {
		const textRects = [
			textRect(330, 382, 172, 8, "Sample continuation."),
			textRect(317, 391, 246, 8, "[5] Sample reference."),
			textRect(330, 400, 234, 8, "Sample continuation."),
			textRect(330, 409, 95, 8, "Writer, 2025. Sample details."),
			textRect(317, 418, 246, 8, "[6] Sample reference."),
			textRect(330, 427, 116, 8, "Sample continuation."),
			textRect(317, 436, 246, 8, "[7] Sample reference."),
			textRect(330, 445, 231, 8, "Sample continuation."),

			textRect(59, 404, 241, 8, "Sample continuation."),
			textRect(49, 413, 251, 8, "Sample continuation."),
		];
		const base = {
			pageIndex: 10,
			pdfX: 312,
			pdfY: 381,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
		};

		for (const entryIndex of [null, 6]) {
			const result = pickDestinationRegion({ ...base, entryIndex });
			expect(result.bbox.y * 792).toBeGreaterThan(409);
			expect(result.bbox.y * 792).toBeLessThanOrEqual(418);
			expect((result.bbox.y + result.bbox.h) * 792).toBeLessThan(436);
		}
	});

	it('does not take IEEE\'s "[Online]. Available:" line for an entry start', () => {
		const textRects = [
			textRect(317, 481, 246, 8, "[9] Sample reference."),
			textRect(
				331,
				490,
				232,
				8,
				"[Online]. Available: https://example.org/sample",
			),
			textRect(330, 499, 36, 8, "Sample continuation."),
			textRect(313, 508, 250, 8, "[10] Sample reference."),
			textRect(330, 517, 233, 8, "Sample continuation."),
			textRect(330, 526, 120, 8, "Writer, 2025. Sample details."),
			textRect(313, 535, 250, 8, "[11] Sample reference."),
			textRect(
				331,
				544,
				200,
				8,
				"[Online]. Available: https://example.org/sample",
			),
			textRect(49, 500, 251, 8, "Sample continuation."),
			textRect(49, 509, 251, 8, "Sample continuation."),
		];
		const base = {
			pdfX: 312,
			pageWidthPt: 612,
			pageHeightPt: 792,
			pageIndex: 10,
			textRects,
		};

		const ten = pickDestinationRegion({ ...base, pdfY: 792 - 499 });
		expect(ten.bbox.y * 792).toBeGreaterThan(499);
		expect(ten.bbox.y * 792).toBeLessThanOrEqual(508);
		expect((ten.bbox.y + ten.bbox.h) * 792).toBeLessThan(535);

		const eleven = pickDestinationRegion({ ...base, pdfY: 792 - 534 });
		expect((eleven.bbox.y + eleven.bbox.h) * 792).toBeGreaterThan(550);
	});

	it("keeps a full-width bibliography below equations and isolated right-side fragments", () => {
		const textRects = [
			textRect(167, 97, 392, 10, "Sample continuation."),
			textRect(188, 271, 373, 10, "Sample continuation."),
			textRect(166, 296, 393, 10, "Sample continuation."),
			textRect(299, 148, 71, 10, "Sample continuation."),
			textRect(434, 322, 4, 10, "Sample continuation."),
			textRect(540, 539, 19, 10, "Sample continuation."),
			textRect(36, 666, 50, 10, "References"),
			textRect(36, 681, 6, 10, "1. "),
			textRect(57, 681, 444, 10, "Sample continuation."),
			textRect(36, 693, 6, 10, "2. "),
			textRect(57, 693, 417, 10, "Sample continuation."),
			textRect(36, 704, 6, 10, "3. "),
			textRect(57, 704, 502, 10, "Sample continuation."),
		];
		const result = pickDestinationRegion({
			pageIndex: 27,
			pdfX: 35.716,
			pdfY: 165.009,
			pageWidthPt: 595.276,
			pageHeightPt: 841.89,
			textRects,
			entryIndex: 1,
		});
		expect(result.entryMatched).toBe(true);
		const right = (result.bbox.x + result.bbox.w) * 595.276;
		expect(right).toBeGreaterThanOrEqual(501);
		expect(right).toBeLessThanOrEqual(507);
		expect(result.bbox.y * 841.89).toBeLessThanOrEqual(681);
		expect((result.bbox.y + result.bbox.h) * 841.89).toBeLessThan(693);
	});

	it("crops full citation range from [8] through [12] even when destination anchor is at reference [12]", () => {
		const textRects = [
			textRect(50, 72, 240, 9, "[8] Sample reference."),
			textRect(65, 82, 220, 9, "Sample continuation."),
			textRect(50, 96, 240, 9, "[9] Sample reference."),
			textRect(50, 110, 240, 9, "[10] Sample reference."),
			textRect(50, 124, 240, 9, "[11] Sample reference."),
			textRect(50, 138, 240, 9, "[12] Sample reference."),
			textRect(65, 148, 220, 9, "Sample continuation."),
			textRect(50, 162, 240, 9, "[13] Sample reference."),
		];

		const result = pickDestinationRegion({
			pageIndex: 14,
			pdfX: 50,
			pdfY: 792 - 138,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
			entryIndex: 8,
			endEntryIndex: 12,
		});

		expect(result.bbox.y * 792).toBeLessThanOrEqual(72);

		const bottomPt = (result.bbox.y + result.bbox.h) * 792;
		expect(bottomPt).toBeGreaterThan(148);

		expect(bottomPt).toBeLessThan(162);
	});

	it("crops all entries on landing page belonging to range when start entry is on previous page (e.g. range [1-10] landing on [10] with [9] and [10] present)", () => {
		const textRects = [
			textRect(50, 70, 240, 9, "[9] Sample reference."),
			textRect(65, 82, 220, 9, "Sample continuation."),

			textRect(50, 96, 240, 9, "[10] Sample reference."),
			textRect(65, 108, 220, 9, "Sample continuation."),

			textRect(50, 122, 240, 9, "[11] Sample reference."),
		];

		const result = pickDestinationRegion({
			pageIndex: 14,
			pdfX: 50,
			pdfY: 792 - 96,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
			entryIndex: 1,
			endEntryIndex: 10,
		});

		expect(result.bbox.y * 792).toBeLessThanOrEqual(70);

		const bottomPt = (result.bbox.y + result.bbox.h) * 792;
		expect(bottomPt).toBeGreaterThan(108);

		expect(bottomPt).toBeLessThan(122);
	});

	it("stops before next entry for dot-numbered reference entries split into number and dot runs", () => {
		const textRects = [
			textRect(313, 95, 7, 6, "12"),
			textRect(322, 95, 5, 6, "."),
			textRect(330, 95, 230, 9, "Sample continuation."),
			textRect(330, 106, 230, 9, "Sample continuation."),

			textRect(313, 127, 7, 6, "13"),
			textRect(322, 127, 5, 6, "."),
			textRect(330, 127, 230, 9, "Sample continuation."),
			textRect(330, 138, 230, 9, "Sample continuation."),

			textRect(313, 148, 7, 6, "14"),
			textRect(322, 148, 5, 6, "."),
			textRect(330, 148, 230, 9, "Sample continuation."),
		];

		const result = pickDestinationRegion({
			pageIndex: 11,
			pdfX: 330,
			pdfY: 802 - 127,
			pageWidthPt: 612,
			pageHeightPt: 802,
			textRects,
			entryIndex: 11,
			endEntryIndex: 13,
		});

		const topPt = result.bbox.y * 802;
		const bottomPt = (result.bbox.y + result.bbox.h) * 802;

		expect(topPt).toBeLessThanOrEqual(95);

		expect(bottomPt).toBeGreaterThan(138);

		expect(bottomPt).toBeLessThan(148);
	});

	it("crops in-range entries even when destination anchor is at top of column above the entries", () => {
		const textRects = [
			textRect(50, 95, 200, 9, "[12] Sample reference."),
			textRect(66, 106, 184, 9, "Sample continuation."),

			textRect(50, 127, 200, 9, "[13] Sample reference."),

			textRect(50, 148, 200, 9, "[14] Sample reference."),
		];

		const result = pickDestinationRegion({
			pageIndex: 11,
			pdfX: 50,
			pdfY: 802 - 30,
			pageWidthPt: 612,
			pageHeightPt: 802,
			textRects,
			entryIndex: 11,
			endEntryIndex: 13,
		});

		const topPt = result.bbox.y * 802;
		const bottomPt = (result.bbox.y + result.bbox.h) * 802;
		expect(topPt).toBeLessThanOrEqual(95);
		expect(bottomPt).toBeGreaterThan(127);
		expect(bottomPt).toBeLessThan(148);
	});

	it("stops the last entry at the appendix heading after it", () => {
		const textRects = [
			textRect(70, 320, 33, 7, "Sample continuation."),
			textRect(102, 321, 69, 6, "Sample continuation."),
			textRect(55, 328, 10, 7, "[56] "),
			textRect(69, 328, 225, 7, "Sample continuation."),
			textRect(69, 336, 225, 7, "Sample continuation."),
			textRect(69, 344, 98, 7, "Sample continuation."),
			textRect(169, 344, 126, 7, "Sample continuation."),
			textRect(70, 352, 33, 7, "Sample continuation."),
			textRect(102, 352, 193, 7, "Sample continuation."),
			textRect(54, 373, 113, 11, "Sample continuation."),
			textRect(54, 389, 116, 8, "Sample continuation."),
			textRect(64, 405, 25, 6, "Proof. "),
			textRect(93, 404, 175, 9, "Sample continuation."),
		];
		const result = pickDestinationRegion({
			pageIndex: 14,
			pdfX: 54,
			pdfY: 792 - 324.8,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
		});
		const bottom = (result.bbox.y + result.bbox.h) * 792;
		expect(result.bbox.y * 792).toBeLessThanOrEqual(328);
		expect(bottom).toBeGreaterThanOrEqual(359);
		expect(bottom).toBeLessThan(373);
	});

	it("stops at a centred heading a line-height gap below the entry", () => {
		const textRects = [
			textRect(312, 148, 14, 9, "[63] "),
			textRect(334, 148, 230, 9, "Sample continuation."),
			textRect(334, 160, 60, 7, "Sample continuation."),
			textRect(396, 160, 166, 9, "Sample continuation."),
			textRect(334, 172, 20, 7, "2025."),
			textRect(408, 192, 22, 7, "Sample continuation."),
			textRect(431, 194, 34, 6, "Sample continuation."),
			textRect(322, 207, 248, 9, "Sample continuation."),
			textRect(312, 219, 258, 9, "https://example.org/sample"),
		];
		const result = pickDestinationRegion({
			pageIndex: 15,
			pdfX: 312,
			pdfY: 792 - 148,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
		});
		const bottom = (result.bbox.y + result.bbox.h) * 792;
		expect(bottom).toBeGreaterThanOrEqual(179);
		expect(bottom).toBeLessThan(192);
	});

	it("keeps left-column text that overhangs the gutter out of the right column", () => {
		const left = [298, 306, 314, 322, 330, 338, 346].map((y) =>
			textRect(54, y, 246, 7, "Sample continuation."),
		);
		const textRects = [
			...left,
			textRect(300, 344, 2, 6, ","),
			textRect(320, 322, 12, 7, "[33] "),
			textRect(340, 322, 231, 7, "Sample continuation."),
			textRect(340, 330, 231, 7, "Sample continuation."),
			textRect(341, 340, 95, 7, "Sample continuation."),
			textRect(436, 340, 22, 7, ", 2025."),
			textRect(320, 351, 12, 7, "[34] "),
			textRect(340, 351, 231, 7, "Sample continuation."),
		];
		const result = pickDestinationRegion({
			pageIndex: 14,
			pdfX: 320,
			pdfY: 792 - 320,
			pageWidthPt: 612,
			pageHeightPt: 792,
			textRects,
		});
		const bottom = (result.bbox.y + result.bbox.h) * 792;
		expect(result.bbox.x * 612).toBeGreaterThanOrEqual(306);
		expect(bottom).toBeGreaterThanOrEqual(347);
		expect(bottom).toBeLessThan(351);
	});
});
