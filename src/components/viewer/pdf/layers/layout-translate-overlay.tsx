/**
 * Progressive translation overlays for layout body-text regions.
 * Full bbox stays covered (hides source PDF text); font size tracks paper
 * body size, then re-fits so the translation fills the block without huge gaps.
 */

import { memo } from "react";
import { cn } from "@/lib/core/utils";
import { isLayoutTranslateHeadingKind } from "@/lib/pdf/layout/labels";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/layout-translate";
import { PDF_PAGE_RASTER_DARK_CLASS } from "@/lib/pdf/page-theme";

type LayoutTranslateOverlayProps = {
	/** Items already bucketed for this one page (groupLayoutTranslateItemsByPage). */
	items: readonly LayoutTranslateItem[];
	/** Page pixel size (for font-size heuristic). */
	pageWidthPx: number;
	pageHeightPx: number;
	/** Match PDF page theme (not app chrome). */
	pdfDark?: boolean;
};

const LINE_HEIGHT = 1.25;
const FS_MIN = 7;
const FS_MAX = 20;

/** Wider glyphs for CJK; narrower for Latin (academic body). */
function avgGlyphEm(text: string): number {
	const t = text.replace(/\s+/g, "");
	if (!t.length) return 0.55;
	const cjk = (t.match(/[\u3000-\u9fff\u3400-\u4dbf]/g) ?? []).length;
	const ratio = cjk / t.length;
	return 0.5 * (1 - ratio) + 0.92 * ratio;
}

function estimateLineCount(
	text: string,
	widthPx: number,
	fontSize: number,
	glyphEm: number,
): number {
	const explicit = text.split(/\n/).filter(Boolean);
	if (explicit.length > 1) {
		let lines = 0;
		const cpl = Math.max(1, Math.floor(widthPx / (fontSize * glyphEm)));
		for (const part of explicit) {
			lines += Math.max(1, Math.ceil(part.replace(/\s+/g, "").length / cpl));
		}
		return Math.max(1, lines);
	}
	const chars = Math.max(1, text.replace(/\s+/g, "").length);
	const cpl = Math.max(1, Math.floor(widthPx / (fontSize * glyphEm)));
	return Math.max(1, Math.ceil(chars / cpl));
}

function estimateBlockHeight(
	text: string,
	widthPx: number,
	fontSize: number,
	glyphEm: number,
): number {
	const lines = estimateLineCount(text, widthPx, fontSize, glyphEm);
	return lines * fontSize * LINE_HEIGHT;
}

/**
 * Largest font size such that wrapped `text` still fits in (widthPx × heightPx).
 */
function fitFontSizeToBox(
	text: string,
	widthPx: number,
	heightPx: number,
	glyphEm: number,
): number {
	const content = text.replace(/\s+/g, " ").trim() || "…";
	let lo = FS_MIN;
	let hi = FS_MAX;
	// 12 iterations → sub-pixel precision for UI.
	for (let i = 0; i < 12; i++) {
		const mid = (lo + hi) / 2;
		const h = estimateBlockHeight(content, widthPx, mid, glyphEm);
		if (h <= heightPx) lo = mid;
		else hi = mid;
	}
	return lo;
}

/**
 * Paper-like size from the English/source block, then adjust for the
 * translation so CN denser text does not leave a half-empty white slab.
 */
export function fontSizeForLayoutTranslateBox(
	bbox: LayoutTranslateItem["bbox"],
	pageWidthPx: number,
	pageHeightPx: number,
	source: string,
	translated?: string,
): number {
	const padX = 4;
	const padY = 3;
	const w = Math.max(1, bbox.w * pageWidthPx - padX);
	const h = Math.max(1, bbox.h * pageHeightPx - padY);
	const src = source.replace(/\s+/g, " ").trim() || "x";
	const display = translated?.replace(/\s+/g, " ").trim() || src || "…";

	const srcEm = avgGlyphEm(src);
	const dispEm = avgGlyphEm(display);

	// 1) Size the original paper body would use in this bbox.
	const paperFs = fitFontSizeToBox(src, w, h, srcEm);

	// 2) Largest size that still fits the translation in the same box.
	const fitFs = fitFontSizeToBox(display, w, h, dispEm);

	// 3) Prefer paper-like; shrink if translation would overflow; allow modest
	//    grow when translation is denser (CN) so the block is not half blank.
	let fs = paperFs;
	if (fitFs < paperFs * 0.98) {
		// Translation longer / wider glyphs → must shrink.
		fs = fitFs;
	} else if (fitFs > paperFs * 1.05) {
		// Room to grow: fill up toward ~90% of the max fit, capped at 1.22× paper.
		fs = Math.min(fitFs * 0.9, paperFs * 1.22);
	}

	// Tiny header strips: use most of the strip height.
	const srcLines = estimateLineCount(src, w, Math.max(paperFs, 8), srcEm);
	if (srcLines === 1 && src.length < 100 && h < 40) {
		fs = Math.min(fitFs, Math.max(fs, h * 0.7));
	}

	return Math.max(FS_MIN, Math.min(FS_MAX, fs));
}

