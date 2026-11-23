import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { logOp } from "@/lib/core/logger";
import type { ReflowFontBytes } from "./fonts";
import { withFormulaPdfEngine } from "./formula-engine";
import type { ReflowOutput } from "./pdf-write";
import { type Box, type ReflowDocument, unionBoxes } from "./types";
import { runReflowWorker } from "./write-client";

export type { ReflowOutput } from "./pdf-write";

export function layoutReflowPdf(
	ir: ReflowDocument,
	translations: ReadonlyMap<string, string>,
	fonts: ReflowFontBytes,
	signal?: AbortSignal,
) {
	return runReflowWorker(
		{ kind: "layout", ir, translations, commonScale: true },
		{ fonts, signal },
	);
}

export function interleaveReflowPdf(
	original: Uint8Array,
	translated: Uint8Array,
	signal?: AbortSignal,
) {
	return runReflowWorker(
		{ kind: "interleave", original, translated },
		{ signal },
	);
}

export function replaceReflowPages(
	previous: Uint8Array,
	replacement: Uint8Array,
	indexes: readonly number[],
	signal?: AbortSignal,
) {
	return runReflowWorker(
		{ kind: "replace", previous, replacement, indexes },
		{ signal },
	);
}

type ReportProgress = (
	ratio: number,
	pages?: { done: number; total: number },
) => void;

export async function buildReflowPdf(
	engine: PdfEngine,
	doc: PdfDocumentObject,
	ir: ReflowDocument,
	translations: ReadonlyMap<string, string>,
	fonts: Uint8Array | ReflowFontBytes,
	signal?: AbortSignal,
	commonScale = true,
	onProgress?: ReportProgress,
): Promise<ReflowOutput> {
	signal?.throwIfAborted();
	const prepared = await logOp(
		"pdf.reflow.prepareWrite",
		{ pages: ir.pages.length },
		() => prepareWrite(engine, doc, ir, translations, signal, onProgress),
	);
	return runReflowWorker(
		{ kind: "write", ...prepared, ir, translations, commonScale },
		{ fonts, signal, onProgress: (ratio) => onProgress?.(0.6 + 0.4 * ratio) },
	);
}

type FormulaFragment = {
	key: string;
	redactionBounds: Box;
};

async function collectFormulaPdfs(
	engine: PdfEngine,
	doc: PdfDocumentObject,
	ir: ReflowDocument,
	formulasByPage: ReadonlyArray<readonly FormulaFragment[]>,
	formulaCount: number,
	signal: AbortSignal | undefined,
	onProgress: ReportProgress | undefined,
): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
	return withFormulaPdfEngine(signal, async (formulaEngine, call, alive) => {
		const formulaPdfs = new Map<string, Uint8Array<ArrayBuffer>>();
		for (const [pageIndex, page] of ir.pages.entries()) {
			signal?.throwIfAborted();
			const formulas = formulasByPage[pageIndex];
			if (!formulas.length) continue;
			const singlePage = await engine
				.extractPages(doc, [page.index])
				.toPromise();
			for (const { key, redactionBounds } of formulas) {
				signal?.throwIfAborted();
				const fragment = await call(
					formulaEngine
						.openDocumentBuffer({
							id: `formula-${crypto.randomUUID()}`,
							content: singlePage.slice(0),
						})
						.toPromise(),
				);
				try {
					const pad = 0.75;
					const { x, y, w, h } = redactionBounds;
					const left = Math.max(0, x - pad);
					const top = Math.max(0, y - pad);
					const right = Math.min(page.width, x + w + pad);
					const bottom = Math.min(page.height, y + h + pad);
					const outside = [
						{ x: 0, y: 0, w: page.width, h: top },
						{ x: 0, y: bottom, w: page.width, h: page.height - bottom },
						{ x: 0, y: top, w: left, h: bottom - top },
						{ x: right, y: top, w: page.width - right, h: bottom - top },
					]
						.filter((rect) => rect.w > 0 && rect.h > 0)
						.map((rect) => ({
							origin: { x: rect.x, y: rect.y },
							size: { width: rect.w, height: rect.h },
						}));
					await call(
						formulaEngine
							.redactTextInRects(fragment, fragment.pages[0], outside, {
								recurseForms: true,
								drawBlackBoxes: false,
							})
							.toPromise(),
					);
					formulaPdfs.set(
						key,
						new Uint8Array(
							await call(formulaEngine.saveAsCopy(fragment).toPromise()),
						),
					);
				} finally {
					if (alive()) {
						await call(formulaEngine.closeDocument(fragment).toPromise());
					}
				}
				onProgress?.((0.4 * formulaPdfs.size) / Math.max(1, formulaCount));
			}
		}
		return formulaPdfs;
	});
}

