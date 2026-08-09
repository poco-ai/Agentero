import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarkdownExportSurface } from "@/components/editor/markdown-export-surface";
import i18n from "@/i18n";
import { invokeApi } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";
import {
	applyPngWatermark,
	captureElementPng,
	dataUrlToUint8Array,
	resolveMutedForegroundRgb,
} from "@/lib/markdown/export/capture";
import { waitForExportReady } from "@/lib/markdown/export/ready";
import { buildSearchablePdf } from "@/lib/markdown/export/searchable-pdf";
import { collectExportTextLayer } from "@/lib/markdown/export/text-layer";
import type {
	MarkdownExportRequest,
	MarkdownExportResult,
} from "@/lib/markdown/export/types";
import { writeVaultBytes } from "@/lib/vault/fs";
import { WikiNavContext } from "@/lib/wiki/nav-context";

const EXPORT_WIDTH_PX = 800;

async function loadSystemCjkFontBytes(): Promise<Uint8Array | null> {
	try {
		const payload = await invokeApi<{ path: string; bytesBase64: string }>(
			"export_system_cjk_font",
			undefined,
			{ fallback: "export_system_cjk_font failed" },
		);
		if (!payload?.bytesBase64) return null;
		const binary = atob(payload.bytesBase64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	} catch {
		// Fall back to Helvetica (Latin only) inside the PDF builder.
		return null;
	}
}

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

		// Geometry for text/links must match the painted surface used for capture.
		const textLayer = collectExportTextLayer(surface);
		let pngDataUrl = await captureElementPng(surface);
		const format = request.options.format;
		const watermarkText = request.options.watermark
			? i18n.t("editor:export.watermark")
			: "";

		if (format === "png" && watermarkText) {
			pngDataUrl = await applyPngWatermark(pngDataUrl, watermarkText);
		}

		const bytes =
			format === "png"
				? dataUrlToUint8Array(pngDataUrl)
				: await buildSearchablePdf({
						pngDataUrl,
						textLayer,
						watermarkText: watermarkText || undefined,
						fontBytes: await loadSystemCjkFontBytes(),
						mutedRgb: resolveMutedForegroundRgb(),
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
