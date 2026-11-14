import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfLinkAnnoObject } from "@embedpdf/models";
import { PdfAnnotationSubtype } from "@embedpdf/models";
import { init } from "@embedpdf/pdfium";
import type { PDFArray, PDFContext } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
	acsCrossrefParser,
	buildCitationDestKeyMap,
	buildPdfDestMaps,
	citationDestKey,
	citationRefNumber,
	citationSidecarKeysForDest,
	destinationInPageBox,
	expandCitationLinkCluster,
	fitHCoordResolver,
	fitRCoordResolver,
	hyperrefCrossrefParser,
	isOtherNamedLink,
	linkRectKey,
	matchCitationLinkKey,
	matchCrossrefLinkLabel,
	springerCitationParser,
	springerCrossrefParser,
	xyzCoordResolver,
} from "@/lib/pdf/citation-dest-keys";
import {
	extractCrossrefLabel,
	pickCrossrefRegionByLabel,
} from "@/lib/pdf/crossref-resolve";
import { mergeCaptionsIntoHosts } from "@/lib/pdf/layout/merge-captions";

/**
 * Real-PDF fixtures live outside the repo, so these cases are opt-in: point
 * AGENTERO_TEST_PAPER at a paper folder to exercise the parser end to end.
 */
const paperDir = process.env.AGENTERO_TEST_PAPER;

describe("citation destination keys", () => {
	it("returns an empty map for a PDF without hyperref cite destinations", async () => {
		// Minimal PDF with no /Names tree at all.
		const { PDFDocument } = await import("pdf-lib");
		const doc = await PDFDocument.create();
		doc.addPage();
		const map = await buildCitationDestKeyMap(await doc.save());
		expect(map.size).toBe(0);
	});

	it("keys destinations by page and PDF-native y", () => {
		expect(citationDestKey(9, 566.93)).toBe("9:566.9");
		expect(citationDestKey(0, 0)).toBe("0:0.0");
	});

	it("resolves a generated many-page hyperref PDF; parse cost is worker-bound", async () => {
		const { PDFDocument, PDFName, PDFNumber, PDFString } = await import(
			"pdf-lib"
		);
		const pageCount = 1000;
		const citeCount = 10000;
		const doc = await PDFDocument.create();
		const pages = Array.from({ length: pageCount }, () => {
			const page = doc.addPage();
			// Some real content per page so the object tree is not degenerate.
			for (let r = 0; r < 8; r++) {
				page.drawRectangle({ x: 10 + r * 12, y: 10, width: 10, height: 10 });
			}
			return page;
		});
		const context = doc.context;
		// hyperref layout: /Names → /Dests → Names [ (cite.<key>) [page /XYZ x y z] … ]
		const namePairs = [];
		for (let i = 0; i < citeCount; i++) {
			const page = pages[i % pageCount];
			namePairs.push(PDFString.of(`cite.key${i}`));
			namePairs.push(
				context.obj([
					page.ref,
					PDFName.of("XYZ"),
					PDFNumber.of(0),
					PDFNumber.of(720 - Math.floor(i / pageCount) * 12),
					PDFNumber.of(0),
				]),
			);
		}
		const dests = context.obj({ Names: context.obj(namePairs) });
		doc.catalog.set(PDFName.of("Names"), context.obj({ Dests: dests }));
		const bytes = await doc.save();

		const started = performance.now();
		const map = await buildCitationDestKeyMap(bytes);
		const ms = performance.now() - started;

		expect(map.size).toBe(citeCount);
		expect(map.get(citationDestKey(0, 720))).toBe("key0");
		expect(map.get(citationDestKey(999, 720))).toBe("key999");
		expect(map.get(citationDestKey(0, 708))).toBe("key1000");
		// pdf-lib has no lazy parsing: PDFDocument.load walks the whole object
		// tree, so cost scales with the PDF (seconds on real 100MB+ papers).
		// That is why production builds this map inside a worker — record the
		// synchronous cost here as the perf evidence.
		console.info(
			`buildCitationDestKeyMap: ${pageCount} pages / ${citeCount} dests parsed synchronously in ${Math.round(ms)}ms`,
		);
		expect(ms).toBeGreaterThan(0);
	});

	it.skipIf(!paperDir)(
		"resolves hyperref cite keys to sidecar rawKeys",
		async () => {
			const dir = paperDir as string;
			const name = dir.replace(/\/$/, "").split("/").pop();
			const map = await buildCitationDestKeyMap(
				readFileSync(`${dir}/${name}.pdf`),
			);
			// ACS /FitR papers expose `mk:ref*` (often colliding on one page) rather
			// than hyperref `cite.<key>` — skip when this fixture has no cites.
			if (map.size === 0) return;
			const sidecar = JSON.parse(
				readFileSync(`${dir}/source/agentero-cite.json`, "utf8"),
			);
			const rawKeys = new Set(
				sidecar.citations
					.map((c: { rawKey?: string }) => c.rawKey)
					.filter(Boolean),
			);
			const resolved = [...map.values()].filter((key) => rawKeys.has(key));
			// Every mapped destination should name a citation we parsed.
			expect(resolved.length).toBe(map.size);
		},
	);
});

