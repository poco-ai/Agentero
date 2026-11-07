import { ReflowPageOverlay } from "./reflow-page-overlay";
/**
 * Progressive translation overlays for layout body-text regions.
 * Full bbox stays covered (hides source PDF text); font size tracks paper
 * body size, then re-fits so the translation fills the block without huge gaps.
 */

import { Fragment, memo, useLayoutEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/core/utils";
import { highlightFill } from "@/lib/pdf/highlight/palette";
import {
	sentenceHighlightTints,
	type TranslateSentenceTint,
} from "@/lib/pdf/highlight/sentence-tint";
import type { HighlightQuoteTint } from "@/lib/pdf/highlight/translated-geometry";
import type { PdfHighlightRect } from "@/lib/pdf/highlight/types";
import { isLayoutTranslateHeadingKind } from "@/lib/pdf/layout/labels";
import { layoutTranslateSentenceNodes } from "@/lib/pdf/layout/layout-sentences";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/layout-translate";
import {
	fitLayoutTranslateParagraph,
	layoutTranslateDomFitKey,
	readLayoutTranslateDomFit,
	scheduleLayoutTranslateDomFit,
	writeLayoutTranslateDomFit,
} from "@/lib/pdf/layout/layout-translate-dom-fit";
import { isLayoutTranslateItemPainted } from "@/lib/pdf/layout/layout-translate-reliable";
import { linkColorOnPaper } from "@/lib/pdf/layout/link-ink";
import type { LayoutSourceStyle } from "@/lib/pdf/layout/source-style";
import {
	assignmentsWithin,
	assignPreservedLinks,
	claimTranslateLinks,
	type GlyphRun,
	type PreservedLinkAssignment,
	type TranslateLinkBox,
} from "@/lib/pdf/layout/translated-links";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";
import {
	beginLinkPreviewDrag,
	linkHoverSuppressed,
	linkPreviewDragActive,
} from "@/lib/pdf/link-preview-drag";
import {
	PDF_PAGE_RASTER_DARK_CLASS,
	PDF_PAPER_BLOCK_CLASS,
	type PdfPaperTone,
} from "@/lib/pdf/page-theme";

type LayoutTranslateOverlayProps = {
	/** Items already bucketed for this one page (groupLayoutTranslateItemsByPage). */
	items: readonly LayoutTranslateItem[];
	/** 0-based page index in the translated PDF (same order as the source). */
	pageIndex: number;
	/** Finished translated PDF document id for the shared render path. */
	reflowDocumentId?: string | null;
	/** Current viewer zoom, forwarded to the shared render layer. */
	zoom: number;
	/** Page pixel size (for font-size heuristic). */
	pageWidthPx: number;
	pageHeightPx: number;
	/** Match PDF page paper (not app chrome). */
	tone?: PdfPaperTone;
	/** Raw page regions; used as collision blockers for safe overlay expansion. */
	layoutRegions?: readonly PdfLayoutRegion[];
	/**
	 * English highlights on this page that have no translated boxes. A sentence
	 * is filled when its English glyph boxes overlap the highlight. Nothing is
	 * written back.
	 */
	highlightQuotes?: readonly HighlightQuoteTint[];
	/** English glyph boxes per sentence, keyed by layout item id. */
	sentenceRectsByItemId?: ReadonlyMap<
		string,
		readonly (readonly PdfHighlightRect[])[]
	>;
	/**
	 * Page link annotations and bare URLs, in normalized page fractions.
	 * Preserved citation / ref / URL tokens inside a block become the hit
	 * targets so the English rectangles can stay under the glyphs.
	 */
	links?: readonly TranslateLinkBox[];
	/** Source text runs for this page. Keeps grouped citations on their own glyphs. */
	glyphRuns?: readonly GlyphRun[];
	onOpenLink?: (assignment: PreservedLinkAssignment) => void;
	onHoverLink?: (
		assignment: PreservedLinkAssignment | null,
		point: { x: number; y: number; top: number; bottom: number } | null,
	) => void;
};

const LINE_HEIGHT = 1.25;
/**
 * Heuristic floor. A DOM-measured second pass below may go lower only when the
 * real browser metrics prove the text would otherwise be clipped.
 */
const FS_MIN = 4;
const FS_MAX = 20;
const FIT_SAFETY = 0.97;
/** One-line heading box height → font size (box ≈ ascender..descender). */
const HEADING_EM_PER_BOX = 0.9;
/** Section titles should outrank body text on the same page. */
export const HEADING_TO_BODY_SIZE_RATIO = 1.35;

/**
 * Median of body block sizes on a page. Empty when the page has no painted
 * body blocks yet (still translating / title-only).
 */
export function bodyReferenceFontSize(
	sizes: readonly number[],
): number | undefined {
	const usable = sizes
		.filter((n) => Number.isFinite(n) && n > FS_MIN)
		.sort((a, b) => a - b);
	if (usable.length === 0) return undefined;
	// Prefer the upper quartile so short/dense outliers do not drag section
	// titles back toward body size.
	const idx = Math.min(usable.length - 1, Math.ceil(usable.length * 0.75) - 1);
	return usable[Math.max(0, idx)];
}

/** Raise a heading to at least `bodyRef × HEADING_TO_BODY_SIZE_RATIO`. */
export function applyHeadingBodyFloor(
	headingFs: number,
	bodyRefPx: number | undefined,
): number {
	if (bodyRefPx === undefined || bodyRefPx <= 0) return headingFs;
	return Math.min(
		FS_MAX,
		Math.max(headingFs, bodyRefPx * HEADING_TO_BODY_SIZE_RATIO),
	);
}

const OVERLAY_PAGE_RIGHT = 0.97;
const OVERLAY_GUTTER = 0.006;

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number) {
	return Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > 0;
}

