/**
 * Layout-mode progressive translation overlay.
 *
 * Each translated block covers its full source bbox so the original PDF text
 * underneath stays hidden. Font size starts from the size the paper's own
 * body would use, then re-fits so a denser translation fills the block
 * without large gaps; a DOM-measured second pass corrects for real font
 * metrics. Also renders tail spinners for in-flight paragraphs and retry
 * markers for failed ones.
 */

import {
	Fragment,
	memo,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/core/utils";
import { HIGHLIGHT_HEX, highlightFill } from "@/lib/pdf/highlight/palette";
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
	activateTranslatedLinkClick,
	rememberTranslatedLinkOrigin,
} from "@/lib/pdf/layout/translated-link-gesture";
import {
	assignmentsWithin,
	assignPreservedLinks,
	claimTranslateLinks,
	type GlyphRun,
	type PreservedLinkAssignment,
	type TranslateLinkBox,
} from "@/lib/pdf/layout/translated-links";
import { translationRetryItems } from "@/lib/pdf/layout/translation-retry";
import {
	TRANSLATION_SPINNER_SIZE,
	translationSpinnerAnchor,
	translationSpinnerItems,
} from "@/lib/pdf/layout/translation-spinner";
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
import { ReflowPageOverlay } from "./reflow-page-overlay";
import { TranslationRetryMarker } from "./translation-retry-marker";
import { TranslationSpinner } from "./translation-spinner";

type LayoutTranslateOverlayProps = {
	/** Translation items already bucketed to this page (groupLayoutTranslateItemsByPage). */
	items: readonly LayoutTranslateItem[];
	/** 0-based page index; source and translated PDFs share page order. */
	pageIndex: number;
	/** Finished translated PDF document id for the shared render path. */
	reflowDocumentId?: string | null;
	/** Lightweight version the hidden translated document currently holds. */
	reflowDocumentVersion?:
		| import("@/lib/pdf/reflow/output-version").ReflowOutputVersion
		| null;
	/** Current viewer zoom, forwarded to the shared render layer. */
	zoom: number;
	/** Page size in CSS pixels; feeds the font-size heuristics. */
	pageWidthPx: number;
	pageHeightPx: number;
	/** Paper tone of the PDF page itself (not app chrome). */
	tone?: PdfPaperTone;
	/** Raw page regions, used as collision blockers when expanding overlays. */
	layoutRegions?: readonly PdfLayoutRegion[];
	/**
	 * English highlights on this page without translated boxes. A sentence is
	 * tinted when its English glyph boxes overlap the highlight; nothing is
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
	 * Citation / ref / URL tokens preserved inside a block become its hit
	 * targets, so the English rectangles can stay under the glyphs.
	 */
	links?: readonly TranslateLinkBox[];
	/** Source text runs for this page; keeps grouped citations on their own glyphs. */
	glyphRuns?: readonly GlyphRun[];
	/**
	 * Set while the page's text is translated but its translated raster is
	 * still generating; keeps the paragraph-end spinner up until the preview
	 * paints.
	 */
	awaitingPreview?: boolean;
	/**
	 * Retries the paragraph's page after its translation failed for good.
	 * When absent, failed blocks render no in-place retry marker.
	 */
	onRetryTranslation?: (pageIndex: number) => void;
	/** Opens a preserved link the user clicked. */
	onOpenLink?: (assignment: PreservedLinkAssignment) => void;
	/** Preserved-link hover lifecycle; `point` is the anchor's viewport box, null on leave. */
	onHoverLink?: (
		assignment: PreservedLinkAssignment | null,
		point: { x: number; y: number; top: number; bottom: number } | null,
	) => void;
};

/** Line-height multiplier shared by the estimate and the painted paragraph. */
const LINE_HEIGHT = 1.25;
/**
 * Font-size bounds for the heuristic fit. FS_MIN is only the estimate's
 * floor: the DOM-measured second pass may go lower when real browser metrics
 * prove the text would otherwise clip.
 */