describe("cross-reference name parsers", () => {
	it("parses standard hyperref names", () => {
		expect(hyperrefCrossrefParser("figure.1")).toEqual({
			kind: "figure",
			number: 1,
		});
		expect(hyperrefCrossrefParser("subfigure.1a")).toEqual({
			kind: "figure",
			number: 1,
		});
		expect(hyperrefCrossrefParser("figure.caption.2")).toEqual({
			kind: "figure",
			number: 2,
		});
		expect(hyperrefCrossrefParser("table.2")).toEqual({
			kind: "table",
			number: 2,
		});
		expect(hyperrefCrossrefParser("table.caption.2")).toEqual({
			kind: "table",
			number: 2,
		});
		expect(hyperrefCrossrefParser("equation.3")).toEqual({
			kind: "equation",
			number: 3,
		});
		expect(hyperrefCrossrefParser("subequation.3a")).toEqual({
			kind: "equation",
			number: 3,
		});
		expect(hyperrefCrossrefParser("equation.E.4")).toEqual({
			kind: "equation",
			number: 4,
		});
		expect(hyperrefCrossrefParser("algorithm.1")).toEqual({
			kind: "algorithm",
			number: 1,
		});
		expect(hyperrefCrossrefParser("algocf.1")).toEqual({
			kind: "algorithm",
			number: 1,
		});
		expect(hyperrefCrossrefParser("algocf.caption.1")).toEqual({
			kind: "algorithm",
			number: 1,
		});
		expect(hyperrefCrossrefParser("section.1")).toBeNull();
		expect(hyperrefCrossrefParser("algocfline.1")).toBeNull();
	});

	it("parses ACS mk:* names", () => {
		expect(acsCrossrefParser("mk:fig1")).toEqual({
			kind: "figure",
			number: 1,
		});
		expect(acsCrossrefParser("mk:figS1")).toEqual({
			kind: "figure",
			number: 1,
		});
		expect(acsCrossrefParser("mk:tbl1")).toEqual({
			kind: "table",
			number: 1,
		});
		expect(acsCrossrefParser("mk:eq1")).toEqual({
			kind: "equation",
			number: 1,
		});
		expect(acsCrossrefParser("mk:ref1")).toBeNull();
		expect(acsCrossrefParser("mk:ath1")).toBeNull();
		// Footnote markers inside a float are not float targets.
		expect(acsCrossrefParser("mk:tbl1fn1")).toBeNull();
		expect(acsCrossrefParser("mk:tbl2fn1")).toBeNull();
	});
});