/** Source heading size the overlay should keep while the box grows. */
export type LayoutTranslateHeadingFit = {
	pageWidthPx: number;
	pageHeightPx: number;
	fontSize: number;
};

/**
 * Conservative counterpart to BabelDOC's paragraph-box expansion. We never
 * cross a detected layout region and cap each direction, so a missed detection
 * cannot turn one translated label into a page-wide white slab. Headings may
 * also grow downward (up to 2.75×) so a longer translation keeps the source
 * glyph size instead of collapsing.
 */
export function expandLayoutTranslateBbox(
	item: LayoutTranslateItem,
	blockers: readonly PdfLayoutRegion[] = [],
	headingFit?: LayoutTranslateHeadingFit,
): LayoutTranslateItem["bbox"] {
	const translated = item.translated?.trim();
	const sourceWidth =
		item.source.replace(/\s+/g, "").length * avgGlyphEm(item.source);
	const translatedWidth = translated
		? translated.replace(/\s+/g, "").length * avgGlyphEm(translated)
		: 0;
	// Raw layout boxes are reliable collision blockers for titles/captions, but
	// not sufficiently complete to safely borrow space for body prose. Expand
	// only when translated glyph width genuinely exceeds the source by 10%.
	const expandable =
		(isLayoutTranslateHeadingKind(item.kind) || item.kind === "figure_title") &&
		translatedWidth > sourceWidth * 1.1;
	const original = item.bbox;
	let bbox = original;
	if (expandable) {
		const x2 = original.x + original.w;
		const y2 = original.y + original.h;
		let right = OVERLAY_PAGE_RIGHT;
		let bottom = 1 - OVERLAY_GUTTER;
		for (const blocker of blockers) {
			if (blocker.id === item.id) continue;
			const b = blocker.bbox;
			if (
				b.x >= x2 - OVERLAY_GUTTER &&
				overlaps(original.y, y2, b.y, b.y + b.h)
			) {
				right = Math.min(right, b.x - OVERLAY_GUTTER);
			}
			if (
				b.y >= y2 - OVERLAY_GUTTER &&
				overlaps(original.x, x2, b.x, b.x + b.w)
			) {
				bottom = Math.min(bottom, b.y - OVERLAY_GUTTER);
			}
		}
		const width = Math.max(
			original.w,
			Math.min(right - original.x, original.w * 1.5),
		);
		// Prefer one-direction expansion. Expanding both could cover a diagonal
		// figure/table that does not overlap the original narrow title box.
		bbox =
			width > original.w + 0.001
				? { ...original, w: width }
				: {
						...original,
						h: Math.max(
							original.h,
							Math.min(bottom - original.y, original.h * 1.75),
						),
					};
	}

	if (
		!headingFit ||
		headingFit.pageHeightPx <= 0 ||
		!isLayoutTranslateHeadingKind(item.kind) ||
		!translated
	) {
		return bbox;
	}
	const widthPx = Math.max(1, bbox.w * headingFit.pageWidthPx - 4);
	const lines = estimateLineCount(
		translated,
		widthPx,
		headingFit.fontSize,
		avgGlyphEm(translated),
	);
	const neededH =
		(lines * headingFit.fontSize * LINE_HEIGHT + 3) / headingFit.pageHeightPx;
	const y2 = original.y + original.h;
	const x2 = bbox.x + bbox.w;
	let bottom = 1 - OVERLAY_GUTTER;
	for (const blocker of blockers) {
		if (blocker.id === item.id) continue;
		const b = blocker.bbox;
		if (b.y >= y2 - OVERLAY_GUTTER && overlaps(bbox.x, x2, b.x, b.x + b.w)) {
			bottom = Math.min(bottom, b.y - OVERLAY_GUTTER);
		}
	}
	const cap = Math.min(
		Math.max(bbox.h, bottom - original.y),
		original.h * 2.75,
	);
	const h = Math.min(Math.max(bbox.h, neededH), cap);
	return h > bbox.h + 0.0001 ? { ...bbox, h } : bbox;
}