async function prepareWrite(
	engine: PdfEngine,
	doc: PdfDocumentObject,
	ir: ReflowDocument,
	translations: ReadonlyMap<string, string>,
	signal?: AbortSignal,
	onProgress?: ReportProgress,
) {
	const original = await engine.saveAsCopy(doc).toPromise();
	const formulasByPage = ir.pages.map((page) =>
		page.paragraphs
			.filter((paragraph) => translations.has(paragraph.id))
			.flatMap((paragraph) => {
				if (!paragraph.formulas.length) return [];
				const glyphBoxes = new Map(
					paragraph.characters.map((character) => [
						character.index,
						character.box,
					]),
				);
				return paragraph.formulas.map((formula) => {
					const { y, h } = unionBoxes([
						formula.box,
						...formula.characterIndexes.flatMap(
							(index) => glyphBoxes.get(index) ?? [],
						),
					]);
					return {
						key: `${paragraph.id}:${formula.id}`,
						redactionBounds: { ...formula.box, y, h },
					};
				});
			}),
	);
	const formulaCount = formulasByPage.reduce(
		(count, formulas) => count + formulas.length,
		0,
	);
	const formulaPdfs =
		formulaCount === 0
			? new Map<string, Uint8Array<ArrayBuffer>>()
			: await collectFormulaPdfs(
					engine,
					doc,
					ir,
					formulasByPage,
					formulaCount,
					signal,
					onProgress,
				);
	onProgress?.(0.4);
	signal?.throwIfAborted();
	const clone = await engine
		.openDocumentBuffer({
			id: `reflow-${crypto.randomUUID()}`,
			content: original,
		})
		.toPromise();
	try {
		for (const [pageIndex, page] of ir.pages.entries()) {
			signal?.throwIfAborted();
			const rects = page.paragraphs
				.filter((paragraph) => translations.has(paragraph.id))
				.map(({ box }) => ({
					origin: { x: box.x, y: box.y },
					size: { width: box.w, height: box.h },
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
		return { redacted, formulaPdfs };
	} finally {
		await engine.closeDocument(clone).toPromise();
	}
}

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
		.openDocumentBuffer({ id: `reflow-page-${crypto.randomUUID()}`, content })
		.toPromise();
	const singleIr = {
		version: ir.version,
		pages: [
			{
				...page,
				index: 0,
				paragraphs: page.paragraphs.map((paragraph) => ({
					...paragraph,
					pageIndex: 0,
				})),
			},
		],
	};
	let prepared: Awaited<ReturnType<typeof prepareWrite>>;
	try {
		prepared = await logOp("pdf.reflow.prepareWrite", { pages: 1 }, () =>
			prepareWrite(engine, single, singleIr, translations, signal),
		);
	} finally {
		await engine.closeDocument(single).toPromise();
	}
	const result = await runReflowWorker(
		{
			kind: "write",
			...prepared,
			ir: singleIr,
			translations,
			commonScale: false,
		},
		{ fonts, signal },
	);
	return {
		bytes: result.bytes,
		pages: result.pages.map((layout) => ({
			...layout,
			index: page.index,
			paragraphs: layout.paragraphs.map((paragraph) => ({
				...paragraph,
				pageIndex: page.index,
			})),
		})),
	};
}