describe("matchCrossrefLinkLabel", () => {
	const links = [
		{
			pageIndex: 1,
			x: 347.4,
			y: 695.7,
			w: 26.1,
			h: 9.0,
			label: { kind: "table" as const, number: 1 },
		},
		{
			pageIndex: 4,
			x: 531.0,
			y: 667.4,
			w: 27.8,
			h: 10.0,
			label: { kind: "figure" as const, number: 3 },
		},
		{
			// Tiny digit-only link for the same Figure 3 target.
			pageIndex: 4,
			x: 315.4,
			y: 678.4,
			w: 4.8,
			h: 10.0,
			label: { kind: "figure" as const, number: 3 },
		},
	];

	it("matches an exact device-space rect", () => {
		expect(
			matchCrossrefLinkLabel(links, 1, {
				origin: { x: 347.4, y: 695.7 },
				size: { width: 26.1, height: 9.0 },
			}),
		).toEqual({ kind: "table", number: 1 });
	});

	it("matches within centre-distance tolerance", () => {
		expect(
			matchCrossrefLinkLabel(links, 4, {
				origin: { x: 531.2, y: 667.5 },
				size: { width: 27.8, height: 10.0 },
			}),
		).toEqual({ kind: "figure", number: 3 });
	});

	it("resolves a digit-only link rect to the same figure label", () => {
		expect(
			matchCrossrefLinkLabel(links, 4, {
				origin: { x: 315.4, y: 678.4 },
				size: { width: 4.8, height: 10.0 },
			}),
		).toEqual({ kind: "figure", number: 3 });
	});

	it("returns null when nothing is close enough", () => {
		expect(
			matchCrossrefLinkLabel(links, 1, {
				origin: { x: 10, y: 10 },
				size: { width: 20, height: 10 },
			}),
		).toBeNull();
	});

	it("builds a stable rect key", () => {
		expect(linkRectKey(1, 347.41, 695.69, 26.14, 9.02)).toBe(
			"1:347.4:695.7:26.1:9.0",
		);
	});
});

describe("destination coordinate resolvers", () => {
	async function buildTestDest(
		mode: string,
		params: number[],
	): Promise<{
		dest: PDFArray;
		context: PDFContext;
		pageRefs: string[];
	}> {
		const { PDFDocument, PDFName, PDFNumber } = await import("pdf-lib");
		const doc = await PDFDocument.create();
		const page = doc.addPage();
		const context = doc.context;
		const arr = [page.ref, PDFName.of(mode), ...params.map(PDFNumber.of)];
		return { dest: context.obj(arr), context, pageRefs: [page.ref.toString()] };
	}

	it("resolves /XYZ destinations", async () => {
		const { dest, context, pageRefs } = await buildTestDest("XYZ", [0, 500, 0]);
		const result = xyzCoordResolver(dest, context, pageRefs);
		expect(result).toEqual({ pageIndex: 0, pdfY: 500 });
	});

	it("resolves /FitR destinations using the top edge", async () => {
		const { dest, context, pageRefs } = await buildTestDest(
			"FitR",
			[0, 100, 200, 500],
		);
		const result = fitRCoordResolver(dest, context, pageRefs);
		expect(result).toEqual({ pageIndex: 0, pdfY: 500 });
	});

	it("resolves /FitH destinations", async () => {
		const { dest, context, pageRefs } = await buildTestDest("FitH", [600]);
		const result = fitHCoordResolver(dest, context, pageRefs);
		expect(result).toEqual({ pageIndex: 0, pdfY: 600 });
	});
});

