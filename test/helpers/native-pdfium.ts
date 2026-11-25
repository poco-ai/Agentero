import { readFileSync } from "node:fs";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { init } from "@embedpdf/pdfium";

export async function createNativePdfium() {
	return new PdfiumNative(
		await init({
			wasmBinary: readFileSync(
				new URL(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")),
			),
		}),
		{ fontFallback: null },
	);
}
