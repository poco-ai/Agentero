import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import fontkit from "@pdf-lib/fontkit";
import {
	PDFArray,
	PDFDict,
	PDFDocument,
	PDFName,
	type PDFObject,
	type PDFPage,
	PDFRef,
	PDFStream,
	rgb,
	StandardFonts,
} from "pdf-lib";
import { visiblePageBox } from "../page-box";
import type { ReflowFontBytes } from "./fonts";
import { layoutReflowDocument, type ReflowFonts } from "./layout";
import { relocateReflowLinks } from "./links";
import {
	type PageLayout,
	REFLOW_IR_SCHEMA_VERSION,
	type ReflowDocument,
} from "./types";

/**
 * pdf-lib re-parses font bytes on every `embedFont` call, and page-level
 * preview builds re-embed the full CJK pair (`subset: false`) for each page,
 * so the same ~20 MB fonts were parsed per page on the main thread.
 * `loadReflowFonts()` returns cached byte instances, which key this parse
 * cache shared across every build of the session.
 */
const parsedFonts = new WeakMap<
	Uint8Array,
	ReturnType<typeof fontkit.create>
>();
const cachingFontkit = {
	...fontkit,
	create(bytes: Uint8Array) {
		const cached = parsedFonts.get(bytes);
		if (cached) return cached;
		const font = fontkit.create(bytes);
		parsedFonts.set(bytes, font);
		return font;
	},
} as typeof fontkit;