describe("buildPdfDestMaps with mixed conventions", () => {
	async function buildMixedPdf() {
		const { PDFDocument, PDFName, PDFNumber, PDFString } = await import(
			"pdf-lib"
		);
		const doc = await PDFDocument.create();
		const page = doc.addPage([612, 792]);
		const context = doc.context;

		function dest(mode: string, params: number[]) {
			return context.obj([
				page.ref,
				PDFName.of(mode),
				...params.map(PDFNumber.of),
			]);
		}

		const namePairs = [
			// Standard hyperref
			PDFString.of("figure.1"),
			dest("XYZ", [0, 400, 0]),
			PDFString.of("table.1"),
			dest("XYZ", [0, 300, 0]),
			PDFString.of("cite.key2024"),
			dest("XYZ", [0, 120, 0]),
			// ACS style — fig and tbl share the same /FitR top to exercise conflict
			// resolution via crossrefKinds.
			PDFString.of("mk:fig1"),
			dest("FitR", [0, 350, 500, 400]),
			PDFString.of("mk:tbl1"),
			dest("FitR", [0, 350, 500, 400]),
			PDFString.of("mk:ref1"),
			dest("FitR", [0, 50, 500, 100]),
		];

		const dests = context.obj({ Names: context.obj(namePairs) });
		doc.catalog.set(PDFName.of("Names"), context.obj({ Dests: dests }));

		// In-text Link annotations pointing at the colliding ACS destinations.
		// PDF Rect is bottom-left; device y = pageHeight - ury.
		const tblLink = context.obj({
			Type: "Annot",
			Subtype: "Link",
			Rect: [347.4, 96.2, 373.5, 105.2],
			A: { S: "GoTo", D: PDFString.of("mk:tbl1") },
		});
		const figLink = context.obj({
			Type: "Annot",
			Subtype: "Link",
			Rect: [473.7, 116.0, 502.9, 125.0],
			A: { S: "GoTo", D: PDFString.of("mk:fig1") },
		});
		const refLink = context.obj({
			Type: "Annot",
			Subtype: "Link",
			Rect: [100.0, 200.0, 112.0, 210.0],
			A: { S: "GoTo", D: PDFString.of("mk:ref1") },
		});
		// A section link whose target coordinate coincides with table.1.
		const sectionLink = context.obj({
			Type: "Annot",
			Subtype: "Link",
			Rect: [200.0, 300.0, 212.0, 310.0],
			A: { S: "GoTo", D: PDFString.of("subsection.5.1") },
		});
		page.node.set(
			PDFName.of("Annots"),
			context.obj([tblLink, figLink, refLink, sectionLink]),
		);

		return { bytes: await doc.save(), page };
	}

	it("resolves both hyperref and ACS crossrefs in one PDF", async () => {
		const { bytes } = await buildMixedPdf();
		const maps = await buildPdfDestMaps(bytes);

		// Standard hyperref targets are unambiguous.
		expect(maps.crossrefs.get(citationDestKey(0, 300))).toBe("table");

		// ACS mk:fig1, mk:tbl1 and the hyperref figure.1 all share y=400, so the
		// unambiguous map drops it, but both kinds survive in crossrefKinds.
		const conflictCoord = citationDestKey(0, 400);
		expect(maps.crossrefs.get(conflictCoord)).toBeUndefined();
		expect(maps.crossrefKinds.get(conflictCoord)?.sort()).toEqual([
			"figure",
			"table",
		]);
		expect(maps.crossrefLabels.get(conflictCoord)?.sort()).toEqual([
			{ kind: "figure", number: 1 },
			{ kind: "table", number: 1 },
		]);

		expect(maps.cites.get(citationDestKey(0, 120))).toBe("key2024");
		expect(maps.cites.get(citationDestKey(0, 100))).toBe("mk:ref1");
	});

	it("allows custom parsers to be injected", async () => {
		const { bytes } = await buildMixedPdf();
		const customParser = (name: string) =>
			name.startsWith("custom:") ? { kind: "figure" as const } : null;

		const maps = await buildPdfDestMaps(bytes, {
			crossrefParsers: [customParser],
			citationParsers: [],
			coordResolvers: [xyzCoordResolver],
		});

		// Only the custom parser runs; standard names are ignored.
		expect(maps.crossrefs.get(citationDestKey(0, 400))).toBeUndefined();
		expect(maps.cites.size).toBe(0);
	});

	it("keeps conflicting kinds in crossrefKinds for fallback disambiguation", async () => {
		const { bytes } = await buildMixedPdf();
		const maps = await buildPdfDestMaps(bytes);

		// mk:fig1, mk:tbl1 and hyperref figure.1 share the same coordinate on page 1.
		const conflictCoord = citationDestKey(0, 400);
		expect(maps.crossrefs.get(conflictCoord)).toBeUndefined();
		expect(maps.crossrefKinds.get(conflictCoord)?.sort()).toEqual([
			"figure",
			"table",
		]);
		expect(maps.crossrefLabels.get(conflictCoord)?.sort()).toEqual([
			{ kind: "figure", number: 1 },
			{ kind: "table", number: 1 },
		]);

		// Unambiguous coordinates still appear in both maps.
		expect(maps.crossrefs.get(citationDestKey(0, 300))).toBe("table");
		expect(maps.crossrefKinds.get(citationDestKey(0, 300))).toEqual(["table"]);
		expect(maps.crossrefLabels.get(citationDestKey(0, 300))).toEqual([
			{ kind: "table", number: 1 },
		]);
	});

	it("indexes Link annotation rects so colliding ACS dests stay unique", async () => {
		const { bytes } = await buildMixedPdf();
		const maps = await buildPdfDestMaps(bytes);

		expect(maps.crossrefLinks.length).toBe(2);
		expect(maps.citationLinks.length).toBe(1);

		// PDF Rect [347.4, 96.2, 373.5, 105.2] on a 792-pt page → device y =
		// 792 - 105.2 = 686.8.
		expect(
			matchCrossrefLinkLabel(maps.crossrefLinks, 0, {
				origin: { x: 347.4, y: 686.8 },
				size: { width: 26.1, height: 9.0 },
			}),
		).toEqual({ kind: "table", number: 1 });

		expect(
			matchCrossrefLinkLabel(maps.crossrefLinks, 0, {
				origin: { x: 473.7, y: 667.0 },
				size: { width: 29.2, height: 9.0 },
			}),
		).toEqual({ kind: "figure", number: 1 });

		// PDF Rect [100, 200, 112, 210] → device y = 792 - 210 = 582.
		expect(
			matchCitationLinkKey(maps.citationLinks, 0, {
				origin: { x: 100.0, y: 582.0 },
				size: { width: 12.0, height: 10.0 },
			}),
		).toBe("mk:ref1");
	});

	it("indexes links whose dest name is neither a cite nor a float", async () => {
		const { bytes } = await buildMixedPdf();
		const maps = await buildPdfDestMaps(bytes);

		// PDF Rect [200, 300, 212, 310] → device y = 792 - 310 = 482.
		expect(maps.otherNamedLinks).toHaveLength(1);
		expect(
			isOtherNamedLink(maps.otherNamedLinks, 0, {
				origin: { x: 200.0, y: 482.0 },
				size: { width: 12.0, height: 10.0 },
			}),
		).toBe(true);
		// Cite / float links are not "other".
		expect(
			isOtherNamedLink(maps.otherNamedLinks, 0, {
				origin: { x: 100.0, y: 582.0 },
				size: { width: 12.0, height: 10.0 },
			}),
		).toBe(false);
	});
});

