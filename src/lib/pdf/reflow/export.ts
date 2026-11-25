import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { logOp } from "@/lib/core/logger";
import type { ReflowFontBytes } from "./fonts";
import { type FormulaCall, withFormulaPdfEngine } from "./formula-engine";
import type { ReflowOutput } from "./pdf-write";
import type { ReflowDocument } from "./types";
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

async function prepareWrite(
	engine: PdfEngine,
	doc: PdfDocumentObject,
	ir: ReflowDocument,
	translations: ReadonlyMap<string, string>,
	signal?: AbortSignal,
	onProgress?: ReportProgress,
) {
	const original = await engine.saveAsCopy(doc).toPromise();
	const hasFormulas = ir.pages.some((page) =>
		page.paragraphs.some(
			(paragraph) =>
				translations.has(paragraph.id) && paragraph.formulas.length,
		),
	);
	const redact = async (
		redactionEngine: PdfEngine,
		call: FormulaCall,
		alive: () => boolean,
	) => {
		signal?.throwIfAborted();
		const clone = await call(
			redactionEngine
				.openDocumentBuffer({
					id: `reflow-${crypto.randomUUID()}`,
					content: original,
				})
				.toPromise(),
		);
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
					await call(
						redactionEngine
							.redactTextInRects(clone, clone.pages[page.index], rects, {
								recurseForms: true,
								drawBlackBoxes: false,
							})
							.toPromise(),
					);
				onProgress?.(0.6 * ((pageIndex + 1) / ir.pages.length), {
					done: pageIndex + 1,
					total: ir.pages.length,
				});
			}
			return new Uint8Array(
				await call(redactionEngine.saveAsCopy(clone).toPromise()),
			);
		} finally {
			if (alive()) await call(redactionEngine.closeDocument(clone).toPromise());
		}
	};
	const redacted = hasFormulas
		? await withFormulaPdfEngine(signal, redact)
		: await redact(
				engine,
				(operation) => operation,
				() => true,
			);
	return {
		redacted,
		formulaSource: hasFormulas ? new Uint8Array(original) : undefined,
	};
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