const FS_MIN = 4;
const FS_MAX = 20;
/** Shrink heuristic results a touch so estimate error errs toward fitting. */
const FIT_SAFETY = 0.97;
/** A one-line heading box spans roughly ascender..descender ≈ 0.9 em. */
const HEADING_EM_PER_BOX = 0.9;
/** How far section titles must outrank same-page body text. */
export const HEADING_TO_BODY_SIZE_RATIO = 1.35;

/**
 * Reference body size for a page: the upper quartile of its painted body
 * blocks' font sizes, so small or dense outliers cannot drag the heading
 * floor back toward microcopy. Undefined until the page has at least one
 * painted body block (still translating, or a title-only page).
 */
export function bodyReferenceFontSize(
	sizes: readonly number[],
): number | undefined {
	const usable = sizes
		.filter((n) => Number.isFinite(n) && n > FS_MIN)
		.sort((a, b) => a - b);
	if (usable.length === 0) return undefined;
	const idx = Math.min(usable.length - 1, Math.ceil(usable.length * 0.75) - 1);
	return usable[Math.max(0, idx)];
}

/** Lift a heading to at least `bodyRef × HEADING_TO_BODY_SIZE_RATIO`, capped at FS_MAX. */
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

/** Right edge (page fraction) an overlay may expand to. */
const OVERLAY_PAGE_RIGHT = 0.97;
/** Gap kept between an expanded overlay and its nearest blocker, in page fractions. */
const OVERLAY_GUTTER = 0.006;

/** Whether two ranges share more than a boundary (gutters rely on that). */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number) {
	return Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > 0;
}

/**
 * Page pixel size plus heading font size, so the expansion can estimate how
 * many lines a translated heading wraps to.
 */
export type LayoutTranslateHeadingFit = {
	pageWidthPx: number;
	pageHeightPx: number;
	fontSize: number;
};

/**
 * Grow a block's bbox when its translation needs more room than the source
 * did. Only headings and figure titles may expand, in one direction (widen
 * ≤1.5× or deepen ≤1.75×) and never past the nearest colliding region; with
 * `headingFit`, a wrapped heading also gains height (≤2.75×) so lines are
 * not clipped. Body prose never expands: raw layout regions are reliable
 * blockers around titles, but too incomplete to trust for body text.
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
	// The 10% threshold filters noise: expand only when the translated glyphs
	// are genuinely wider than the source, not on estimate jitter.
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
		// One direction only: widening both ways could cover a diagonally
		// adjacent figure/table that never overlapped the narrow original box.
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

	// Second stage (headings only): deepen the box for the extra lines the
	// translation wraps to, capped by blockers and 2.75× the source box.
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

/** Average glyph advance in em: 1.0 for CJK, 0.55 for Latin academic prose. */
function avgGlyphEm(text: string): number {
	const t = text.replace(/\s+/g, "");
	if (!t.length) return 0.58;
	const cjk = (t.match(/[\u3000-\u9fff\u3400-\u4dbf]/g) ?? []).length;
	const ratio = cjk / t.length;
	// The Latin width is deliberately conservative so the estimate does not
	// promise a fit that real font metrics later clip.
	return 0.55 * (1 - ratio) + 1 * ratio;
}

/** Estimated line count: honor explicit newlines, wrap the rest by average glyph advance. */
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

/** Estimated wrapped height of `text` at `fontSize`. */
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
 * Largest font size whose wrapped `text` still fits in widthPx × heightPx,
 * found by binary search over the line-count estimate.
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
	// 12 halvings of the [FS_MIN, FS_MAX] range land well below one pixel.
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
	 * Section/title blocks: keep the size implied by the source box so a
	 * longer translation cannot flatten the heading into body text — the box
	 * grows instead. Body blocks still shrink to fit their translation.
	 */
	heading?: boolean;
};