/** A generated PDF whose visible page box has a nonzero origin. */
async function offsetBoxCitationPdf(): Promise<Uint8Array> {
	const { PDFDocument, PDFName, PDFNumber, PDFString } = await import(
		"pdf-lib"
	);
	const doc = await PDFDocument.create();
	const page = doc.addPage([595, 842]);
	page.setMediaBox(82.5, 90, 430, 660);
	page.setCropBox(0, 0, 595, 842);
	const context = doc.context;
	const dest = context.obj([
		page.ref,
		PDFName.of("XYZ"),
		PDFNumber.of(134),
		PDFNumber.of(707),
		PDFNumber.of(0),
	]);
	doc.catalog.set(
		PDFName.of("Names"),
		context.obj({
			Dests: context.obj({
				Names: context.obj([PDFString.of("cite.sample"), dest]),
			}),
		}),
	);
	const link = context.obj({
		Type: "Annot",
		Subtype: "Link",
		Rect: [182.5, 700, 194.5, 710],
		A: { S: "GoTo", D: PDFString.of("cite.sample") },
	});
	page.node.set(PDFName.of("Annots"), context.obj([link]));
	return doc.save();
}

describe("page boxes not at the origin", () => {
	it("measures link rects and destinations from the visible box", async () => {
		const maps = await buildPdfDestMaps(await offsetBoxCitationPdf());

		expect(maps.pageOrigins).toEqual([{ x: 82.5, y: 90 }]);
		// Device rect relative to the visible box: x = 182.5 − 82.5,
		// y = (90 + 660) − 710.
		expect(
			matchCitationLinkKey(maps.citationLinks, 0, {
				origin: { x: 100, y: 40 },
				size: { width: 12, height: 10 },
			}),
		).toBe("sample");
		// Map keys stay in raw user space; geometry shifts into the box.
		expect(maps.cites.get(citationDestKey(0, 707))).toBe("sample");
		expect(
			destinationInPageBox(
				{ pageIndex: 0, pdfX: 134, pdfY: 707 },
				maps.pageOrigins,
			),
		).toEqual({ pageIndex: 0, pdfX: 51.5, pdfY: 617 });
	});

	it("matches the link rects EmbedPDF reports", async () => {
		const bytes = await offsetBoxCitationPdf();
		const maps = await buildPdfDestMaps(bytes);
		const pdf = new PdfiumNative(
			await init({
				wasmBinary: readFileSync(
					fileURLToPath(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")),
				),
			}),
			{ fontFallback: null },
		);
		const doc = await pdf
			.openDocumentBuffer({
				id: "offset-box-citation",
				content: bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength,
				) as ArrayBuffer,
			})
			.toPromise();
		const annotations = await pdf
			.getPageAnnotations(doc, doc.pages[0])
			.toPromise();
		const links = annotations.filter(
			(a): a is PdfLinkAnnoObject => a.type === PdfAnnotationSubtype.LINK,
		);
		expect(links).toHaveLength(1);
		// The viewer hovers EmbedPDF's rect, so ours must be in the same space.
		expect(matchCitationLinkKey(maps.citationLinks, 0, links[0].rect)).toBe(
			"sample",
		);
		await pdf.closeDocument(doc).toPromise();
	});

	it("leaves destinations alone for boxes at (0, 0) or unknown origins", () => {
		const dest = { pageIndex: 1, pdfX: 50, pdfY: 400 };
		expect(
			destinationInPageBox(dest, [
				{ x: 0, y: 0 },
				{ x: 0, y: 0 },
			]),
		).toBe(dest);
		expect(destinationInPageBox(dest, null)).toBe(dest);
		expect(
			destinationInPageBox({ ...dest, pdfX: null }, [
				{ x: 0, y: 0 },
				{ x: 10, y: 20 },
			]),
		).toEqual({ pageIndex: 1, pdfX: null, pdfY: 380 });
	});
});