/** Wider glyphs for CJK; narrower for Latin (academic body). */
function avgGlyphEm(text: string): number {
	const t = text.replace(/\s+/g, "");
	if (!t.length) return 0.58;
	const cjk = (t.match(/[\u3000-\u9fff\u3400-\u4dbf]/g) ?? []).length;
	const ratio = cjk / t.length;
	// Slightly conservative widths avoid an optimistic fit estimate followed by
	// CSS overflow clipping at real browser font metrics.
	return 0.55 * (1 - ratio) + 1 * ratio;
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
	return Math.max(FS_MIN, lo * FIT_SAFETY);
}

export type LayoutTranslateFontOptions = {
	/**
	 * Section and title blocks. Keep the size implied by the source box so a
	 * longer translation does not flatten the heading into body text. The box
	 * grows instead; body blocks still shrink to fit.
	 */
	heading?: boolean;
};

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
	options?: LayoutTranslateFontOptions,
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

	if (options?.heading) {
		let fs = paperFs;
		const srcLines = estimateLineCount(src, w, Math.max(paperFs, 8), srcEm);
		// A one-line title strip should fill its band. Do not cap that floor by
		// the smaller size that would cram a longer translation into the same box.
		if (srcLines === 1 && src.length < 140 && h < 56) {
			fs = Math.max(fs, Math.min(FS_MAX, (h / LINE_HEIGHT) * 0.92));
		}
		// Layout boxes for a short section title hug the glyphs (about one em
		// tall). Subtracting paragraph padding from such a box, or a pessimistic
		// line estimate at the 8px probe, collapsed "1. Introduction" to FS_MIN at
		// normal zoom, smaller than the body text. Size from the raw box height.
		// Only for boxes that really hold one source line at that size; multi-line
		// titles, logos and author strips keep the fitted size, and untranslated
		// strips (dates, ids) keep the size that already fits their box.
		const rawFs = Math.min(FS_MAX, bbox.h * pageHeightPx * HEADING_EM_PER_BOX);
		if (
			rawFs > fs &&
			display !== src &&
			estimateLineCount(src, w * 1.2, rawFs, srcEm) === 1
		) {
			fs = rawFs;
		}
		return Math.max(FS_MIN, Math.min(FS_MAX, fs));
	}

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
	// Preserve the real PDF em; do not grow short translations to fill the box.
	if (item.sourceStyle) return item.sourceStyle.fontSize * pageHeightPx;
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
		{ heading: isLayoutTranslateHeadingKind(item.kind) },
	);
	if (byText.size >= FONT_SIZE_CACHE_MAX_TEXTS) byText.clear();
	byText.set(text, fontSize);
	return fontSize;
}