export async function embedReflowFonts(
	pdf: PDFDocument,
	cjkBytes: Uint8Array | ReflowFontBytes,
): Promise<ReflowFonts> {
	pdf.registerFontkit(cachingFontkit);
	const bundle = cjkBytes instanceof Uint8Array ? null : cjkBytes;
	const cjkData = cjkBytes instanceof Uint8Array ? cjkBytes : cjkBytes.cjk;
	const [regular, bold, italic, boldItalic, cjk, cjkBold] = await Promise.all([
		pdf.embedFont(bundle?.regular ?? StandardFonts.TimesRoman),
		pdf.embedFont(bundle?.bold ?? StandardFonts.TimesRomanBold),
		pdf.embedFont(bundle?.italic ?? StandardFonts.TimesRomanItalic),
		pdf.embedFont(bundle?.boldItalic ?? StandardFonts.TimesRomanBoldItalic),
		// fontkit 1.1.1 subsetting drops composite Source Han outlines. Full
		// embedding preserves all glyphs; share these font objects document-wide.
		pdf.embedFont(cjkData, { subset: false }),
		bundle
			? pdf.embedFont(bundle.cjkBold, { subset: false })
			: pdf.embedFont(cjkData, { subset: false }),
	]);
	return { regular, bold, italic, boldItalic, cjk, cjkBold };
}
export type ReflowOutput = { bytes: Uint8Array; pages: PageLayout[] };
/** Vector formulas are clipped from an untouched original, not reconstructed text. */
export async function writeReflowPdf(
	original: Uint8Array,
	redacted: Uint8Array,
	ir: ReflowDocument,
	translations: ReadonlyMap<string, string>,
	cjkFont: Uint8Array | ReflowFontBytes,
	dual = false,
	formulaPdfs: ReadonlyMap<string, Uint8Array> = new Map(),
	commonScale = true,
	onProgress?: (ratio: number) => void,
): Promise<ReflowOutput> {
	const pdf = await PDFDocument.load(redacted);
	const source = await PDFDocument.load(original);
	const fonts = await embedReflowFonts(pdf, cjkFont);
	onProgress?.(0.1);
	const pages = layoutReflowDocument(ir, translations, fonts, commonScale);
	for (const [pageIndex, page] of pages.entries()) {
		const target = pdf.getPage(page.index);
		if (target.getRotation().angle !== 0)
			throw new Error("Rotated pages require normalized page coordinates");
		const sourcePage = ir.pages.find((p) => p.index === page.index);
		if (sourcePage) relocateReflowLinks(target, sourcePage, page);
		const crop = visiblePageBox(target);
		for (const paragraph of page.paragraphs) {
			if (!paragraph.fits)
				throw new Error(`Translation does not fit: ${paragraph.id}`);
			// Text was removed by PDFium. Only formula strokes need covering;
			// clearing whole paragraphs erases table rules and coloured backgrounds.
			const originalParagraph = sourcePage?.paragraphs.find(
				(p) => p.id === paragraph.id,
			);
			for (const { box: b } of originalParagraph?.formulas ?? []) {
				target.drawRectangle({
					x: crop.x + b.x,
					y: crop.y + crop.height - b.y - b.h,
					width: b.w,
					height: b.h,
					color: rgb(1, 1, 1),
				});
			}
		}
		for (const paragraph of page.paragraphs) {
			for (const unit of paragraph.units) {
				if (unit.formula) {
					const f = unit.formula.box;
					if (f.w <= 0 || f.h <= 0) continue;
					const fragment = formulaPdfs.get(
						`${paragraph.id}:${unit.formula.id}`,
					);
					if (!fragment)
						throw new Error(`Missing formula fragment: ${paragraph.id}`);
					const fragmentDoc = await PDFDocument.load(fragment);
					const fragmentPage = fragmentDoc.getPage(0);
					const fragmentBox = visiblePageBox(fragmentPage);
					const snippet = await pdf.embedPage(fragmentPage, {
						left: fragmentBox.x + f.x,
						bottom: fragmentBox.y + fragmentBox.height - f.y - f.h,
						right: fragmentBox.x + f.x + f.w,
						top: fragmentBox.y + fragmentBox.height - f.y,
					});
					target.drawPage(snippet, {
						x: crop.x + unit.x,
						y: crop.y + crop.height - unit.y,
						width: unit.width,
						height: unit.height,
					});
				} else {
					target.drawText(unit.text, {
						x: crop.x + unit.x,
						y: crop.y + crop.height - unit.y,
						size: unit.fontSize,
						font: fonts[unit.font],
						color: rgb(
							unit.color.r / 255,
							unit.color.g / 255,
							unit.color.b / 255,
						),
					});
				}
			}
		}
		onProgress?.(0.1 + 0.75 * ((pageIndex + 1) / pages.length));
	}
	if (dual) {
		const originals = await copyOriginalPages(pdf, source);
		originals.forEach((page, i) => {
			pdf.insertPage(i * 2, page);
		});
	}
	const bytes = await pdf.save();
	onProgress?.(1);
	return { bytes, pages };
}
/** Work on an isolated PDFium document: never redact the open source viewer. */
export async function buildReflowPdf(
	engine: PdfEngine,
	doc: PdfDocumentObject,
	ir: ReflowDocument,
	translations: ReadonlyMap<string, string>,
	cjkFont: Uint8Array | ReflowFontBytes,
	signal?: AbortSignal,
	commonScale = true,
	/** `pages` reports the page loop so the meter can show a real count. */
	onProgress?: (ratio: number, pages?: { done: number; total: number }) => void,
): Promise<ReflowOutput> {
	signal?.throwIfAborted();
	const original = new Uint8Array(await engine.saveAsCopy(doc).toPromise());
	const formulaPdfs = new Map<string, Uint8Array>();
	const formulaCount = ir.pages.reduce(
		(count, page) =>
			count +
			page.paragraphs
				.filter((p) => translations.has(p.id))
				.reduce((n, p) => n + p.formulas.length, 0),
		0,
	);
	for (const page of ir.pages) {
		const formulas = page.paragraphs
			.filter((p) => translations.has(p.id))
			.flatMap((p) =>
				p.formulas.map((f) => ({ key: `${p.id}:${f.id}`, formula: f })),
			);
		if (!formulas.length) continue;
		const singlePage = await engine.extractPages(doc, [page.index]).toPromise();
		for (const { key, formula } of formulas) {
			signal?.throwIfAborted();
			const fragment = await engine
				.openDocumentBuffer({
					id: `formula-${crypto.randomUUID()}`,
					content: singlePage.slice(0),
				})
				.toPromise();
			try {
				const b = formula.box,
					pad = 0.75;
				const left = Math.max(0, b.x - pad),
					top = Math.max(0, b.y - pad),
					right = Math.min(page.width, b.x + b.w + pad),
					bottom = Math.min(page.height, b.y + b.h + pad);
				const outside = [
					{ x: 0, y: 0, w: page.width, h: top },
					{ x: 0, y: bottom, w: page.width, h: page.height - bottom },
					{ x: 0, y: top, w: left, h: bottom - top },
					{ x: right, y: top, w: page.width - right, h: bottom - top },
				]
					.filter((b) => b.w > 0 && b.h > 0)
					.map((b) => ({
						origin: { x: b.x, y: b.y },
						size: { width: b.w, height: b.h },
					}));
				await engine
					.redactTextInRects(fragment, fragment.pages[0], outside, {
						recurseForms: true,
						drawBlackBoxes: false,
					})
					.toPromise();
				formulaPdfs.set(
					key,
					new Uint8Array(await engine.saveAsCopy(fragment).toPromise()),
				);
			} finally {
				await engine.closeDocument(fragment).toPromise();
			}
			onProgress?.((0.4 * formulaPdfs.size) / Math.max(1, formulaCount));
		}
	}
	onProgress?.(0.4);
	const clone = await engine
		.openDocumentBuffer({
			id: `reflow-${crypto.randomUUID()}`,
			content: original.slice().buffer,
		})
		.toPromise();
	try {
		for (const [pageIndex, page] of ir.pages.entries()) {
			signal?.throwIfAborted();
			const rects = page.paragraphs
				.filter((p) => translations.has(p.id))
				.map((p) => ({
					origin: { x: p.box.x, y: p.box.y },
					size: { width: p.box.w, height: p.box.h },
				}));
			if (rects.length)
				await engine
					.redactTextInRects(clone, clone.pages[page.index], rects, {
						recurseForms: true,
						drawBlackBoxes: false,
					})
					.toPromise();
			onProgress?.(0.4 + 0.2 * ((pageIndex + 1) / ir.pages.length), {
				done: pageIndex + 1,
				total: ir.pages.length,
			});
		}
		const redacted = new Uint8Array(await engine.saveAsCopy(clone).toPromise());
		signal?.throwIfAborted();
		return await writeReflowPdf(
			original,
			redacted,
			ir,
			translations,
			cjkFont,
			false,
			formulaPdfs,
			commonScale,
			(ratio) => onProgress?.(0.6 + 0.4 * ratio),
		);
	} finally {
		await engine.closeDocument(clone).toPromise();
	}
}

