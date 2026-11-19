import type { ReflowFontBytes } from "./fonts";
import type { ReflowOutput, ReflowWriteTimings } from "./pdf-write";
import type { PageLayout, ReflowDocument } from "./types";

export type WriteFonts = ReflowFontBytes | Uint8Array;
type LayoutInput = {
	ir: ReflowDocument;
	translations: ReadonlyMap<string, string>;
	commonScale: boolean;
};

export type WriteJob =
	| ({
			kind: "write";
			redacted: Uint8Array<ArrayBuffer>;
			formulaPdfs: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
	  } & LayoutInput)
	| ({ kind: "layout" } & LayoutInput)
	| {
			kind: "replace";
			previous: Uint8Array;
			replacement: Uint8Array;
			indexes: readonly number[];
	  }
	| { kind: "interleave"; original: Uint8Array; translated: Uint8Array };

export type WriteResults = {
	write: ReflowOutput;
	layout: PageLayout[];
	replace: Uint8Array;
	interleave: Uint8Array;
};

export type WriteRequest = { job: WriteJob; fonts?: WriteFonts };
export type WriteResponse =
	| { progress: number }
	| { error: string }
	| { value: WriteResults[keyof WriteResults]; timings: ReflowWriteTimings };

export async function executeWriteJob(
	job: WriteJob,
	fonts: WriteFonts | undefined,
	timings: ReflowWriteTimings,
	onProgress?: (ratio: number) => void,
): Promise<WriteResults[keyof WriteResults]> {
	const pdf = await import("./pdf-write");
	switch (job.kind) {
		case "write":
			if (!fonts) throw new Error("Reflow worker fonts not loaded");
			return pdf.writeReflowPdf(
				job.redacted,
				job.ir,
				job.translations,
				fonts,
				job.formulaPdfs,
				job.commonScale,
				onProgress,
				timings,
			);
		case "layout": {
			if (!fonts) throw new Error("Reflow worker fonts not loaded");
			const started = performance.now();
			const pages = await pdf.layoutReflowPdf(
				job.ir,
				job.translations,
				fonts,
				job.commonScale,
			);
			timings.layoutMs = performance.now() - started;
			return pages;
		}
		case "replace":
			return pdf.replaceReflowPages(
				job.previous,
				job.replacement,
				job.indexes,
				timings,
			);
		case "interleave":
			return pdf.interleaveReflowPdf(job.original, job.translated, timings);
	}
}