function applyParagraphMetrics(
	element: HTMLParagraphElement,
	fontSize: number,
	lineHeight: number,
): void {
	element.style.fontSize = `${fontSize}px`;
	element.style.lineHeight = String(lineHeight);
}

type ExactFitParagraphProps = {
	sourceStyle?: LayoutSourceStyle;
	text: string;
	itemId: string;
	sentences?: LayoutTranslateItem["sentences"];
	initialFontSize: number;
	boxWidthPx: number;
	boxHeightPx: number;
	isHeading: boolean;
	tone: PdfPaperTone;
	/** Sentence indexes whose translation should show the highlight color. */
	tintedSentences?: ReadonlyMap<number, TranslateSentenceTint>;
	linkAssignments?: readonly PreservedLinkAssignment[];
	onOpenLink?: (assignment: PreservedLinkAssignment) => void;
	onHoverLink?: LayoutTranslateOverlayProps["onHoverLink"];
};

function sentenceSlices(
	text: string,
	nodes: readonly { index: number; text: string }[],
	gap: string,
): { index: number; text: string; start: number }[] {
	const slices: { index: number; text: string; start: number }[] = [];
	let cursor = 0;
	for (let index = 0; index < nodes.length; index++) {
		const node = nodes[index];
		if (!node) continue;
		const found = text.indexOf(node.text, cursor);
		const start = found >= 0 ? found : cursor;
		slices.push({ index: node.index, text: node.text, start });
		cursor = start + node.text.length + gap.length;
	}
	return slices;
}

function linkInkStyle(
	color: string | undefined,
	tone: PdfPaperTone,
): { color: string } | undefined {
	if (!color) return undefined;
	return { color: linkColorOnPaper(color, tone) };
}

function linkPoint(element: HTMLElement) {
	const box = element.getBoundingClientRect();
	return {
		x: box.left + box.width / 2,
		y: box.bottom,
		top: box.top,
		bottom: box.bottom,
	};
}

/**
 * Render `text`, wrapping preserved link tokens. Anchors stay non-draggable:
 * the browser default drag on `<a href>` replaces the text range when a drag
 * starts on or crosses a citation. A drag that produced a selection does not
 * navigate. Each token uses the original glyph fill (`assignment.color`),
 * adjusted for the paper tone. The source page marks these links by ink
 * color, so the token does not add an underline.
 */
function LinkifiedText({
	text,
	assignments,
	tone,
	onOpenLink,
	onHoverLink,
}: {
	text: string;
	assignments: readonly PreservedLinkAssignment[] | undefined;
	tone: PdfPaperTone;
	onOpenLink?: (assignment: PreservedLinkAssignment) => void;
	onHoverLink?: LayoutTranslateOverlayProps["onHoverLink"];
}) {
	if (!assignments?.length) return text;
	const parts: Array<
		| { key: string; text: string }
		| { key: string; assignment: PreservedLinkAssignment }
	> = [];
	let cursor = 0;
	for (const assignment of assignments) {
		if (assignment.start < cursor || assignment.end > text.length) continue;
		if (text.slice(assignment.start, assignment.end) !== assignment.text) {
			continue;
		}
		if (assignment.start > cursor) {
			parts.push({
				key: `t-${cursor}`,
				text: text.slice(cursor, assignment.start),
			});
		}
		parts.push({
			key: `l-${assignment.start}-${assignment.key ?? assignment.url ?? "url"}`,
			assignment,
		});
		cursor = assignment.end;
	}
	if (cursor === 0) return text;
	if (cursor < text.length) {
		parts.push({ key: `t-${cursor}`, text: text.slice(cursor) });
	}
	return parts.map((part) =>
		"text" in part ? (
			<Fragment key={part.key}>{part.text}</Fragment>
		) : (
			<a
				key={part.key}
				href={part.assignment.url ?? "#"}
				draggable={false}
				data-translated-link={part.assignment.key ?? part.assignment.url ?? ""}
				className="select-text"
				style={linkInkStyle(part.assignment.color, tone)}
				onDragStart={(event) => event.preventDefault()}
				onClick={(event) => {
					event.preventDefault();
					event.stopPropagation();
					if (window.getSelection()?.toString()) return;
					onOpenLink?.(part.assignment);
				}}
				onPointerEnter={(event) => {
					if (linkHoverSuppressed(event.buttons)) return;
					onHoverLink?.(part.assignment, linkPoint(event.currentTarget));
				}}
				onPointerLeave={() => {
					if (linkPreviewDragActive()) return;
					onHoverLink?.(null, null);
				}}
			>
				{part.assignment.text}
			</a>
		),
	);
}

