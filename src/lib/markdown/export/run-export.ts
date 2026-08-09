import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarkdownExportSurface } from "@/components/editor/markdown-export-surface";
import i18n from "@/i18n";
import { isTauri } from "@/lib/core/tauri";
import {
	applyPngWatermark,
	captureElementPng,
	dataUrlToUint8Array,
	pngDataUrlToPdfBytes,
} from "@/lib/markdown/export/capture";
import { waitForExportReady } from "@/lib/markdown/export/ready";
import type {
	MarkdownExportRequest,
	MarkdownExportResult,
} from "@/lib/markdown/export/types";
import { writeVaultBytes } from "@/lib/vault/fs";
import { WikiNavContext } from "@/lib/wiki/nav-context";

const EXPORT_WIDTH_PX = 800;

/**
 * Render the note offscreen, wait for embeds, capture PNG/PDF, open save dialog.
 * Returns `cancelled` when the user dismisses the dialog.
 */
export async function runMarkdownExport(
	request: MarkdownExportRequest,
): Promise<MarkdownExportResult> {
	if (!isTauri()) {
		throw new Error("export-desktop-only");
	}

	const host = document.createElement("div");
	host.setAttribute("data-markdown-export-host", "true");
	// Keep in-viewport (opacity 0) so lazy images still load; capture clones the
	// surface node (not the host), so host opacity does not blank the PNG.
	host.style.cssText = [
		"position:fixed",
		"left:0",
		"top:0",
		`width:${EXPORT_WIDTH_PX}px`,
		"max-width:100vw",
		"z-index:-9999",
		"opacity:0",
		"pointer-events:none",
		"overflow:visible",
	].join(";");
	document.body.appendChild(host);

	let root: Root | null = null;
	try {
		const surfaceRef: { current: HTMLElement | null } = { current: null };
		root = createRoot(host);
		// Separate React root: re-provide WikiNav so embeds can resolve vault paths.
		const wikiNavValue = {
			onWikiNavigate: () => {},
			vaultPath: request.vaultPath,
			mdFiles: request.mdFiles,
		};
		await new Promise<void>((resolve, reject) => {
			const timeout = window.setTimeout(
				() => reject(new Error("export-mount-timeout")),
				15_000,
			);
			root?.render(
				createElement(
					WikiNavContext.Provider,
					{ value: wikiNavValue },
					createElement(MarkdownExportSurface, {
						markdown: request.markdown,
						filePath: request.filePath,
						expandEmbeds: request.options.expandEmbeds,
						paperHeader: request.options.includePaperHeader
							? request.paperHeader
							: null,
						onMounted: (el: HTMLElement) => {
							surfaceRef.current = el;
							window.clearTimeout(timeout);
							resolve();
						},
					}),
				),
			);
		});

		const surface = surfaceRef.current;
		if (!surface) throw new Error("export-surface-missing");

		await waitForExportReady(surface);

		let pngDataUrl = await captureElementPng(surface);
		const format = request.options.format;
		const watermarkText = request.options.watermark
			? i18n.t("editor:export.watermark")
			: "";

		// Watermark is drawn after capture so PDF can stamp every page (not only
		// the last slice of a long raster that had a single DOM watermark).
		if (format === "png" && watermarkText) {
			pngDataUrl = await applyPngWatermark(pngDataUrl, watermarkText);
		}

		const bytes =
			format === "png"
				? dataUrlToUint8Array(pngDataUrl)
				: await pngDataUrlToPdfBytes(pngDataUrl, {
						watermarkText: watermarkText || undefined,
					});

		const ext = format === "png" ? "png" : "pdf";
		const filterName = format === "png" ? "PNG" : "PDF";
		const { save } = await import("@tauri-apps/plugin-dialog");
		const path = await save({
			defaultPath: `${request.defaultName}.${ext}`,
			filters: [{ name: filterName, extensions: [ext] }],
		});
		if (!path) return { status: "cancelled" };

		await writeVaultBytes(path, bytes);
		return { status: "saved", path, format };
	} finally {
		try {
			root?.unmount();
		} catch {
			// ignore unmount races
		}
		host.remove();
	}
}
