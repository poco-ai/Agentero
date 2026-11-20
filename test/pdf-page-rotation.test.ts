/**
 * Pins the rotation contract the viewer's layer wiring depends on.
 *
 * EmbedPDF's Document Manager always opens documents with
 * `normalizeRotation: true`. Under that mode PDFium reports the page size in
 * the *unrotated* content space and keeps `/Rotate` in `page.rotation` — the
 * caller must add both (`(page.rotation + coreDoc.rotation) % 4`) for layout,
 * tiles and raster. Assuming the size already includes `/Rotate` renders
 * those pages portrait with sideways tables.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { init } from "@embedpdf/pdfium";
import { beforeAll, describe, expect, it } from "vitest";

function taskToPromise<T>(task: {
	wait: (ok: (v: T) => void, err: (e: unknown) => void) => void;
}): Promise<T> {
	return new Promise((resolve, reject) => {
		task.wait(resolve, reject);
	});
}

function fixtureBuffer(): ArrayBuffer {
	const raw = readFileSync(
		fileURLToPath(new URL("./fixtures/rotate90.pdf", import.meta.url)),
	);
	return raw.buffer.slice(
		raw.byteOffset,
		raw.byteOffset + raw.byteLength,
	) as ArrayBuffer;
}

describe("pdfium normalizeRotation contract", () => {
	let pdf: PdfiumNative;

	beforeAll(async () => {
		pdf = new PdfiumNative(
			await init({
				wasmBinary: readFileSync(
					fileURLToPath(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")),
				),
			}),
			{ fontFallback: null },
		);
	});

	it("normalized mode reports unrotated size and keeps /Rotate metadata", async () => {
		const doc = await taskToPromise(
			pdf.openDocumentBuffer(
				{ id: "rotate90-normalized", content: fixtureBuffer() },
				{ normalizeRotation: true },
			),
		);
		const page = doc.pages[0];
		// Content-space size (MediaBox), NOT the landscape display size.
		expect(page.size).toEqual({ width: 200, height: 300 });
		expect(page.rotation).toBe(1);

		// Upright display only when the caller re-applies page.rotation.
		const upright = await taskToPromise(
			pdf.renderPageRaw(doc, page, { scaleFactor: 1, dpr: 1, rotation: 1 }),
		);
		expect([upright.width, upright.height]).toEqual([300, 200]);

		// Rotation 0 renders the raw content space: portrait, sideways content.
		const flat = await taskToPromise(
			pdf.renderPageRaw(doc, page, { scaleFactor: 1, dpr: 1, rotation: 0 }),
		);
		expect([flat.width, flat.height]).toEqual([200, 300]);
	});

	it("raw mode reports the display size including /Rotate", async () => {
		const doc = await taskToPromise(
			pdf.openDocumentBuffer(
				{ id: "rotate90-raw", content: fixtureBuffer() },
				{ normalizeRotation: false },
			),
		);
		expect(doc.pages[0].size).toEqual({ width: 300, height: 200 });
	});
});