/**
 * The heuristic above is fast but font metrics differ across Windows/macOS,
 * installed CJK fonts, and zoom levels. Verify the final browser layout and, if
 * necessary, binary-search the actual DOM font size so `overflow-hidden` never
 * silently chops off an otherwise complete translation.
 */
export const LayoutTranslateParagraph = memo(function LayoutTranslateParagraph({
	sourceStyle,
	text,
	itemId,
	sentences,
	initialFontSize,
	boxWidthPx,
	boxHeightPx,
	isHeading,
	tone,
	tintedSentences,
	linkAssignments,
	onOpenLink,
	onHoverLink,
}: ExactFitParagraphProps) {
	const ref = useRef<HTMLParagraphElement>(null);
	const sentenceNodes = layoutTranslateSentenceNodes(text, sentences);
	const slices = sentenceNodes
		? sentenceSlices(text, sentenceNodes.nodes, sentenceNodes.gap)
		: null;
	const domFitKey = layoutTranslateDomFitKey({
		text,
		boxWidthPx,
		boxHeightPx,
		initialFontSize,
		isHeading,
		fontStyleKey: `${sourceStyle?.bold ?? isHeading}:${sourceStyle?.italic ?? false}`,
	});
	const cachedDomFit = readLayoutTranslateDomFit(domFitKey);

	useLayoutEffect(() => {
		const element = ref.current;
		if (!element || boxWidthPx <= 0 || boxHeightPx <= 0) return;
		const cached = readLayoutTranslateDomFit(domFitKey);
		if (cached) {
			applyParagraphMetrics(element, cached.fontSize, cached.lineHeight);
			element.style.overflowWrap = cached.overflowWrap;
			return;
		}
		// A page of paragraphs used to binary-search on the mount frame. Spread
		// that across frames, and drop the job if this page scrolls away.
		return scheduleLayoutTranslateDomFit(() => {
			const live = ref.current;
			if (!live) return;
			const fit = fitLayoutTranslateParagraph(live, {
				text,
				initialFontSize,
				isHeading,
			});
			if (!fit) return;
			writeLayoutTranslateDomFit(domFitKey, fit);
		});
	}, [boxHeightPx, boxWidthPx, domFitKey, initialFontSize, isHeading, text]);

	return (
		<p
			ref={ref}
			className={cn(
				"pdf-translate-selection pointer-events-auto m-0 h-full w-full select-text overflow-hidden whitespace-pre-wrap",
				isHeading && "font-bold",
			)}
			data-layout-item={itemId}
			data-paper={tone}
			onPointerDownCapture={(event) => {
				if (event.button !== 0) return;
				beginLinkPreviewDrag();
			}}
			style={{
				fontSize: cachedDomFit?.fontSize ?? initialFontSize,
				fontWeight: sourceStyle ? (sourceStyle.bold ? 700 : 400) : undefined,
				fontStyle: sourceStyle?.italic ? "italic" : "normal",
				lineHeight: cachedDomFit?.lineHeight ?? LINE_HEIGHT,
				overflowWrap: cachedDomFit?.overflowWrap ?? "normal",
				// Browser-native UAX #14 breaking avoids a CJK opening bracket at a
				// line end and keeps Latin words intact until the measured fallback.
				lineBreak: "strict",
				wordBreak: "normal",
			}}
		>
			{slices && sentenceNodes ? (
				slices.map((node, index) => {
					const tint = tintedSentences?.get(node.index);
					return (
						<Fragment key={node.index}>
							{index > 0 ? sentenceNodes.gap : null}
							<span
								data-sentence={node.index}
								className={cn(tint && "rounded-[1px]")}
								style={
									tint
										? { backgroundColor: highlightFill(tint.color) }
										: undefined
								}
							>
								<LinkifiedText
									text={node.text}
									assignments={assignmentsWithin(
										linkAssignments ?? [],
										node.start,
										node.start + node.text.length,
									)}
									tone={tone}
									onOpenLink={onOpenLink}
									onHoverLink={onHoverLink}
								/>
							</span>
						</Fragment>
					);
				})
			) : (
				<LinkifiedText
					text={text}
					assignments={linkAssignments}
					tone={tone}
					onOpenLink={onOpenLink}
					onHoverLink={onHoverLink}
				/>
			)}
		</p>
	);
});