/** Preview bytes contain one page; layouts retain the source document's indexes. */
export async function buildReflowPage(
	engine: PdfEngine,
	doc: PdfDocumentObject,
	ir: ReflowDocument,
	translations: ReadonlyMap<string, string>,
	fonts: ReflowFontBytes,
	signal?: AbortSignal,
): Promise<ReflowOutput> {
	if (ir.pages.length !== 1) throw new Error("Expected one reflow page");
	const page = ir.pages[0];
	signal?.throwIfAborted();
	const content = await engine.extractPages(doc, [page.index]).toPromise();
	signal?.throwIfAborted();
	const single = await engine
		.openDocumentBuffer({
			id: `reflow-page-${crypto.randomUUID()}`,
			content,
		})
		.toPromise();
	try {
		const result = await buildReflowPdf(
			engine,
			single,
			{
				version: REFLOW_IR_SCHEMA_VERSION,
				pages: [
					{
						...page,
						index: 0,
						paragraphs: page.paragraphs.map((p) => ({ ...p, pageIndex: 0 })),
					},
				],
			},
			translations,
			fonts,
			signal,
			false,
		);
		return {
			bytes: result.bytes,
			pages: result.pages.map((p) => ({
				...p,
				index: page.index,
				paragraphs: p.paragraphs.map((q) => ({ ...q, pageIndex: page.index })),
			})),
		};
	} finally {
		await engine.closeDocument(single).toPromise();
	}
}

/** Interleave original/translated pages without rasterizing either document. */
export async function interleaveReflowPdf(
	original: Uint8Array,
	translated: Uint8Array,
): Promise<Uint8Array> {
	const pdf = await PDFDocument.load(translated),
		source = await PDFDocument.load(original);
	if (pdf.getPageCount() !== source.getPageCount())
		throw new Error("Bilingual PDF page counts differ");
	const pages = await copyOriginalPages(pdf, source);
	pages.forEach((page, index) => {
		pdf.insertPage(index * 2, page);
	});
	return pdf.save();
}