describe("citationSidecarKeysForDest", () => {
	it("passes hyperref keys through", () => {
		expect(citationSidecarKeysForDest("smith2020")).toEqual(["smith2020"]);
	});

	it("maps ACS mk:refN to sidecar ref-N ids", () => {
		expect(citationSidecarKeysForDest("mk:ref12")).toEqual([
			"mk:ref12",
			"ref-12",
			"ref12",
		]);
	});

	it("maps Springer and ACM citation dests to candidate ids", () => {
		expect(citationSidecarKeysForDest("ch3CR2")).toEqual([
			"ch3CR2",
			"ref-2",
			"ref2",
			"2",
		]);
		expect(citationSidecarKeysForDest("CR5")).toEqual([
			"CR5",
			"ref-5",
			"ref5",
			"5",
		]);
		expect(citationSidecarKeysForDest("Bib0001")).toEqual([
			"Bib0001",
			"ref-1",
			"ref1",
			"1",
		]);
	});
});

describe("citationRefNumber", () => {
	it("extracts numeric index from ACS, Springer, and ACM keys", () => {
		expect(citationRefNumber("mk:ref12")).toBe(12);
		expect(citationRefNumber("ch3CR2")).toBe(2);
		expect(citationRefNumber("CR5")).toBe(5);
		expect(citationRefNumber("Bib0004")).toBe(4);
		expect(citationRefNumber("cite.smith2020")).toBeNull();
		expect(citationRefNumber("bib1")).toBeNull();
		expect(citationRefNumber("bib2")).toBeNull();
	});

	it("leaves short bibN names (not ACM Bib0001) unparsed in sidecar keys", () => {
		expect(citationSidecarKeysForDest("bib1")).toEqual(["bib1"]);
		expect(citationSidecarKeysForDest("bib2")).toEqual(["bib2"]);
	});
});