/**
 * Font size for one translated block. Start from the size the source text
 * would use in the same box (paper-like), then adjust for the translation:
 * shrink when it would overflow, grow modestly when denser text (e.g.
 * Chinese) would otherwise leave the block half empty.
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

	// 1) The size the original paper text would use in this box.
	const paperFs = fitFontSizeToBox(src, w, h, srcEm);

	if (options?.heading) {
		let fs = paperFs;
		const srcLines = estimateLineCount(src, w, Math.max(paperFs, 8), srcEm);
		// A one-line title strip should fill its band; that floor must not be
		// dragged down by the smaller size a longer translation would cram into.
		if (srcLines === 1 && src.length < 140 && h < 56) {
			fs = Math.max(fs, Math.min(FS_MAX, (h / LINE_HEIGHT) * 0.92));
		}
		// A short section title's box hugs its glyphs (~1 em tall), so padding
		// subtraction and the pessimistic 8px line probe both undersize it. Size
		// from the raw box height instead — but only when the box truly holds a
		// single source line at that size. Multi-line titles, logos and author
		// strips keep the fitted size; untranslated strips (dates, ids) keep
		// whatever already fits.
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

	// 2) The largest size the translation itself would still fit at.
	const fitFs = fitFontSizeToBox(display, w, h, dispEm);

	// 3) Prefer the paper-like size: shrink on overflow, grow only modestly so
	//    a denser translation does not leave the block half blank.
	let fs = paperFs;
	if (fitFs < paperFs * 0.98) {
		// Translation longer / glyphs wider → must shrink.
		fs = fitFs;
	} else if (fitFs > paperFs * 1.05) {
		// Room to grow: aim for ~90% of the max fit, capped at 1.22× paper size.
		fs = Math.min(fitFs * 0.9, paperFs * 1.22);
	}

	// A one-line micro strip (headers, bylines) should use most of its height.
	const srcLines = estimateLineCount(src, w, Math.max(paperFs, 8), srcEm);
	if (srcLines === 1 && src.length < 100 && h < 40) {
		fs = Math.min(fitFs, Math.max(fs, h * 0.7));
	}

	return Math.max(FS_MIN, Math.min(FS_MAX, fs));
}

/**
 * Cache for the binary-search fit. Streaming job updates repaint every
 * mounted page, but a block's fitted size depends only on (item, box pixel
 * size, source, translation), so unchanged blocks reuse their last result
 * instead of re-fitting on every render. Nested maps key on raw strings
 * (value equality), so hits build no composite key strings. Bounded: oldest
 * item entries evict first; per-item maps hold only the few text variants a
 * block passes through (placeholder → final).
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
	// A measured PDF font size is authoritative: use it as-is and never grow a
	// short translation to fill the box.
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
		// Box pixels changed (zoom or geometry): cached sizes no longer apply.
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

/** Apply a fitted font size and line height to the paragraph element. */
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
	running?: boolean;
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

/** Split paragraph `text` along sentence nodes, recording each slice's start offset. */
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

