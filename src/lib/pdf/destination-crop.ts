/**
 * Crop region for an in-text citation's destination — the bibliography entry a
 * `[N]` link jumps to — shown as an in-place preview when no structured
 * sidecar metadata is available.
 *
 * Prefers the destination page's text rects: group adjacent text into line
 * segments, find the line that opens entry N, and extend until the next entry
 * starts. The entry's own lines set its width, independently of the rest of
 * the page. Falls back to the layout region containing the anchor,
 * then to plain column geometry.
 */

import { clamp01 } from "@/lib/core/math";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";
import { groupLineSegments, type PageTextRect } from "@/lib/pdf/link-text";

export type PickDestinationRegionOptions = {
	pageIndex: number;
	pdfX: number | null;
	pdfY: number;
	pageWidthPt: number;
	pageHeightPt: number;
	regions?: readonly PdfLayoutRegion[];
	textRects?: readonly PageTextRect[];
	/** Bibliography number the link cites, when known. */
	entryIndex?: number | null;
	/**
	 * Last entry of a cited range (`[8–12]` → 12). The crop then spans from
	 * `entryIndex` through this entry.
	 */
	endEntryIndex?: number | null;
};

export type DestinationCropRegion = {
	pageIndex: number;
	bbox: { x: number; y: number; w: number; h: number };
	/**
	 * True when a line opening entry `entryIndex` (`[N]` / `N.`) — or, for a
	 * range, any entry inside it — was found near the destination: proof the
	 * link really lands on a bibliography entry.
	 */
	entryMatched: boolean;
};

/** US Letter, used when the page size is unavailable. */
const DEFAULT_PAGE_WIDTH_PT = 612;
const DEFAULT_PAGE_HEIGHT_PT = 792;

// Empirical thresholds (PDF points unless noted), tuned on IEEE / ACM /
// USENIX / Springer bibliographies.
/** A detached entry label may start this far above / below its text. */
const LINE_CLUSTER_TOLERANCE_PT = 4;
/** Alignment tolerance for destinations just outside a hanging `[N]` label. */
const COLUMN_EDGE_SLACK_PT = 6;
/** PDF destinations may sit at the column margin, left of the entry label. */
const ANCHOR_X_SLACK_PT = 16;
/** Search radius around the destination y for the `[N]` / `N.` line. */
const ENTRY_SEARCH_RADIUS_PT = 120;
/** Without a marker, the nearest line must lie within this of the anchor. */
const ANCHOR_LINE_RADIUS_PT = 60;
/** Window above / below the anchor scanned for any entry-start line. */
const ANCHOR_WINDOW_ABOVE_PT = 16;
const ANCHOR_WINDOW_BELOW_PT = 24;
/** A vertical gap larger than this before the next entry ends a range. */
const RANGE_ENTRY_GAP_PT = 14;
/** Hard cap on one entry's height (~12–14 lines). */
const ENTRY_MAX_HEIGHT_PT = 160;
/** Allow a taller crop for a range: a base plus a per-entry allowance, capped. */
const RANGE_BASE_HEIGHT_PT = 200;
const RANGE_PER_ENTRY_PT = 80;
const RANGE_MAX_HEIGHT_PT = 650;
/** Lines this close to the entry's first-line x count as "back at margin". */
const HANGING_INDENT_SLACK_PT = 3;
/** Padding around the entry's text bounds. */
const CROP_PAD_X_PT = 6;
const CROP_PAD_Y_PT = 5;

// Normalized (0–1 of the page) limits.
const CROP_MAX_W = 0.96;
const CROP_MIN_H = 0.02;
const CROP_MAX_H = 0.3;
const RANGE_CROP_MAX_H = 0.65;
/** Crops stay inside this page margin. */
const PAGE_EDGE = 0.98;
/** Height of the geometry-only fallback crop. */
const FALLBACK_H = 0.12;

/**
 * Labelled bibliography entry starts:
 * - [1], [ 1 ], [12] (bracketed numbers)
 * - [ABC24], [DEF+25], [Ghi26] (bracketed alphanumeric keys — always with
 *   year digits, so IEEE's "[Online]. Available: …" continuation is not one)
 * - 1., 12. (dot-numbered)
 */