describe("springerCrossrefParser", () => {
	it("parses Springer float destinations", () => {
		expect(springerCrossrefParser("ch3Fig1")).toEqual({
			kind: "figure",
			number: 1,
		});
		expect(springerCrossrefParser("Fig2")).toEqual({
			kind: "figure",
			number: 2,
		});
		expect(springerCrossrefParser("ch3Tab1")).toEqual({
			kind: "table",
			number: 1,
		});
		expect(springerCrossrefParser("Tab2")).toEqual({
			kind: "table",
			number: 2,
		});
		expect(springerCrossrefParser("ch3Eq3")).toEqual({
			kind: "equation",
			number: 3,
		});
		expect(springerCrossrefParser("Alg4")).toEqual({
			kind: "algorithm",
			number: 4,
		});
		expect(springerCrossrefParser("ch3Sec1")).toBeNull();
	});
});

describe("springerCitationParser", () => {
	it("parses Springer and ACM citation destinations", () => {
		expect(springerCitationParser("ch3CR1")).toBe("ch3CR1");
		expect(springerCitationParser("CR9")).toBe("CR9");
		expect(springerCitationParser("Bib0001")).toBe("Bib0001");
		expect(springerCitationParser("ch3Sec1")).toBeNull();
	});
});

describe("expandCitationLinkCluster", () => {
	/** Geometry from ACS `7,9,14-18` (comma ~1.7pt, hyphen ~5.3pt). */
	const cluster = [
		{
			pageIndex: 0,
			x: 397.9,
			y: 565.3,
			w: 3.7,
			h: 9,
			key: "mk:ref7",
		},
		{
			pageIndex: 0,
			x: 403.3,
			y: 565.3,
			w: 3.7,
			h: 9,
			key: "mk:ref9",
		},
		{
			pageIndex: 0,
			x: 408.6,
			y: 565.3,
			w: 7.4,
			h: 9,
			key: "mk:ref14",
		},
		{
			pageIndex: 0,
			x: 421.4,
			y: 565.3,
			w: 7.4,
			h: 9,
			key: "mk:ref18",
		},
	];

	it("expands hyphen ranges but keeps comma-separated neighbours", () => {
		expect(
			expandCitationLinkCluster(cluster, 0, {
				origin: { x: 408.6, y: 565.3 },
				size: { width: 7.4, height: 9 },
			}),
		).toEqual([
			"mk:ref7",
			"mk:ref9",
			"mk:ref14",
			"mk:ref15",
			"mk:ref16",
			"mk:ref17",
			"mk:ref18",
		]);
	});

	it("does not fill a comma-separated pair with a large numeric gap", () => {
		const commaOnly = [
			{
				pageIndex: 0,
				x: 346.7,
				y: 577.4,
				w: 7.3,
				h: 9,
				key: "mk:ref11",
			},
			{
				pageIndex: 0,
				x: 355.5,
				y: 577.4,
				w: 7.3,
				h: 9,
				key: "mk:ref19",
			},
		];
		expect(
			expandCitationLinkCluster(commaOnly, 0, {
				origin: { x: 346.7, y: 577.4 },
				size: { width: 7.3, height: 9 },
			}),
		).toEqual(["mk:ref11", "mk:ref19"]);
	});

	it("returns a singleton for an isolated link", () => {
		expect(
			expandCitationLinkCluster(
				[
					{
						pageIndex: 1,
						x: 100,
						y: 200,
						w: 8,
						h: 9,
						key: "mk:ref3",
					},
				],
				1,
				{ origin: { x: 100, y: 200 }, size: { width: 8, height: 9 } },
			),
		).toEqual(["mk:ref3"]);
	});
});