/** The anchor element's viewport box, for hover-card placement. */
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
 * `text` with preserved link tokens wrapped in anchors. Anchors must stay
 * non-draggable — the browser's default `<a href>` drag replaces the text
 * selection whenever it starts on or crosses a citation — and a click that
 * left a selection does not navigate. Tokens keep their original glyph fill
 * (`assignment.color`) adjusted for the paper tone and add no underline: the
 * source page signals these links by ink color alone.
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
				onPointerDown={(event) => {
					if (event.button !== 0) return;
					rememberTranslatedLinkOrigin(event.currentTarget, {
						x: event.clientX,
						y: event.clientY,
					});
				}}
				onClick={(event) => {
					activateTranslatedLinkClick(event, () => {
						onOpenLink?.(part.assignment);
					});
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
 * One translated paragraph. The heuristic start size is fast but approximate
 * — font metrics vary across platforms, installed CJK fonts and zoom — so
 * after paint, a DOM-measured pass re-fits the actual font size until the
 * text genuinely fits, keeping `overflow-hidden` from silently truncating a
 * complete translation.
 */
export const LayoutTranslateParagraph = memo(function LayoutTranslateParagraph({
	sourceStyle,
	running,
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
	const [tail, setTail] = useState<{
		x: number;
		y: number;
		size: number;
	} | null>(null);
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
		// Anchor the running spinner just past the last painted glyph.
		const measureTail = () => {
			if (!running) return;
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			let last: Text | null = null;
			while (walker.nextNode()) {
				if (walker.currentNode.textContent?.trim())
					last = walker.currentNode as Text;
			}
			if (!last) return;
			const end = last.data.trimEnd().length;
			const range = document.createRange();
			range.setStart(last, Math.max(0, end - 1));
			range.setEnd(last, end);
			const rect = range.getClientRects()[0];
			if (!rect) return;
			const box = element.getBoundingClientRect();
			const sx = box.width / element.clientWidth;
			const sy = box.height / element.clientHeight;
			const size = TRANSLATION_SPINNER_SIZE;
			setTail({
				x: (rect.right - box.left) / sx + size * 0.2,
				y: (rect.top + rect.height / 2 - box.top) / sy - size / 2,
				size,
			});
		};
		const cached = readLayoutTranslateDomFit(domFitKey);
		if (cached) {
			applyParagraphMetrics(element, cached.fontSize, cached.lineHeight);
			element.style.overflowWrap = cached.overflowWrap;
			measureTail();
			return;
		}
		// Spread the DOM fit work across frames instead of measuring a whole
		// page on mount; the job is dropped if this page scrolls away first.
		return scheduleLayoutTranslateDomFit(() => {
			const live = ref.current;
			if (!live) return;
			const fit = fitLayoutTranslateParagraph(live, {
				text,
				initialFontSize,
				isHeading,
			});
			measureTail();
			if (!fit) return;
			writeLayoutTranslateDomFit(domFitKey, fit);
		});
	}, [
		boxHeightPx,
		boxWidthPx,
		domFitKey,
		initialFontSize,
		isHeading,
		text,
		running,
	]);

	return (
		<div className="relative h-full w-full">
			<p
				ref={ref}
				className={cn(
					"pdf-translate-selection pointer-events-auto m-0 h-full w-full select-text overflow-hidden whitespace-pre-wrap",
					isHeading && "font-bold",
				)}
				data-layout-item={itemId}
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
					// Strict UAX #14 breaking: no CJK opening bracket stranded at a
					// line end, Latin words stay whole until the measured fallback.
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
									data-highlight-id={tint?.highlightId}
									className={cn(tint?.shape !== "underline" && "rounded-[1px]")}
									style={
										tint
											? tint.shape === "underline"
												? {
														textDecorationLine: "underline",
														textDecorationColor: HIGHLIGHT_HEX[tint.color],
														textDecorationThickness: "2px",
														textUnderlineOffset: "2px",
													}
												: { backgroundColor: highlightFill(tint.color) }
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
			{running && tail && <TranslationSpinner {...tail} />}
		</div>
	);
});

/**
 * All translation chrome for one PDF page: the shared reflow render path
 * when a preview or finished document exists, otherwise per-block overlays —
 * plus tail spinners for in-flight paragraphs and retry markers for failed
 * ones.
 */
export const LayoutTranslateOverlay = memo(function LayoutTranslateOverlay({
	items,
	pageIndex,
	reflowDocumentId,
	reflowDocumentVersion,
	zoom,
	pageWidthPx,
	pageHeightPx,
	tone = "white",
	layoutRegions,
	highlightQuotes,
	sentenceRectsByItemId,
	links,
	glyphRuns,
	awaitingPreview,
	onRetryTranslation,
	onOpenLink,
	onHoverLink,
}: LayoutTranslateOverlayProps) {
	const { t } = useTranslation("viewer");
	const onPage = useMemo(() => {
		const painted = items
			.filter(
				(item) =>
					!item.reflow &&
					!/⟪(?:F|\/?S)\d+⟫/u.test(item.source) &&
					isLayoutTranslateItemPainted(item),
			)
			.map((item) => {
				const paintText = item.translated ?? "";
				// Fit against the source box: the bbox expansion below must not
				// inflate a heading merely because it borrowed extra height.
				const paintFontSize = fontSizeForLayoutTranslateItem(
					item,
					pageWidthPx,
					pageHeightPx,
					paintText,
				);
				return { item, paintText, paintFontSize };
			});
		// Body reference from this page's tall paragraphs only, so section
		// titles still outrank body text when the detector hugged the heading
		// glyphs into a tiny bbox. Captions, bylines and footnotes are often
		// plain "text" but microcopy-sized; including them would sink the floor.
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
			// Only short section strips need the body-relative floor: document
			// titles already dwarf body text; page chrome must not be inflated.
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
	const previewSources = items.find(
		(item) => item.reflowPreview,
	)?.reflowPreviewSources;
	const displayMatchesPreview =
		!previewSources ||
		(reflowDocumentVersion && previewSources.has(reflowDocumentVersion));
	const spinnerItems = translationSpinnerItems(
		items,
		layoutRegions,
		awaitingPreview,
	);
	const spinnerIds = new Set(spinnerItems.map((item) => item.id));
	const sourceSpinners = spinnerItems
		.filter((item) => item.reflow || !isLayoutTranslateItemPainted(item))
		.map((item) => (
			<TranslationSpinner
				key={item.id}
				{...translationSpinnerAnchor(
					item,
					pageWidthPx,
					pageHeightPx,
					glyphRuns,
				)}
			/>
		));
	// Failed paragraphs keep their source text visible; the marker sits where
	// the spinner was and retries the whole page — no toast needed.
	const retryMarkers = onRetryTranslation
		? translationRetryItems(items, layoutRegions).map((item) => (
				<TranslationRetryMarker
					key={`layout-retry-${item.id}`}
					{...translationSpinnerAnchor(
						item,
						pageWidthPx,
						pageHeightPx,
						glyphRuns,
					)}
					label={t("pdf.layoutTranslate.retryPage")}
					onRetry={() => onRetryTranslation(pageIndex)}
				/>
			))
		: [];
	if (preview || reflowDocumentId)
		return (
			<>
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
					renderDocumentId={displayMatchesPreview ? reflowDocumentId : null}
					zoom={zoom}
					width={pageWidthPx}
					height={pageHeightPx}
				/>
				{sourceSpinners}
				{retryMarkers}
			</>
		);

	if (onPage.length === 0)
		return (
			<>
				{sourceSpinners}
				{retryMarkers}
			</>
		);
	return (
		<>
			{sourceSpinners}
			{retryMarkers}
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
						 * Paper and glyphs must be separate layers around the PDF
						 * selection tint (z-5, multiply): an opaque block above the
						 * tint hides the highlight, while glyphs beneath it wash out
						 * in WebKit. Paper stays at z-3, under the tint; glyphs at
						 * z-6, above it, stay readable.
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
							 * Tone the paper layer only, never the text: filters on
							 * text hide ::selection in WebKit. Dark mode inverts the
							 * paper and sets glyph colors explicitly instead.
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
								"pointer-events-none absolute z-[6] rounded-[1px]",
								item.status === "running" && "opacity-90",
							)}
							style={{ ...boxStyle, padding: "1px 2px" }}
						>
							<div
								className="h-full w-full"
								style={{
									color: "var(--pdf-paper-ink)",
									fontSize,
									lineHeight: LINE_HEIGHT,
									fontFamily:
										'ui-serif, "Times New Roman", Times, "Noto Serif SC", "Songti SC", "Source Han Serif SC", serif',
									fontWeight: isHeading ? 700 : 400,
									// Justified CJK stretches the gap between characters, and those
									// gaps paint darker where two highlight rects overlap. Keep
									// glyphs adjacent, as in the English source line.
									textAlign: "start",
								}}
							>
								<LayoutTranslateParagraph
									text={text}
									itemId={item.id}
									running={spinnerIds.has(item.id)}
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
