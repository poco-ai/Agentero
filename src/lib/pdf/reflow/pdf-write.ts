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
import type { FontKey, PageLayout, ReflowDocument } from "./types";

/**
 * Reuse metrics and parsed fonts across jobs while the worker holds their bytes.
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

function fontSources(
	fonts: Uint8Array | ReflowFontBytes,
): Record<FontKey, Uint8Array | StandardFonts> {
	if (!(fonts instanceof Uint8Array)) return fonts;
	return {
		regular: StandardFonts.TimesRoman,
		bold: StandardFonts.TimesRomanBold,
		italic: StandardFonts.TimesRomanItalic,
		boldItalic: StandardFonts.TimesRomanBoldItalic,
		cjk: fonts,
		cjkBold: fonts,
	};
}

async function loadMetrics(
	bytes: Uint8Array | ReflowFontBytes,
): Promise<ReflowFonts> {
	const pdf = await PDFDocument.create();
	pdf.registerFontkit(cachingFontkit);
	const entries = Object.entries(fontSources(bytes));
	return Object.fromEntries(
		await Promise.all(
			entries.map(async ([key, source]) => [
				key,
				await pdf.embedFont(source, { subset: false }),
			]),
		),
	) as ReflowFonts;
}
export type ReflowOutput = { bytes: Uint8Array; pages: PageLayout[] };
export type ReflowWriteTimings = {
	layoutMs?: number;
	saveMs?: number;
};

export async function layoutReflowPdf(
	ir: ReflowDocument,
	translations: ReadonlyMap<string, string>,
	fontBytes: Uint8Array | ReflowFontBytes,
	commonScale: boolean,
): Promise<PageLayout[]> {
	const metrics = await loadMetrics(fontBytes);
	return layoutReflowDocument(ir, translations, metrics, commonScale);
}

/** Vector formulas are clipped from an untouched original, not reconstructed text. */
export async function writeReflowPdf(
	redacted: Uint8Array,
	ir: ReflowDocument,
	translations: ReadonlyMap<string, string>,
	cjkFont: Uint8Array | ReflowFontBytes,
	formulaPdfs: ReadonlyMap<string, Uint8Array>,
	commonScale: boolean,
	onProgress?: (ratio: number) => void,
	timings?: ReflowWriteTimings,
): Promise<ReflowOutput> {
	const pdf = await PDFDocument.load(redacted);
	const layoutStart = performance.now();
	const pages = await layoutReflowPdf(ir, translations, cjkFont, commonScale);
	if (timings) timings.layoutMs = performance.now() - layoutStart;
	pdf.registerFontkit(cachingFontkit);
	const sources = fontSources(cjkFont);
	const usedFonts = new Map<
		FontKey,
		Awaited<ReturnType<PDFDocument["embedFont"]>>
	>();
	const sourcePages = new Map(ir.pages.map((page) => [page.index, page]));
	onProgress?.(0.1);
	for (const [pageIndex, page] of pages.entries()) {
		const target = pdf.getPage(page.index);
		if (target.getRotation().angle !== 0)
			throw new Error("Rotated pages require normalized page coordinates");
		const sourcePage = sourcePages.get(page.index);
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
					let font = usedFonts.get(unit.font);
					if (!font) {
						font = await pdf.embedFont(sources[unit.font], {
							subset: false,
						});
						usedFonts.set(unit.font, font);
					}
					target.drawText(unit.text, {
						x: crop.x + unit.x,
						y: crop.y + crop.height - unit.y,
						size: unit.fontSize,
						font,
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
	const bytes = await savePdf(pdf, timings);
	onProgress?.(1);
	return { bytes, pages };
}

/** Interleave original/translated pages without rasterizing either document. */
export async function interleaveReflowPdf(
	original: Uint8Array,
	translated: Uint8Array,
	timings?: ReflowWriteTimings,
): Promise<Uint8Array> {
	const pdf = await PDFDocument.load(translated),
		source = await PDFDocument.load(original);
	if (pdf.getPageCount() !== source.getPageCount())
		throw new Error("Bilingual PDF page counts differ");
	const pages = await copyOriginalPages(pdf, source);
	pages.forEach((page, index) => {
		pdf.insertPage(index * 2, page);
	});
	return savePdf(pdf, timings);
}

/** Replace changed pages while keeping the existing page references and order. */
export async function replaceReflowPages(
	previous: Uint8Array,
	replacement: Uint8Array,
	indexes: readonly number[],
	timings?: ReflowWriteTimings,
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
	// Reuse identical font streams and release resources from the replaced pages.
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
	return savePdf(pdf, timings);
}

async function savePdf(
	pdf: PDFDocument,
	timings?: ReflowWriteTimings,
): Promise<Uint8Array> {
	const started = performance.now();
	const bytes = await pdf.save();
	if (timings) timings.saveMs = performance.now() - started;
	return bytes;
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