const LABELLED_ENTRY_START_REGEX =
	/^\s*(?:\[\s*\d+\s*\]|\[[A-Za-z+]*\d[A-Za-z0-9+]*\]|\d{1,3}\s?\.\s)/;
/** A detached entry label may sit further from its text than an ordinary word. */
const ENTRY_LABEL_ONLY_REGEX =
	/^\s*(?:\[\s*\d+\s*\]|\[[A-Za-z+]*\d[A-Za-z0-9+]*\]|\d{1,3}\s?\.)\s*$/;
/**
 * Author-year entry starts: "Author et al., 2024", "Writer (2025)". Only used
 * in bibliographies without labels — in a labelled one, continuation lines
 * such as "USA, 2017, pp. 2123–2138." would match too.
 */
const AUTHOR_YEAR_ENTRY_START_REGEX =
	/^\s*[A-Z][A-Za-z]+(?:\s+et\s+al\.)?,?\s+(?:\(?\s*(?:19|20)\d{2}\)?)/;

/** Entry-start test for one column's lines, by its bibliography style. */
function entryStartTest(lines: readonly TextLine[]): (text: string) => boolean {
	const labelled = lines.some((l) => LABELLED_ENTRY_START_REGEX.test(l.text));
	return labelled
		? (text) => LABELLED_ENTRY_START_REGEX.test(text)
		: (text) => AUTHOR_YEAR_ENTRY_START_REGEX.test(text);
}

/**
 * Line that opens bibliography entry `n`: `[n]`, `[n:` or `n. `. Rects are
 * joined with spaces, so the number and its dot may arrive as `n .`.
 */
function entryMarkerRegex(n: number): RegExp {
	return new RegExp(`^\\s*(?:\\[\\s*${n}\\s*[\\]:]|${n}\\s?\\.\\s)`);
}