/**
 * Fit-result cache. Streaming job updates repaint every mounted page, but the
 * fitted size only depends on (item, box pixel size, source, text), so
 * unchanged blocks reuse their last result instead of re-running the
 * binary-search fit on every render. Inner maps use raw strings as keys
 * (value equality), so cache hits build no large key strings. Bounded:
 * oldest item entries are evicted first; per-item maps hold only the few
 * text variants a block goes through (placeholder → final).
 */
const FONT_SIZE_CACHE_MAX_ITEMS = 1024;
const FONT_SIZE_CACHE_MAX_SOURCES = 8;
const FONT_SIZE_CACHE_MAX_TEXTS = 32;

type FontSizeCacheEntry = {
	boxWidthPx: number;
	boxHeightPx: number;
	bySource: Map<string, Map<string, number>>;
};

const fontSizeCache = new Map<string, FontSizeCacheEntry>();

function fontSizeForLayoutTranslateItem(
	item: LayoutTranslateItem,
	pageWidthPx: number,
	pageHeightPx: number,
	text: string,
): number {
	const boxWidthPx = item.bbox.w * pageWidthPx;
	const boxHeightPx = item.bbox.h * pageHeightPx;
	let entry = fontSizeCache.get(item.id);
	if (!entry) {
		if (fontSizeCache.size >= FONT_SIZE_CACHE_MAX_ITEMS) {
			const oldest = fontSizeCache.keys().next().value;
			if (oldest !== undefined) fontSizeCache.delete(oldest);
		}
		entry = { boxWidthPx, boxHeightPx, bySource: new Map() };
		fontSizeCache.set(item.id, entry);
	} else if (
		entry.boxWidthPx !== boxWidthPx ||
		entry.boxHeightPx !== boxHeightPx
	) {
		// Zoom or region geometry changed: cached sizes no longer apply.
		entry.boxWidthPx = boxWidthPx;
		entry.boxHeightPx = boxHeightPx;
		entry.bySource.clear();
	}
	let byText = entry.bySource.get(item.source);
	if (!byText) {
		if (entry.bySource.size >= FONT_SIZE_CACHE_MAX_SOURCES) {
			entry.bySource.clear();
		}
		byText = new Map();
		entry.bySource.set(item.source, byText);
	}
	const hit = byText.get(text);
	if (hit !== undefined) return hit;
	const fontSize = fontSizeForLayoutTranslateBox(
		item.bbox,
		pageWidthPx,
		pageHeightPx,
		item.source,
		text,
	);
	if (byText.size >= FONT_SIZE_CACHE_MAX_TEXTS) byText.clear();
	byText.set(text, fontSize);
	return fontSize;
}

/**
 * Paint translated (or in-flight) blocks for one PDF page.
 */
export const LayoutTranslateOverlay = memo(function LayoutTranslateOverlay({
	items,
	pageWidthPx,
	pageHeightPx,
	pdfDark = false,
}: LayoutTranslateOverlayProps) {
	const onPage = items.filter(
		(it) =>
			it.status === "done" ||
			it.status === "running" ||
			(it.status === "error" && it.translated),
	);
	if (onPage.length === 0) return null;

	return (
		<>
			{onPage.map((item) => {
				const text =
					item.status === "running"
						? (item.translated ?? "…")
						: (item.translated ?? "");
				const isHeading = isLayoutTranslateHeadingKind(item.kind);
				const fontSize = fontSizeForLayoutTranslateItem(
					item,
					pageWidthPx,
					pageHeightPx,
					text,
				);
				return (
					<div
						key={`layout-tr-${item.id}`}
						className={cn(
							"pointer-events-none absolute z-[3] overflow-hidden rounded-[1px]",
							// Always paint as light paper; in PDF dark mode apply the same
							// invert as page rasters so cover blocks match inverted paper.
							"bg-white text-zinc-900",
							pdfDark && PDF_PAGE_RASTER_DARK_CLASS,
							item.status === "running" && "opacity-90",
						)}
						style={{
							left: `${item.bbox.x * 100}%`,
							top: `${item.bbox.y * 100}%`,
							width: `${item.bbox.w * 100}%`,
							height: `${item.bbox.h * 100}%`,
							padding: "1px 2px",
							fontSize,
							lineHeight: LINE_HEIGHT,
							// Serif stack closer to paper body than UI sans.
							fontFamily:
								'ui-serif, "Times New Roman", Times, "Noto Serif SC", "Songti SC", "Source Han Serif SC", serif',
							// Titles / section headers: bold; body justified.
							fontWeight: isHeading ? 700 : 400,
							textAlign: isHeading ? "left" : "justify",
						}}
						aria-hidden="true"
					>
						<p
							className={cn(
								"m-0 h-full w-full overflow-hidden break-words whitespace-pre-wrap",
								isHeading && "font-bold",
							)}
						>
							{text}
						</p>
					</div>
				);
			})}
		</>
	);
});