/** Replace changed pages while keeping the existing page references and order. */
export async function replaceReflowPages(
	previous: Uint8Array,
	replacement: Uint8Array,
	indexes: readonly number[],
): Promise<Uint8Array> {
	const pdf = await PDFDocument.load(previous);
	const source = await PDFDocument.load(replacement);
	if (pdf.getPageCount() !== source.getPageCount())
		throw new Error("Replacement PDF page counts differ");
	const targets = pdf.getPages();
	const originals = indexes.map((index) => source.getPage(index));
	const copies = await pdf.copyPages(source, [...indexes]);
	remapCopiedPageDestinations(pdf, source, originals, copies, targets);
	copies.forEach((page, i) => {
		const target = targets[indexes[i]];
		const parent = target.node.get(PDFName.of("Parent"));
		if (parent) page.node.set(PDFName.of("Parent"), parent);
		const annotations = page.node.Annots();
		if (annotations)
			for (let j = 0; j < annotations.size(); j++) {
				const annotation = annotations.lookup(j, PDFDict);
				if (annotation.has(PDFName.of("P")))
					annotation.set(PDFName.of("P"), target.ref);
			}
		// Assign into the old ref so links from untouched pages keep their target.
		pdf.context.assign(target.ref, page.node);
	});
	// Every page build embeds the full CJK font pair. Reuse identical font
	// streams and release replaced page resources before serializing the result.
	const fontStreams = new Map<string, { ref: PDFRef; bytes: Uint8Array }[]>();
	for (const [, object] of pdf.context.enumerateIndirectObjects()) {
		if (
			!(object instanceof PDFDict) ||
			object.get(PDFName.of("Type")) !== PDFName.of("FontDescriptor")
		)
			continue;
		for (const name of ["FontFile", "FontFile2", "FontFile3"]) {
			const key = PDFName.of(name);
			const ref = object.get(key);
			const stream = pdf.context.lookup(ref);
			if (!(ref instanceof PDFRef) || !(stream instanceof PDFStream)) continue;
			const bytes = stream.getContents();
			const streamKey = `${name}:${bytes.length}:${stream.dict.toString()}`;
			const candidates = fontStreams.get(streamKey) ?? [];
			const match = candidates.find(
				(candidate) =>
					candidate.ref === ref ||
					candidate.bytes.every((byte, i) => byte === bytes[i]),
			);
			if (match) object.set(key, match.ref);
			else {
				candidates.push({ ref, bytes });
				fontStreams.set(streamKey, candidates);
			}
		}
	}
	const reachable = new Set<PDFObject>();
	const pending = Object.values(pdf.context.trailerInfo).filter(
		(value): value is PDFObject => value !== undefined,
	);
	while (pending.length) {
		const object = pending.pop();
		if (!object || reachable.has(object)) continue;
		reachable.add(object);
		if (object instanceof PDFRef) {
			const target = pdf.context.lookup(object);
			if (target) pending.push(target);
		} else if (object instanceof PDFStream) pending.push(object.dict);
		else if (object instanceof PDFDict) pending.push(...object.values());
		else if (object instanceof PDFArray) pending.push(...object.asArray());
	}
	for (const [ref] of pdf.context.enumerateIndirectObjects())
		if (!reachable.has(ref)) pdf.context.delete(ref);
	return pdf.save();
}

/** copyPages can leave GoTo destinations pointing at detached copies of pages. */
async function copyOriginalPages(
	pdf: PDFDocument,
	source: PDFDocument,
): Promise<PDFPage[]> {
	const pages = await pdf.copyPages(source, source.getPageIndices());
	remapCopiedPageDestinations(pdf, source, source.getPages(), pages, pages);
	return pages;
}

function remapCopiedPageDestinations(
	pdf: PDFDocument,
	source: PDFDocument,
	originals: PDFPage[],
	copies: PDFPage[],
	targets: PDFPage[],
): void {
	const pageIndex = new Map(
		source.getPages().map((page, i) => [page.ref.toString(), i]),
	);
	const destination = (annotation: PDFDict) => {
		const action = annotation.lookupMaybe(PDFName.of("A"), PDFDict);
		return (
			annotation.get(PDFName.of("Dest")) ??
			(action?.get(PDFName.of("S"))?.toString() === "/GoTo"
				? action.get(PDFName.of("D"))
				: undefined)
		);
	};
	copies.forEach((page, index) => {
		const annotations = page.node.Annots(),
			originalAnnotations = originals[index].node.Annots();
		if (!annotations || !originalAnnotations) return;
		for (let i = 0; i < annotations.size(); i++) {
			const oldDest = destination(originalAnnotations.lookup(i, PDFDict));
			const newDest = destination(annotations.lookup(i, PDFDict));
			const oldArray = oldDest ? source.context.lookup(oldDest) : undefined;
			const newArray = newDest ? pdf.context.lookup(newDest) : undefined;
			if (!(oldArray instanceof PDFArray) || !(newArray instanceof PDFArray))
				continue;
			const target = pageIndex.get(oldArray.get(0).toString());
			if (target !== undefined) newArray.set(0, targets[target].ref);
		}
	});
}
