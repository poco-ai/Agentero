/**
 * Remote PP-StructureV3 layout provider (AI Studio async OCR job).
 *
 * The whole PDF is uploaded once as a job (`POST {base}/api/v2/ocr/jobs`),
 * the Host polls until done, and per-page pixel boxes come back in one
 * result. The service renders pages itself, so the rendered size comes from
 * the response (with a 200 DPI fallback for the point conversion).
 */

import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { clamp01 } from "@/lib/core/math";
import { layoutLabelToKind } from "@/lib/pdf/layout/labels";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

export type LayoutRemoteBox = {
	clsId: number;
	label: string;
	score: number;
	text?: string | null;
	caption?: string | null;
	/** `[x1, y1, x2, y2]` in rendered-image pixels (top-left origin). */
	coordinate: [number, number, number, number];
};

export type LayoutRemotePageResult = {
	boxes: LayoutRemoteBox[];
	/** Rendered page image size in px when the service reported it. */
	widthPx: number | null;
	heightPx: number | null;
};

export type LayoutRemoteAnalyzePdfResult = {
	pages: LayoutRemotePageResult[];
};

/** Match the local PP-DocLayoutV3 plugin threshold. */
export const PADDLE_LAYOUT_MIN_SCORE = 0.3;

/**
 * The AI Studio service renders PDF pages at 144 DPI (2x); verified against a
 * known-size PDF via `dataInfo.pages`. Used only when the response reports no
 * rendered size — the normalized bbox stays exact either way, only the point
 * `rect` (text-run enrichment) may drift slightly.
 */
export const PADDLE_ASSUMED_RENDER_DPI = 144;

export async function invokeLayoutRemoteAnalyzePdf(args: {
	provider: string;
	pdfBase64: string;
	fileName?: string;
	apiKey?: string;
	requestId?: string;
}): Promise<LayoutRemoteAnalyzePdfResult> {
	// Wire boxes keep serde `null` on absent score/coordinate numbers and add
	// `renderedPages`; the converters below treat null like the old payload.
	return (await callApi(() =>
		commands.layoutRemoteAnalyzePdf({
			provider: args.provider,
			pdfBase64: args.pdfBase64,
			fileName: args.fileName ?? null,
			apiKey: args.apiKey ?? null,
			requestId: args.requestId ?? null,
		}),
	)) as LayoutRemoteAnalyzePdfResult;
}

/** Stop waiting for one whole-PDF layout job after the caller aborts it. */
export async function invokeLayoutRemoteCancel(
	requestId: string,
): Promise<boolean> {
	return callApi(() => commands.layoutRemoteCancel(requestId));
}

/**
 * Connectivity probe through the Host (no WebView CORS, honors the app
 * proxy): submits a tiny OCR job; a returned jobId means endpoint + token
 * are valid. A masked/omitted key is resolved from settings by the Host.
 */
export async function invokeLayoutRemoteProbe(args: {
	provider: string;
	imageBase64: string;
	apiKey?: string;
}): Promise<{ jobId: string }> {
	return callApi(() =>
		commands.layoutRemoteProbe({
			provider: args.provider,
			imageBase64: args.imageBase64,
			apiKey: args.apiKey ?? null,
		}),
	);
}

/** Tiny white JPEG for the settings connectivity probe. */
export function tinyProbeJpegBase64(): string | null {
	if (typeof document === "undefined") return null;
	const canvas = document.createElement("canvas");
	canvas.width = 8;
	canvas.height = 8;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, 8, 8);
	const url = canvas.toDataURL("image/jpeg", 0.8);
	const base64 = url.split(",")[1];
	return base64 || null;
}

/**
 * Convert one page of PP-StructureV3 boxes into raw layout regions.
 * `pageWidth` / `pageHeight` are PDF points; boxes are in rendered pixels.
 */
export function paddleBoxesToRegions(args: {
	boxes: readonly LayoutRemoteBox[];
	pageIndex: number;
	pageWidth: number;
	pageHeight: number;
	widthPx: number;
	heightPx: number;
	idPrefix: string;
}): PdfLayoutRegion[] {
	const { boxes, pageIndex, pageWidth, pageHeight, widthPx, heightPx } = args;
	if (pageWidth <= 0 || pageHeight <= 0 || widthPx <= 0 || heightPx <= 0) {
		return [];
	}
	const scaleX = pageWidth / widthPx;
	const scaleY = pageHeight / heightPx;
	const regions: PdfLayoutRegion[] = [];
	for (const box of boxes) {
		const kind = layoutLabelToKind(box.label);
		if (!kind) continue;
		if (!(box.score >= PADDLE_LAYOUT_MIN_SCORE)) continue;
		const [x1, y1, x2, y2] = box.coordinate;
		const left = Math.min(x1, x2);
		const top = Math.min(y1, y2);
		const w = Math.abs(x2 - x1);
		const h = Math.abs(y2 - y1);
		if (!(w > 0 && h > 0)) continue;
		const x = left * scaleX;
		const y = top * scaleY;
		regions.push({
			id: `${args.idPrefix}-${pageIndex}-${regions.length}`,
			pageIndex,
			kind,
			label: box.label,
			score: clamp01(box.score),
			...(box.text?.trim() ? { text: box.text.trim() } : {}),
			...(box.caption?.trim() || (kind === "figure_title" && box.text?.trim())
				? { title: (box.caption || box.text)?.trim() }
				: {}),
			// Assigned after the whole page set is collected (top-to-bottom).
			readingOrder: regions.length,
			rect: { x, y, w: w * scaleX, h: h * scaleY },
			bbox: {
				x: clamp01(x / pageWidth),
				y: clamp01(y / pageHeight),
				w: clamp01((w * scaleX) / pageWidth),
				h: clamp01((h * scaleY) / pageHeight),
			},
		});
	}
	// PP-StructureV3 box order is score-desc; approximate reading order by
	// vertical position (column-aware ordering is out of scope here).
	regions.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
	regions.forEach((r, i) => {
		r.readingOrder = i;
	});
	return regions;
}

/**
 * Convert one job-result page into raw layout regions. When the rendered
 * size is unknown, assume {@link PADDLE_ASSUMED_RENDER_DPI}.
 */
export function paddlePageToRegions(args: {
	page: LayoutRemotePageResult;
	pageIndex: number;
	pageWidth: number;
	pageHeight: number;
	idPrefix: string;
}): PdfLayoutRegion[] {
	const { page, pageIndex, pageWidth, pageHeight } = args;
	const widthPx =
		page.widthPx && page.widthPx > 0
			? page.widthPx
			: (pageWidth * PADDLE_ASSUMED_RENDER_DPI) / 72;
	const heightPx =
		page.heightPx && page.heightPx > 0
			? page.heightPx
			: (pageHeight * PADDLE_ASSUMED_RENDER_DPI) / 72;
	return paddleBoxesToRegions({
		boxes: page.boxes,
		pageIndex,
		pageWidth,
		pageHeight,
		widthPx,
		heightPx,
		idPrefix: args.idPrefix,
	});
}