describe("ACS paper link-rect crossrefs", () => {
	it.skipIf(!paperDir)(
		"resolves Table 1 and Figure 3 via link dest names despite FitR collisions",
		async () => {
			const dir = paperDir as string;
			const name = dir.replace(/\/$/, "").split("/").pop();
			const bytes = readFileSync(`${dir}/${name}.pdf`);
			const maps = await buildPdfDestMaps(bytes);

			// Every float on a page shares one /FitR rectangle, so dest-coord
			// labels collide — Table 1 and Figure 1 both live at page 1.
			const page1Coord = [...maps.crossrefLabels.entries()].find(([key]) =>
				key.startsWith("1:"),
			);
			expect(page1Coord?.[1].length).toBeGreaterThan(1);

			const tbl1 = maps.crossrefLinks.find(
				(l) => l.label.kind === "table" && l.label.number === 1,
			);
			const fig3 = maps.crossrefLinks.find(
				(l) => l.label.kind === "figure" && l.label.number === 3,
			);
			expect(tbl1).toBeTruthy();
			expect(fig3).toBeTruthy();

			// Layout sidecar (when present) must resolve those labels to regions.
			const layoutPath = `${dir}/source/layout.json`;
			try {
				const layout = JSON.parse(readFileSync(layoutPath, "utf8")) as {
					regions: Parameters<typeof mergeCaptionsIntoHosts>[0];
				};
				const merged = mergeCaptionsIntoHosts(layout.regions);
				const tableRegion = pickCrossrefRegionByLabel(merged, 1, {
					kind: "table",
					number: 1,
				});
				const figureRegion = pickCrossrefRegionByLabel(merged, 3, {
					kind: "figure",
					number: 3,
				});
				expect(tableRegion?.kind).toBe("table");
				expect(tableRegion?.title?.toLowerCase().startsWith("table 1")).toBe(
					true,
				);
				expect(
					figureRegion?.kind === "image" || figureRegion?.kind === "chart",
				).toBe(true);
				expect(figureRegion?.title?.toLowerCase().startsWith("figure 3")).toBe(
					true,
				);
			} catch {
				// Sidecar optional outside the Agentero vault fixture.
			}
		},
	);

	it.skipIf(!paperDir)(
		"indexes mk:ref* citation links when FitR bibliography coords collide",
		async () => {
			const dir = paperDir as string;
			const name = dir.replace(/\/$/, "").split("/").pop();
			const bytes = readFileSync(`${dir}/${name}.pdf`);
			const maps = await buildPdfDestMaps(bytes);

			// Coord map is empty: 32 refs share one /FitR rectangle per page.
			expect(maps.cites.size).toBe(0);
			expect(maps.citationLinks.length).toBeGreaterThan(0);

			const ref1 = maps.citationLinks.find((l) => l.key === "mk:ref1");
			const ref64 = maps.citationLinks.find((l) => l.key === "mk:ref64");
			expect(ref1).toBeTruthy();
			expect(ref64).toBeTruthy();

			const sidecar = JSON.parse(
				readFileSync(`${dir}/source/agentero-cite.json`, "utf8"),
			) as { citations: { id: string; rawKey?: string }[] };
			const keys = new Set(citationSidecarKeysForDest("mk:ref1"));
			const matched = sidecar.citations.find(
				(c) => (c.rawKey != null && keys.has(c.rawKey)) || keys.has(c.id),
			);
			expect(matched?.id).toBe("ref-1");
		},
	);
});

describe("crossref label extraction", () => {
	it("extracts figure labels", () => {
		expect(extractCrossrefLabel("see Figure 1 for details")).toEqual({
			kind: "figure",
			number: 1,
		});
		expect(extractCrossrefLabel("Fig. 2 shows")).toEqual({
			kind: "figure",
			number: 2,
		});
	});

	it("extracts table labels", () => {
		expect(extractCrossrefLabel("in Table 3")).toEqual({
			kind: "table",
			number: 3,
		});
	});

	it("extracts equation labels", () => {
		expect(extractCrossrefLabel("using Eq. (4)")).toEqual({
			kind: "equation",
			number: 4,
		});
		expect(extractCrossrefLabel("Equation 5")).toEqual({
			kind: "equation",
			number: 5,
		});
	});

	it("returns null for non-crossref text", () => {
		expect(extractCrossrefLabel("see Section 1")).toBeNull();
		expect(extractCrossrefLabel("hello world")).toBeNull();
	});
});