/** Bibliography number an entry line opens with (`[12] …` / `12. …`). */
function leadingEntryNumber(text: string): number | null {
	const m = /^\s*\[?\s*(\d+)/.exec(text);
	return m ? Number.parseInt(m[1] ?? "", 10) : null;
}

/** Whether layout regions show a narrow right-hand column. */
function hasTwoColumnRegions(
	regions: readonly PdfLayoutRegion[] | undefined,
): boolean {
	return regions?.some((r) => r.bbox.x >= 0.48 && r.bbox.w < 0.5) ?? false;
}

type TextLine = {
	minY: number;
	maxY: number;
	minX: number;
	maxX: number;
	text: string;
};

/** Keep separate columns on the same baseline, joining detached entry labels. */
function entrySegments(rects: readonly PageTextRect[]): TextLine[] {
	const lines = groupLineSegments(rects)
		.map((segment) => ({
			minY: segment.coreTop,
			maxY: segment.coreBottom,
			minX: segment.left,
			maxX: segment.right,
			text: segment.glyphs.map((glyph) => glyph.ch).join(""),
		}))
		.sort((a, b) => a.minY - b.minY || a.minX - b.minX);
	const joined = new Set<TextLine>();
	for (const label of lines) {
		if (!ENTRY_LABEL_ONLY_REGEX.test(label.text)) continue;
		const next = lines
			.filter(
				(line) =>
					!joined.has(line) &&
					line.minX >= label.maxX &&
					Math.abs(line.minY - label.minY) <= LINE_CLUSTER_TOLERANCE_PT,
			)
			.sort((a, b) => a.minX - b.minX)[0];
		if (
			!next ||
			ENTRY_LABEL_ONLY_REGEX.test(next.text) ||
			next.minX - label.maxX > (next.maxY - next.minY) * 4
		) {
			continue;
		}
		label.text += ` ${next.text}`;
		label.minY = Math.min(label.minY, next.minY);
		label.maxY = Math.max(label.maxY, next.maxY);
		label.maxX = next.maxX;
		joined.add(next);
	}
	return lines.filter((line) => !joined.has(line));
}

/** Once the column is known, join all runs on a row, including spaced URLs. */
function clusterLines(rects: readonly PageTextRect[]): TextLine[] {
	const clusters: { yCenter: number; rects: PageTextRect[] }[] = [];
	for (const r of [...rects].sort(
		(a, b) => a.rect.origin.y - b.rect.origin.y,
	)) {
		const center = r.rect.origin.y + r.rect.size.height / 2;
		const line = clusters.find(
			(c) => Math.abs(c.yCenter - center) <= LINE_CLUSTER_TOLERANCE_PT,
		);
		if (line) {
			line.rects.push(r);
			line.yCenter += (center - line.yCenter) / line.rects.length;
		} else {
			clusters.push({ yCenter: center, rects: [r] });
		}
	}
	return clusters
		.map(({ rects: row }) => {
			row.sort((a, b) => a.rect.origin.x - b.rect.origin.x);
			return {
				minY: Math.min(...row.map((r) => r.rect.origin.y)),
				maxY: Math.max(...row.map((r) => r.rect.origin.y + r.rect.size.height)),
				minX: Math.min(...row.map((r) => r.rect.origin.x)),
				maxX: Math.max(...row.map((r) => r.rect.origin.x + r.rect.size.width)),
				text: row.map((r) => r.content).join(" "),
			};
		})
		.sort((a, b) => a.minY - b.minY);
}

function nearestLine(lines: readonly TextLine[], y: number): TextLine {
	return lines.reduce((best, l) =>
		Math.abs(l.minY - y) < Math.abs(best.minY - y) ? l : best,
	);
}

/** Clamp a normalized crop so it keeps its size and stays on the page. */
function clampCrop(
	x: number,
	y: number,
	w: number,
	h: number,
): { x: number; y: number; w: number; h: number } {
	const width = Math.min(w, PAGE_EDGE);
	const height = Math.min(h, PAGE_EDGE);
	return {
		x: Math.min(clamp01(x), PAGE_EDGE - width),
		y: Math.min(clamp01(y), PAGE_EDGE - height),
		w: width,
		h: height,
	};
}

/** Crop the entry from the destination page's text lines, or null. */
function cropFromText(
	textRects: readonly PageTextRect[],
	options: {
		wPt: number;
		hPt: number;
		targetYPt: number;
		normX: number | null;
		entryIndex?: number | null;
		endEntryIndex?: number | null;
	},
): { bbox: DestinationCropRegion["bbox"]; entryMatched: boolean } | null {
	const { wPt, hPt, targetYPt, normX, entryIndex } = options;
	const range =
		entryIndex != null &&
		options.endEntryIndex != null &&
		options.endEntryIndex > entryIndex
			? { start: entryIndex, end: options.endEntryIndex }
			: null;
	// Rotated side watermarks span many rows and otherwise connect them all.
	const validRects = textRects.filter(
		(r) => r.content?.trim() && r.rect.size.height <= ENTRY_MAX_HEIGHT_PT,
	);
	const allLines = entrySegments(validRects);
	const anchorX = normX != null ? normX * wPt : null;
	const anchorLines =
		anchorX != null
			? allLines.filter(
					(line) =>
						line.minX <= anchorX + ANCHOR_X_SLACK_PT &&
						line.maxX >= anchorX - COLUMN_EDGE_SLACK_PT,
				)
			: allLines;
	const candidates = anchorLines.length ? anchorLines : allLines;
	if (candidates.length === 0) return null;
	const isEntryStart = entryStartTest(candidates);

	const marker = entryIndex != null ? entryMarkerRegex(entryIndex) : null;
	// A range's first entry sits at or above the anchor, anywhere on the page.
	const exactCandidates = marker
		? allLines.filter(
				(l) =>
					marker.test(l.text) &&
					(range
						? l.minY <= targetYPt + ANCHOR_WINDOW_BELOW_PT &&
							targetYPt - l.minY <= hPt
						: Math.abs(l.minY - targetYPt) <= ENTRY_SEARCH_RADIUS_PT),
			)
		: [];
	// The range's first entry is on an earlier page / column: start at the
	// first entry of the range present here.
	const inRangeCandidates =
		range && exactCandidates.length === 0
			? candidates.filter((l) => {
					if (!isEntryStart(l.text)) return false;
					const n = leadingEntryNumber(l.text);
					return (
						n != null &&
						n >= range.start &&
						n <= range.end &&
						Math.abs(l.minY - targetYPt) <= hPt
					);
				})
			: [];
	const entryMatched =
		exactCandidates.length > 0 || inRangeCandidates.length > 0;

	let startLine: TextLine;
	if (exactCandidates.length > 0) {
		startLine = nearestLine(exactCandidates, targetYPt);
	} else if (inRangeCandidates[0]) {
		startLine = inRangeCandidates[0];
	} else {
		const markerCandidates = candidates.filter(
			(l) =>
				l.maxY >= targetYPt - ANCHOR_WINDOW_ABOVE_PT &&
				l.minY <= targetYPt + ANCHOR_WINDOW_BELOW_PT &&
				isEntryStart(l.text),
		);
		startLine = nearestLine(
			markerCandidates.length > 0 ? markerCandidates : candidates,
			targetYPt,
		);
	}

	// Nearby entry margins distinguish neighbouring columns. The first row may
	// end early or split before a URL, so its width cannot bound wrapped rows.
	const nearbyEntries = allLines.filter(
		(line) =>
			isEntryStart(line.text) &&
			Math.abs(line.minY - startLine.minY) <= ENTRY_SEARCH_RADIUS_PT,
	);
	const columnEntries = nearbyEntries.filter(
		(line) => Math.abs(line.minX - startLine.minX) <= ANCHOR_X_SLACK_PT,
	);
	const columnLeft = Math.min(
		startLine.minX,
		...columnEntries.map((line) => line.minX),
	);
	const columnExtent = Math.max(
		startLine.maxX,
		...columnEntries.map((line) => line.maxX),
	);
	// The other column may still contain prose or equations. Repeated margins
	// there distinguish it from a detached URL run on this entry's first row.
	const neighbours = allLines.filter(
		(line) =>
			Math.abs(line.minY - startLine.minY) <= ENTRY_SEARCH_RADIUS_PT &&
			line.minX > columnExtent + COLUMN_EDGE_SLACK_PT,
	);
	const sharesEntryRow = (line: TextLine) =>
		columnEntries.some(
			(entry) => Math.abs(entry.minY - line.minY) <= LINE_CLUSTER_TOLERANCE_PT,
		);
	const columnRight = Math.min(
		wPt,
		...nearbyEntries
			.filter((line) => line.minX > startLine.maxX + COLUMN_EDGE_SLACK_PT)
			.map((line) => line.minX),
		...neighbours
			.filter((line) =>
				neighbours.some(
					(other) =>
						other !== line &&
						Math.abs(other.minX - line.minX) <= ANCHOR_X_SLACK_PT &&
						Math.abs(other.minY - line.minY) > LINE_CLUSTER_TOLERANCE_PT &&
						Math.abs(other.minY - line.minY) <= ENTRY_SEARCH_RADIUS_PT &&
						(!sharesEntryRow(line) || !sharesEntryRow(other)),
				),
			)
			.map((line) => line.minX),
	);
	const lines = clusterLines(
		validRects.filter(
			(r) =>
				r.rect.origin.x >= columnLeft - COLUMN_EDGE_SLACK_PT &&
				r.rect.origin.x < columnRight,
		),
	);
	if (lines.length === 0) return null;
	startLine = nearestLine(lines, startLine.minY);
	const startIdx = lines.indexOf(startLine);
	if (
		startIdx < 0 ||
		(!entryMatched &&
			Math.abs(startLine.minY - targetYPt) > ANCHOR_LINE_RADIUS_PT)
	) {
		return null;
	}

	const entryLines = [startLine];
	const startHasMarker = isEntryStart(startLine.text);
	const baseLeftX = startLine.minX;
	for (let i = startIdx + 1; i < lines.length; i++) {
		const prev = lines[i - 1];
		const curr = lines[i];
		if (!prev || !curr) break;
		// Wrapped lines of one entry sit tight (≤ ~half a line apart); a gap
		// over a full line ends the bibliography. Entries of a range may sit
		// further apart.
		const gapLimit = isEntryStart(curr.text)
			? RANGE_ENTRY_GAP_PT
			: startLine.maxY - startLine.minY;
		if (curr.minY - prev.maxY > gapLimit) break;
		// The next entry starts — unless it is still inside the cited range.
		if (isEntryStart(curr.text)) {
			const n = range ? leadingEntryNumber(curr.text) : null;
			if (n == null || !range || n < range.start || n > range.end) break;
		}
		// Without a marker the entry uses a hanging indent; back at the
		// margin means a new paragraph / entry.
		if (
			!range &&
			!startHasMarker &&
			curr.minX <= baseLeftX + HANGING_INDENT_SLACK_PT &&
			i > startIdx + 1
		) {
			break;
		}
		// With a marker, continuation lines hang right of it; a non-entry line
		// back at the marker column is the text after the bibliography.
		if (
			startHasMarker &&
			!isEntryStart(curr.text) &&
			curr.minX <= baseLeftX + HANGING_INDENT_SLACK_PT
		) {
			break;
		}
		const maxHeight = range
			? Math.min(
					RANGE_MAX_HEIGHT_PT,
					RANGE_BASE_HEIGHT_PT + (range.end - range.start) * RANGE_PER_ENTRY_PT,
				)
			: ENTRY_MAX_HEIGHT_PT;
		if (curr.maxY - startLine.minY > maxHeight) break;
		entryLines.push(curr);
	}

	const minX = Math.min(...entryLines.map((l) => l.minX));
	const maxX = Math.max(...entryLines.map((l) => l.maxX));
	const minY = Math.min(...entryLines.map((l) => l.minY));
	const maxY = Math.max(...entryLines.map((l) => l.maxY));

	// Pad, but never into the neighbouring lines.
	const nextLine = lines[startIdx + entryLines.length];
	const prevLine = startIdx > 0 ? lines[startIdx - 1] : undefined;
	const rawCropTop = Math.max(0, minY - CROP_PAD_Y_PT);
	const rawCropBottom = Math.min(hPt, maxY + CROP_PAD_Y_PT);
	const cropTop =
		prevLine != null
			? Math.min(minY, Math.max(prevLine.maxY + 1, rawCropTop))
			: rawCropTop;
	const cropBottom =
		nextLine != null
			? Math.max(maxY, Math.min(nextLine.minY - 1, rawCropBottom))
			: rawCropBottom;
	const cropLeft = Math.max(0, minX - CROP_PAD_X_PT);
	const cropRight = Math.min(wPt, maxX + CROP_PAD_X_PT);

	const w = Math.min(CROP_MAX_W, (cropRight - cropLeft) / wPt);
	// The minimum height must not reach into the next entry.
	const maxBottom = nextLine != null ? nextLine.minY - 1 : hPt;
	const h = Math.min(
		Math.max(
			CROP_MIN_H,
			Math.min(
				range ? RANGE_CROP_MAX_H : CROP_MAX_H,
				(cropBottom - cropTop) / hPt,
			),
		),
		Math.max(cropBottom, maxBottom) / hPt - cropTop / hPt,
	);
	return {
		bbox: clampCrop(cropLeft / wPt, cropTop / hPt, w, h),
		entryMatched,
	};
}

/** Crop the layout region containing the anchor, clamped to one column. */
function cropFromLayout(
	pageIndex: number,
	regions: readonly PdfLayoutRegion[] | undefined,
	normX: number | null,
	normY: number,
): DestinationCropRegion["bbox"] | null {
	const containing = (regions ?? []).filter((r) => {
		if (r.pageIndex !== pageIndex) return false;
		const inY = normY >= r.bbox.y - 0.02 && normY <= r.bbox.y + r.bbox.h + 0.02;
		if (!inY) return false;
		if (normX == null) return true;
		return normX >= r.bbox.x - 0.02 && normX <= r.bbox.x + r.bbox.w + 0.02;
	});
	const region =
		normX != null && containing.length > 1
			? containing.reduce((best, r) =>
					Math.abs(r.bbox.x - normX) < Math.abs(best.bbox.x - normX) ? r : best,
				)
			: containing[0];
	if (!region || region.bbox.w < 0.2) return null;

	// Two columns only when a real right-hand column block exists (not a
	// narrow caption / figure in a single-column paper).
	const twoColumn =
		(regions ?? []).some(
			(r) =>
				r.pageIndex === pageIndex &&
				r !== region &&
				r.bbox.x >= 0.48 &&
				r.bbox.w >= 0.25 &&
				r.bbox.h >= 0.1,
		) ||
		(regions ?? []).some(
			(r) => r.bbox.x >= 0.48 && r.bbox.w >= 0.3 && r.bbox.h >= 0.15,
		);
	let x = region.bbox.x;
	let w = region.bbox.w;
	// A full-width region on a two-column page: keep the anchor's column only.
	if (twoColumn && w > 0.52) {
		if (normX != null && normX >= 0.48) {
			x = 0.5;
			w = 0.46;
		} else {
			x = Math.max(0.04, region.bbox.x);
			w = Math.min(0.44, 0.5 - x);
		}
	}
	const y = Math.max(0.01, normY - 0.015);
	return { x, y, w, h: Math.min(FALLBACK_H, PAGE_EDGE - y) };
}

/** Last resort: a strip below the anchor in its (guessed) column. */
function cropFromGeometry(
	regions: readonly PdfLayoutRegion[] | undefined,
	normX: number | null,
	normY: number,
): DestinationCropRegion["bbox"] {
	const y = Math.max(0.01, normY - 0.015);
	const h = Math.min(FALLBACK_H, PAGE_EDGE - y);
	let x = 0.06;
	let w = 0.88;
	if (normX != null) {
		if (normX >= 0.45) {
			x = Math.max(0.48, normX - 0.02);
			w = Math.min(0.46, PAGE_EDGE - x);
		} else if (hasTwoColumnRegions(regions) || normX > 0.05) {
			x = Math.max(0.04, normX - 0.02);
			w = Math.min(0.46, 0.48 - x + 0.02);
		}
	}
	return { x, y, w, h };
}

/**
 * Normalized crop for an internal link destination (an in-text citation whose
 * structured metadata lookup failed). Text rects isolate exactly the entry;
 * layout regions and column geometry are fallbacks.
 */
export function pickDestinationRegion({
	pageIndex,
	pdfX,
	pdfY,
	pageWidthPt,
	pageHeightPt,
	regions,
	textRects,
	entryIndex,
	endEntryIndex,
}: PickDestinationRegionOptions): DestinationCropRegion {
	const wPt = pageWidthPt > 0 ? pageWidthPt : DEFAULT_PAGE_WIDTH_PT;
	const hPt = pageHeightPt > 0 ? pageHeightPt : DEFAULT_PAGE_HEIGHT_PT;
	// pdfY is PDF space (origin bottom-left); text rects and renderPageRect use
	// device space (origin top-left).
	const targetYPt = hPt - (pdfY > 0 ? pdfY : hPt * 0.9);
	const normX = pdfX != null && pdfX > 0 ? clamp01(pdfX / wPt) : null;
	const normY = clamp01(targetYPt / hPt);

	if (textRects && textRects.length > 0) {
		const fromText = cropFromText(textRects, {
			wPt,
			hPt,
			targetYPt,
			normX,
			entryIndex,
			endEntryIndex,
		});
		if (fromText) return { pageIndex, ...fromText };
	}
	const bbox =
		cropFromLayout(pageIndex, regions, normX, normY) ??
		cropFromGeometry(regions, normX, normY);
	return { pageIndex, bbox, entryMatched: false };
}
