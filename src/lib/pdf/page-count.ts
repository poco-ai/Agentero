/**
 * Get PDF page count without full layout analysis.
 * Uses headless @embedpdf stack to read page count on demand.
 */

import { PluginRegistry } from "@embedpdf/core";
import type { DocumentManagerCapability } from "@embedpdf/plugin-document-manager";
import { DocumentManagerPluginPackage } from "@embedpdf/plugin-document-manager";
import { RenderPluginPackage } from "@embedpdf/plugin-render";
import { nanoid } from "nanoid";

import { findLocalPdfPath, localFileToArrayBuffer } from "@/lib/paper";
import { acquireBackgroundPdfEngine } from "@/lib/pdf/background-engine";

/**
 * Get PDF page count for a paper folder.
 * Returns null if no PDF found or failed to read.
 */
export async function getPdfPageCount(
	paperAbsPath: string,
): Promise<number | null> {
	try {
		const pdfPath = await findLocalPdfPath(paperAbsPath);
		if (!pdfPath) return null;

		const buffer = await localFileToArrayBuffer(pdfPath);
		if (!buffer) return null;

		const { engine, release } = await acquireBackgroundPdfEngine();
		const documentId = `page-count-${nanoid()}`;
		const registry = new PluginRegistry(engine);
		let docCap: DocumentManagerCapability | null = null;
		try {
			registry.registerPlugin(DocumentManagerPluginPackage, {});
			registry.registerPlugin(RenderPluginPackage);

			await registry.initialize();
			await registry.pluginsReady();

			const docPlugin = registry.getPlugin("document-manager");
			if (!docPlugin) return null;

			docCap = (
				docPlugin as unknown as { provides: () => DocumentManagerCapability }
			).provides();

			const openRes = await docCap
				.openDocumentBuffer({
					buffer,
					documentId,
					name: "page-count",
					autoActivate: true,
				})
				.toPromise();
			const doc = await openRes.task.toPromise();
			const pageCount = doc.pageCount ?? 0;

			return pageCount > 0 ? pageCount : null;
		} finally {
			// Release this probe's document, never the shared headless engine.
			try {
				if (docCap) await docCap.closeDocument(documentId).toPromise();
			} catch {
				// Registry teardown retries closing documents still in its store.
			}
			try {
				await registry.destroy();
			} catch {
				// Cleanup must not replace a page count or the null failure result.
			}
			release();
		}
	} catch {
		return null;
	}
}