/**
 * Paint translated (or in-flight) blocks for one PDF page.
 */
export const LayoutTranslateOverlay = memo(function LayoutTranslateOverlay({
	items,
	pageIndex,
	reflowDocumentId,
	zoom,
	pageWidthPx,
	pageHeightPx,
	tone = "white",
	layoutRegions,
	highlightQuotes,
	sentenceRectsByItemId,
	links,
	glyphRuns,
	onOpenLink,
	onHoverLink,
}: LayoutTranslateOverlayProps) {
	const onPage = useMemo(() => {
		const painted = items
			.filter(
				(item) =>
					!item.reflow &&
					!/⟪(?:F|\/?S)\d+⟫/u.test(item.source) &&
					isLayoutTranslateItemPainted(item),
			)
			.map((item) => {
				const paintText =
					item.status === "running"
						? (item.translated ?? "…")
						: (item.translated ?? "");
				// Size from the source box. Expansion below must not inflate a
				// heading just because the translation borrowed extra height.
				const paintFontSize = fontSizeForLayoutTranslateItem(
					item,
					pageWidthPx,
					pageHeightPx,
					paintText,
				);
				return { item, paintText, paintFontSize };
			});
		// Same-page body reference so section titles outrank paragraphs even
		// when the layout detector hugged the heading glyphs (tiny bbox).
		// Tall paragraph boxes only — captions, author lines and footnotes are
		// often kind "text" but sized like microcopy and would collapse the floor.
		const bodyCandidates = painted.filter(
			({ item }) =>
				!isLayoutTranslateHeadingKind(item.kind) &&
				item.bbox.h >= 0.04 &&
				item.source.replace(/\s+/g, "").length >= 100,
		);
		const bodyRef = bodyReferenceFontSize(
			bodyCandidates.map(({ paintFontSize }) => paintFontSize),
		);
		return painted.map(({ item, paintText, paintFontSize: baseFs }) => {
			const isHeading = isLayoutTranslateHeadingKind(item.kind);
			// Doc titles already dwarf body; page chrome (date, logo) must not be
			// inflated. Only short section strips need the body-relative floor.
			const sectionStrip = isHeading && item.bbox.h < 0.035;
			const paintFontSize =
				sectionStrip && !item.sourceStyle
					? applyHeadingBodyFloor(baseFs, bodyRef)
					: baseFs;
			return {
				...item,
				sourceBbox: item.bbox,
				bbox: expandLayoutTranslateBbox(
					item,
					layoutRegions,
					isHeading
						? { pageWidthPx, pageHeightPx, fontSize: paintFontSize }
						: undefined,
				),
				paintText,
				paintFontSize,
			};
		});
	}, [items, layoutRegions, pageHeightPx, pageWidthPx]);
	const tintByItem = useMemo(
		() =>
			sentenceHighlightTints({
				layoutItems: items,
				highlightQuotes,
				sentenceRectsByItemId,
			}),
		[highlightQuotes, items, sentenceRectsByItemId],
	);
	const linksByItem = useMemo(
		() => claimTranslateLinks(onPage, links ?? []),
		[links, onPage],
	);
	const preview = items.find((item) => item.reflowPreview)?.reflowPreview;
	if (preview || reflowDocumentId)
		return (
			<ReflowPageOverlay
				tints={tintByItem}
				links={links}
				glyphRuns={glyphRuns}
				onOpenLink={onOpenLink}
				onHoverLink={onHoverLink}
				tone={tone}
				items={items}
				preview={preview ?? ""}
				pageIndex={pageIndex}
				renderDocumentId={reflowDocumentId}
				zoom={zoom}
				width={pageWidthPx}
				height={pageHeightPx}
			/>
		);

	if (onPage.length === 0) return null;
	return (
		<>
			{onPage.map((item) => {
				const text = item.paintText;
				const isHeading = isLayoutTranslateHeadingKind(item.kind);
				const linkAssignments = assignPreservedLinks(
					text,
					linksByItem.get(item.id) ?? [],
					{
						source: item.source,
						...(glyphRuns?.length
							? { block: item.sourceBbox, runs: glyphRuns }
							: {}),
					},
				);
				const fontSize = item.paintFontSize;
				const boxWidthPx = item.bbox.w * pageWidthPx;
				const boxHeightPx = item.bbox.h * pageHeightPx;
				const boxStyle = {
					left: `${item.bbox.x * 100}%`,
					top: `${item.bbox.y * 100}%`,
					width: `${item.bbox.w * 100}%`,
					height: `${item.bbox.h * 100}%`,
				};
				return (
					<Fragment key={`layout-tr-${item.id}`}>
						{/*
						 * Paper and glyphs are separate layers. The PDF selection
						 * tint is z-index 5 and uses multiply: an opaque block above
						 * it hides the highlight, but glyphs under it get washed out
						 * (WebKit). Paper stays at z-3, under the tint. Glyphs are
						 * z-6, above the tint, so the translation stays readable.
						 */}
						<div
							aria-hidden="true"
							className={cn(
								"pointer-events-none absolute z-[3] overflow-hidden rounded-[1px]",
								item.status === "running" && "opacity-90",
							)}
							style={boxStyle}
						>
							{/*
							 * Paper tone lives on this layer only. A filter on the
							 * text itself hides ::selection (WebKit), so dark mode
							 * inverts the paper and sets the glyphs explicitly.
							 */}
							<div
								className={cn(
									"absolute inset-0",
									PDF_PAPER_BLOCK_CLASS[tone],
									tone === "dark" && PDF_PAGE_RASTER_DARK_CLASS,
								)}
							/>
						</div>
						<div
							className={cn(
								"pointer-events-none absolute z-[6] overflow-hidden rounded-[1px]",
								item.status === "running" && "opacity-90",
							)}
							style={{ ...boxStyle, padding: "1px 2px" }}
						>
							<div
								className={cn(
									"h-full w-full",
									tone === "dark" ? "text-zinc-100" : "text-zinc-900",
								)}
								style={{
									fontSize,
									lineHeight: LINE_HEIGHT,
									fontFamily:
										'ui-serif, "Times New Roman", Times, "Noto Serif SC", "Songti SC", "Source Han Serif SC", serif',
									fontWeight: isHeading ? 700 : 400,
									// Justified CJK inserts space between every character. Those
									// gaps paint as a darker selection block where two highlight
									// rects overlap. Keep the glyphs adjacent, like the English line.
									textAlign: "start",
								}}
							>
								<LayoutTranslateParagraph
									text={text}
									itemId={item.id}
									sentences={item.sentences}
									initialFontSize={fontSize}
									sourceStyle={item.sourceStyle}
									boxWidthPx={boxWidthPx}
									boxHeightPx={boxHeightPx}
									isHeading={isHeading}
									tone={tone}
									tintedSentences={tintByItem.get(item.id)}
									linkAssignments={linkAssignments}
									onOpenLink={onOpenLink}
									onHoverLink={onHoverLink}
								/>
							</div>
						</div>
					</Fragment>
				);
			})}
		</>
	);
});
