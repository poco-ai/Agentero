import { clamp01 } from "@/lib/core/math";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import {
	isAlgorithmLayoutKind,
	isCaptionLayoutKind,
	isFigureLayoutKind,
	isFormulaLayoutKind,
	isFormulaNumberLayoutKind,
	isLayoutBodyTextKind,
	isSidebarLayoutKind,
	isTableLayoutKind,
	isTextLayoutKind,
} from "@/lib/pdf/layout/labels";
import { resolveCaptionRole } from "@/lib/pdf/layout/title-text";
import type { PdfLayoutKind, PdfLayoutRegion } from "@/lib/pdf/layout/types";

/** Semantic family for layout hosts — never cross-attach captions across families. */
export type LayoutHostFamily = "figure" | "table" | "algorithm";

/** Where the caption usually sits relative to the host (paper convention). */
export type CaptionPlacement = "below" | "above";

/**
 * Shared geometry thresholds (normalized page coords 0–1).
 * Documented in docs/frontend/pdf-layout-analysis.md §规则清单.
 */
export const LAYOUT_MERGE = {
	/** Title width ≥ this → full-page multi-panel figure (take all band panels). */
	fullWidthTitle: 0.55,
	/**
	 * Max vertical reach above a *half-width* title when no previous caption ceiling.
	 * Full-width multi-row figures (e.g. 3×3 Fig 4) ignore this cap — only the
	 * previous main-caption ceiling bounds the band.
	 */
	maxHeightAboveTitle: 0.55,
	/**
	 * How far a panel bottom may extend past the title top and still count as
	 * “above” it. Full-width titles allow more (bottom-row charts often bleed
	 * into the caption box); half-width stays tight.
	 */
	panelBottomSlack: 0.04,
	fullWidthPanelBottomSlack: 0.14,
	/** Panel neighbor gap (gutter) for grid connectivity. */
	panelNeighborGap: 0.08,
	/** Orphan panel containment inside larger cluster → drop. */
	orphanContainment: 0.55,
	/** Max horizontal gap between formula body and formula_number. */
	formulaNumberMaxGap: 0.28,
	/**
	 * Vertical pad around formula_number when matching same-line bodies.
	 * Kept tight — no multi-line vertical grow into body text.
	 */
	formulaNumberBandPad: 0.02,
	/**
	 * Min model score for a `formula_number` box to start a merge.
	 * Aligns with sidebar gate; filters dual-label / margin noise (~0.01–0.05).
	 */
	formulaNumberMinScore: 0.3,
	/**
	 * Min score for a formula body to be a merge seed.
	 * Tiny score~0.02 fragments next to the number would otherwise win seed sort.
	 */
	formulaBodyMinScore: 0.3,
	/**
	 * Max normalized height of a formula body seed.
	 * Taller boxes are usually paragraph dual-labels / stacked inline math,
	 * not a single display equation line.
	 */
	formulaMaxBodyHeight: 0.055,
	/**
	 * Page midline for two-column reading order (left column before right).
	 * Equation numbers sit on the outer edge of each column; center-x vs mid
	 * is enough for typical academic PDFs.
	 */
	columnMidX: 0.5,
	/**
	 * Drop image/chart when this fraction of its area is covered by a confident
	 * text/header/abstract box (dual-label or text misclassified as figure).
	 */
	figureTextCover: 0.55,
	/** Min score for text/header/abstract to veto a figure detection. */
	figureTextMinScore: 0.3,
} as const;

/**
 * 0 = left column, 1 = right column (two-column page reading order).
 * Single-column papers usually put numbers on the right → all col 1 → sort by y.
 */
export function layoutReadingColumn(
	bbox: PdfAskNormalizedRect,
	midX: number = LAYOUT_MERGE.columnMidX,
): 0 | 1 {
	return bbox.x + bbox.w / 2 < midX ? 0 : 1;
}

/** Prefer equation-number box for column/y order when present. */
export function formulaSortAnchor(
	region: PdfLayoutRegion,
): PdfAskNormalizedRect {
	return region.titleBbox ?? region.bbox;
}

/**
 * Reading order for layout hosts: page → left column → right column → top→bottom.
 * Matches equation-number sequence on two-column papers better than raw y-only.
 */
export function compareLayoutReadingOrder(
	a: PdfLayoutRegion,
	b: PdfLayoutRegion,
	anchor: (r: PdfLayoutRegion) => PdfAskNormalizedRect = (r) => r.bbox,
): number {
	const aa = anchor(a);
	const ba = anchor(b);
	return (
		a.pageIndex - b.pageIndex ||
		layoutReadingColumn(aa) - layoutReadingColumn(ba) ||
		aa.y - ba.y ||
		aa.x - ba.x ||
		a.readingOrder - b.readingOrder
	);
}

/**
 * True when a confident text/header/abstract box covers most of `box`.
 * Used to reject image/chart dual-labels on pure text blocks.
 */
export function figureCoveredByBodyText(
	box: PdfAskNormalizedRect,
	pageIndex: number,
	bodyBlocks: readonly PdfLayoutRegion[],
	coverThreshold: number = LAYOUT_MERGE.figureTextCover,
): boolean {
	for (const t of bodyBlocks) {
		if (t.pageIndex !== pageIndex) continue;
		if (!isLayoutBodyTextKind(t.kind)) continue;
		if (t.score < LAYOUT_MERGE.figureTextMinScore) continue;
		if (bboxCoveredBy(box, t.bbox) >= coverThreshold) return true;
	}
	return false;
}

/**
 * Drop image/chart detections that are really text/header regions.
 * Model often dual-labels section titles and paragraphs as low/mid image;
 * pure text+header areas must not surface as figures (sidebar or Eye overlay).
 */
export function suppressSpuriousFigureDetections(
	regions: readonly PdfLayoutRegion[],
): PdfLayoutRegion[] {
	const bodyBlocks = regions.filter(
		(r) =>
			isLayoutBodyTextKind(r.kind) &&
			r.score >= LAYOUT_MERGE.figureTextMinScore,
	);
	if (!bodyBlocks.length) return [...regions];

	return regions.filter((r) => {
		if (!isFigureLayoutKind(r.kind)) return true;
		// Strong figure boxes that beat overlapping body text stay.
		// Veto when body text covers most of the box (same area dual-label / wrap).
		if (!figureCoveredByBodyText(r.bbox, r.pageIndex, bodyBlocks)) {
			return true;
		}
		// If a body block covers us, only keep the figure when it is clearly
		// more confident than every covering body block.
		for (const t of bodyBlocks) {
			if (t.pageIndex !== r.pageIndex) continue;
			if (bboxCoveredBy(r.bbox, t.bbox) < LAYOUT_MERGE.figureTextCover) {
				continue;
			}
			// Body is competitive or stronger → not a real figure.
			if (t.score >= r.score * 0.85) return false;
		}
		return true;
	});
}

export function unionBbox(
	a: PdfAskNormalizedRect,
	b: PdfAskNormalizedRect,
): PdfAskNormalizedRect {
	const x1 = Math.min(a.x, b.x);
	const y1 = Math.min(a.y, b.y);
	const x2 = Math.max(a.x + a.w, b.x + b.w);
	const y2 = Math.max(a.y + a.h, b.y + b.h);
	return {
		x: clamp01(x1),
		y: clamp01(y1),
		w: clamp01(x2 - x1),
		h: clamp01(y2 - y1),
	};
}

function unionMany(boxes: PdfAskNormalizedRect[]): PdfAskNormalizedRect | null {
	if (!boxes.length) return null;
	return boxes.reduce((acc, b) => unionBbox(acc, b));
}

function unionRect(
	a: PdfLayoutRegion["rect"],
	b: PdfLayoutRegion["rect"],
): PdfLayoutRegion["rect"] {
	const x1 = Math.min(a.x, b.x);
	const y1 = Math.min(a.y, b.y);
	const x2 = Math.max(a.x + a.w, b.x + b.w);
	const y2 = Math.max(a.y + a.h, b.y + b.h);
	return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function horizontalOverlapRatio(
	a: PdfAskNormalizedRect,
	b: PdfAskNormalizedRect,
): number {
	const ax2 = a.x + a.w;
	const bx2 = b.x + b.w;
	const ix1 = Math.max(a.x, b.x);
	const ix2 = Math.min(ax2, bx2);
	const inter = Math.max(0, ix2 - ix1);
	const denom = Math.min(a.w, b.w);
	return denom > 0 ? inter / denom : 0;
}

function verticalOverlapRatio(
	a: PdfAskNormalizedRect,
	b: PdfAskNormalizedRect,
): number {
	const ay2 = a.y + a.h;
	const by2 = b.y + b.h;
	const iy1 = Math.max(a.y, b.y);
	const iy2 = Math.min(ay2, by2);
	const inter = Math.max(0, iy2 - iy1);
	const denom = Math.min(a.h, b.h);
	return denom > 0 ? inter / denom : 0;
}

function expandBbox(
	b: PdfAskNormalizedRect,
	padX: number,
	padY = 0,
): PdfAskNormalizedRect {
	const x = clamp01(b.x - padX);
	const y = clamp01(b.y - padY);
	const x2 = clamp01(b.x + b.w + padX);
	const y2 = clamp01(b.y + b.h + padY);
	return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

export function hostFamily(kind: PdfLayoutKind): LayoutHostFamily | null {
	if (isFigureLayoutKind(kind)) return "figure";
	if (isTableLayoutKind(kind)) return "table";
	if (isAlgorithmLayoutKind(kind)) return "algorithm";
	return null;
}

export function preferredCaptionPlacement(
	family: LayoutHostFamily,
): CaptionPlacement {
	switch (family) {
		case "figure":
			return "below";
		case "table":
		case "algorithm":
			return "above";
	}
}

export function captionCompatibleWithHost(
	captionKind: PdfLayoutKind,
	family: LayoutHostFamily,
	role?: PdfLayoutRegion["captionRole"],
): boolean {
	const r = role ?? "other";
	if (r === "table_main") return family === "table";
	if (r === "algorithm_main") return family === "algorithm";
	if (r === "figure_main") return family === "figure";
	if (r === "subpanel") return family === "figure";
	// Unclassified model labels:
	if (captionKind === "figure_title") return family === "figure";
	if (captionKind === "header") return true;
	return false;
}

/** Main whole-figure anchors only (not Table/Algorithm, not (a)(b)). */
export function isMainFigureCaption(c: PdfLayoutRegion): boolean {
	const role = resolveCaptionRole(c);
	if (role === "table_main" || role === "algorithm_main" || role === "subpanel")
		return false;
	if (role === "figure_main") return true;
	// No text: wide figure_title only.
	return c.kind === "figure_title" && c.bbox.w >= 0.4;
}

export function isMainTableCaption(c: PdfLayoutRegion): boolean {
	return resolveCaptionRole(c) === "table_main";
}

export function isMainAlgorithmCaption(c: PdfLayoutRegion): boolean {
	return resolveCaptionRole(c) === "algorithm_main";
}

export function isSubpanelCaption(c: PdfLayoutRegion): boolean {
	return resolveCaptionRole(c) === "subpanel";
}

/**
 * Vertical band for a main figure title: from previous main caption bottom
 * down to this title top (prevents Fig 6/7/8 vertical over-merge).
 */
export function verticalCeilingForTitle(
	title: PdfLayoutRegion,
	mainCaptions: PdfLayoutRegion[],
): number {
	let ceiling = 0;
	for (const other of mainCaptions) {
		if (other.id === title.id) continue;
		if (other.pageIndex !== title.pageIndex) continue;
		const otherBottom = other.bbox.y + other.bbox.h;
		// Captions strictly above this title.
		if (otherBottom <= title.bbox.y + 0.01) {
			ceiling = Math.max(ceiling, otherBottom);
		}
	}
	return ceiling;
}

/**
 * Side-by-side Fig 7 | Fig 8: panel must sit in the title's column
 * unless the title is full-width (联图 spanning whole page).
 */
export function panelInTitleColumn(
	panel: PdfAskNormalizedRect,
	title: PdfAskNormalizedRect,
): boolean {
	// Full-width caption → any column under it.
	if (title.w >= LAYOUT_MERGE.fullWidthTitle) {
		const span = expandBbox(title, 0.08);
		const cx = panel.x + panel.w / 2;
		return cx >= span.x - 0.02 && cx <= span.x + span.w + 0.02;
	}
	const pad = 0.06;
	const cx = panel.x + panel.w / 2;
	return cx >= title.x - pad && cx <= title.x + title.w + pad;
}

export function areFigureNeighbors(
	a: PdfAskNormalizedRect,
	b: PdfAskNormalizedRect,
	maxGap = LAYOUT_MERGE.panelNeighborGap,
): boolean {
	const ax2 = a.x + a.w;
	const ay2 = a.y + a.h;
	const bx2 = b.x + b.w;
	const by2 = b.y + b.h;
	const hGap = Math.max(0, Math.max(a.x - bx2, b.x - ax2));
	const vGap = Math.max(0, Math.max(a.y - by2, b.y - ay2));
	const hOv = horizontalOverlapRatio(a, b);
	const vOv = verticalOverlapRatio(a, b);
	if (hGap <= maxGap && vOv >= 0.15) return true;
	if (vGap <= maxGap && hOv >= 0.15) return true;
	if (hGap <= maxGap && vGap <= maxGap) return true;
	if (hGap === 0 && vGap === 0) return true;
	return false;
}

export function connectedPanelGroups(
	panels: PdfLayoutRegion[],
): PdfLayoutRegion[][] {
	if (!panels.length) return [];
	const n = panels.length;
	const parent = Array.from({ length: n }, (_, i) => i);
	const find = (i: number): number => {
		let x = i;
		while (parent[x] !== x) {
			parent[x] = parent[parent[x]];
			x = parent[x];
		}
		return x;
	};
	const unite = (i: number, j: number) => {
		const ri = find(i);
		const rj = find(j);
		if (ri !== rj) parent[ri] = rj;
	};
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			if (areFigureNeighbors(panels[i].bbox, panels[j].bbox)) {
				unite(i, j);
			}
		}
	}
	const map = new Map<number, PdfLayoutRegion[]>();
	for (let i = 0; i < n; i++) {
		const r = find(i);
		const list = map.get(r);
		if (list) list.push(panels[i]);
		else map.set(r, [panels[i]]);
	}
	return [...map.values()];
}

export function captionAttachScore(
	host: PdfAskNormalizedRect,
	caption: PdfAskNormalizedRect,
	preferred: CaptionPlacement = "below",
): number {
	const hOverlap = horizontalOverlapRatio(host, caption);
	if (hOverlap < 0.2) return Number.NEGATIVE_INFINITY;
	if (caption.h > 0.2) return Number.NEGATIVE_INFINITY;

	const hostBottom = host.y + host.h;
	const capBottom = caption.y + caption.h;
	const gapBelow = caption.y - hostBottom;
	const gapAbove = host.y - capBottom;

	const belowOk = gapBelow >= -0.02 && gapBelow <= 0.12;
	const aboveOk = gapAbove >= -0.02 && gapAbove <= 0.1;

	if (preferred === "below") {
		if (!belowOk) return Number.NEGATIVE_INFINITY;
		return hOverlap * 2 + 0.2 - Math.abs(gapBelow) * 8;
	}
	if (!aboveOk) return Number.NEGATIVE_INFINITY;
	return hOverlap * 2 + 0.2 - Math.abs(gapAbove) * 8;
}

/**
 * image/chart panels in the vertical band (ceiling → title) and title column.
 *
 * Full-width Figure N titles (3×3 / multi-row):
 * - no soft maxHeightAbove (tall figures keep the top row)
 * - looser bottom slack so bottom-row charts that bleed into the caption stay in
 * Half-width: keep tight height + bottom slack so Fig7|Fig8 do not over-merge.
 */
export function panelsAboveTitle(
	title: PdfLayoutRegion,
	panels: PdfLayoutRegion[],
	options?: {
		/** Bottom of previous main caption (exclusive band start). */
		ceiling?: number;
		maxHeightAbove?: number;
		/** Override full-width treatment (default: title.bbox.w ≥ fullWidthTitle). */
		fullWidth?: boolean;
	},
): PdfLayoutRegion[] {
	const fullWidth =
		options?.fullWidth ?? title.bbox.w >= LAYOUT_MERGE.fullWidthTitle;
	const ceiling = options?.ceiling ?? 0;
	const maxHeightAbove =
		options?.maxHeightAbove ??
		(fullWidth ? Number.POSITIVE_INFINITY : LAYOUT_MERGE.maxHeightAboveTitle);
	const bottomSlack = fullWidth
		? LAYOUT_MERGE.fullWidthPanelBottomSlack
		: LAYOUT_MERGE.panelBottomSlack;
	const titleTop = title.bbox.y;
	const titleBottom = title.bbox.y + title.bbox.h;

	return panels.filter((p) => {
		if (!isFigureLayoutKind(p.kind)) return false;
		if (p.pageIndex !== title.pageIndex) return false;
		if (!panelInTitleColumn(p.bbox, title.bbox)) return false;

		const pBottom = p.bbox.y + p.bbox.h;
		const pCy = p.bbox.y + p.bbox.h / 2;
		// Panel must start above the title (not a box sitting under the caption).
		if (p.bbox.y >= titleTop - 0.005) return false;
		// Center of mass should not sit deep inside the caption strip.
		if (pCy >= titleBottom - 0.01) return false;
		// Bottom edge may slightly overlap the caption (model bleed).
		if (pBottom > titleTop + bottomSlack) {
			// Full-width: still accept if most of the panel is above the title.
			if (!(fullWidth && titleTop - p.bbox.y >= p.bbox.h * 0.35)) {
				return false;
			}
		}
		// Not above the previous main caption (avoid multi-figure stack merge).
		if (p.bbox.y + 0.01 < ceiling) return false;
		// Soft max height only for half-width titles without a ceiling.
		if (
			ceiling <= 0 &&
			Number.isFinite(maxHeightAbove) &&
			titleTop - p.bbox.y > maxHeightAbove
		) {
			return false;
		}
		return true;
	});
}

/**
 * Full-width caption (e.g. Figure 2 / Figure 4): take every panel in the
 * vertical band — connectivity is optional (image/chart gaps, mixed kinds).
 * Half-width caption (side-by-side Fig 7 | Fig 8): column + connectivity.
 */
export function selectClusterForTitle(
	title: PdfLayoutRegion,
	panels: PdfLayoutRegion[],
	mainFigureCaptions: PdfLayoutRegion[],
): PdfLayoutRegion[] {
	const ceiling = verticalCeilingForTitle(title, mainFigureCaptions);
	const fullWidth = title.bbox.w >= LAYOUT_MERGE.fullWidthTitle;
	const figurePanels = panels.filter((p) => isFigureLayoutKind(p.kind));
	const candidates = panelsAboveTitle(title, figurePanels, {
		ceiling,
		fullWidth,
	});
	if (!candidates.length) return [];

	// ── Pattern A: full-width multi-panel figure under one caption ──
	if (fullWidth) {
		return candidates;
	}

	// ── Pattern B: column figure — only panels in this title's column ──
	const inColumn = candidates.filter((g) =>
		panelInTitleColumn(g.bbox, title.bbox),
	);
	const pool = inColumn.length ? inColumn : candidates;
	const groups = connectedPanelGroups(pool);
	if (!groups.length) return pool;

	let best: PdfLayoutRegion[] = groups[0];
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const group of groups) {
		const body = unionMany(group.map((g) => g.bbox));
		if (!body) continue;
		const bodyBottom = body.y + body.h;
		const gap = title.bbox.y - bodyBottom;
		const hOv = horizontalOverlapRatio(body, title.bbox);
		const gapScore = gap >= -0.04 && gap <= 0.12 ? 1 - Math.abs(gap) * 6 : -2;
		const score = group.length * 0.35 + hOv * 2.5 + gapScore;
		if (score > bestScore) {
			bestScore = score;
			best = group;
		}
	}
	return best;
}

/** True if outer fully covers inner (title must never stick out of the figure box). */
export function bboxFullyContains(
	outer: PdfAskNormalizedRect,
	inner: PdfAskNormalizedRect,
	eps = 0.005,
): boolean {
	return (
		outer.x <= inner.x + eps &&
		outer.y <= inner.y + eps &&
		outer.x + outer.w >= inner.x + inner.w - eps &&
		outer.y + outer.h >= inner.y + inner.h - eps
	);
}

/**
 * Build figure bbox = panels (optionally column-clipped) ∪ **entire** title.
 * Rule: figure_title must always be 100% inside the host box — never half-in.
 */
export function buildFigureBboxWithFullTitle(
	panelBoxes: PdfAskNormalizedRect[],
	title: PdfAskNormalizedRect,
	legendBoxes: PdfAskNormalizedRect[] = [],
): PdfAskNormalizedRect {
	// 1) Always start from the full title (hard requirement).
	let bbox: PdfAskNormalizedRect = { ...title };

	// 2) Union panels; for half-width titles only include x-overlap with title column.
	const halfWidth = title.w < LAYOUT_MERGE.fullWidthTitle;
	const col = expandBbox(title, 0.05, 0);
	for (const p of panelBoxes) {
		if (halfWidth) {
			// Drop panels that barely touch this column (belong to the other figure).
			if (horizontalOverlapRatio(p, col) < 0.2) {
				const cx = p.x + p.w / 2;
				if (cx < col.x || cx > col.x + col.w) continue;
			}
		}
		bbox = unionBbox(bbox, p);
	}
	for (const leg of legendBoxes) {
		if (halfWidth && horizontalOverlapRatio(leg, col) < 0.15) continue;
		bbox = unionBbox(bbox, leg);
	}

	// 3) Force title fully inside again (in case of any numerical drift).
	bbox = unionBbox(bbox, title);
	return bbox;
}

/**
 * @deprecated Use buildFigureBboxWithFullTitle — never clip title out of the box.
 */
export function clipFigureBboxToTitleColumn(
	bbox: PdfAskNormalizedRect,
	title: PdfAskNormalizedRect,
): PdfAskNormalizedRect {
	// Preserve full title; only used as a soft body clamp then re-union title.
	return buildFigureBboxWithFullTitle([bbox], title);
}

function isHalfWidthFigureHost(h: PdfLayoutRegion): boolean {
	const tw = h.titleBbox?.w ?? h.bbox.w;
	return tw < LAYOUT_MERGE.fullWidthTitle;
}

/**
 * Soft-split side-by-side half-width figures only.
 * After any body clip, re-union the **entire** titleBbox so the caption is never half-out.
 */
export function resolveFigureBboxOverlaps(
	hosts: PdfLayoutRegion[],
): PdfLayoutRegion[] {
	const out = hosts.map((h) => ({ ...h, bbox: { ...h.bbox } }));
	for (let i = 0; i < out.length; i++) {
		for (let j = i + 1; j < out.length; j++) {
			const a = out[i];
			const b = out[j];
			if (!isFigureLayoutKind(a.kind) || !isFigureLayoutKind(b.kind)) continue;
			if (a.pageIndex !== b.pageIndex) continue;
			if (!isHalfWidthFigureHost(a) || !isHalfWidthFigureHost(b)) continue;

			const ax2 = a.bbox.x + a.bbox.w;
			const bx2 = b.bbox.x + b.bbox.w;
			const overlap = Math.min(ax2, bx2) - Math.max(a.bbox.x, b.bbox.x);
			if (overlap <= 0.02) continue;

			const acx = a.titleBbox
				? a.titleBbox.x + a.titleBbox.w / 2
				: a.bbox.x + a.bbox.w / 2;
			const bcx = b.titleBbox
				? b.titleBbox.x + b.titleBbox.w / 2
				: b.bbox.x + b.bbox.w / 2;
			const mid = (acx + bcx) / 2;
			const left = acx <= bcx ? a : b;
			const rightHost = acx <= bcx ? b : a;

			const lRight = Math.min(left.bbox.x + left.bbox.w, mid - 0.005);
			if (lRight > left.bbox.x + 0.12) {
				left.bbox = { ...left.bbox, w: lRight - left.bbox.x };
			}
			const rLeft = Math.max(rightHost.bbox.x, mid + 0.005);
			const rRight = rightHost.bbox.x + rightHost.bbox.w;
			if (rRight > rLeft + 0.12) {
				rightHost.bbox = {
					...rightHost.bbox,
					x: rLeft,
					w: rRight - rLeft,
				};
			}
			// Hard rule: full figure_title must stay inside each host box.
			if (left.titleBbox) {
				left.bbox = unionBbox(left.bbox, left.titleBbox);
			}
			if (rightHost.titleBbox) {
				rightHost.bbox = unionBbox(rightHost.bbox, rightHost.titleBbox);
			}
		}
	}
	return out;
}

/**
 * Drop orphan figure panels that sit inside a larger clustered figure
 * (leftover panel (d) after Fig 2 联图 would otherwise fight mid-split).
 */
export function suppressOrphanFiguresInsideClusters(
	hosts: PdfLayoutRegion[],
): PdfLayoutRegion[] {
	const figures = hosts.filter((h) => isFigureLayoutKind(h.kind));
	const drop = new Set<string>();
	for (const small of figures) {
		for (const big of figures) {
			if (small.id === big.id) continue;
			if (small.pageIndex !== big.pageIndex) continue;
			// Prefer keeping titled/full-width clusters over bare panel leftovers.
			const bigIsCluster =
				(big.titleBbox?.w ?? 0) >= 0.5 || Boolean(big.title?.match(/^fig/i));
			const smallIsOrphan = !small.titleBbox || (small.titleBbox.w ?? 1) < 0.4;
			if (!bigIsCluster || !smallIsOrphan) continue;
			const cont = (() => {
				const a = small.bbox;
				const b = big.bbox;
				const ix1 = Math.max(a.x, b.x);
				const iy1 = Math.max(a.y, b.y);
				const ix2 = Math.min(a.x + a.w, b.x + b.w);
				const iy2 = Math.min(a.y + a.h, b.y + b.h);
				const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
				const area = a.w * a.h;
				return area > 0 ? inter / area : 0;
			})();
			if (cont >= LAYOUT_MERGE.orphanContainment) drop.add(small.id);
		}
	}
	return hosts.filter((h) => !drop.has(h.id));
}

function attachLegendHeaders(
	clusterBbox: PdfAskNormalizedRect,
	title: PdfLayoutRegion,
	headers: PdfLayoutRegion[],
	pageIndex: number,
	blockers: PdfLayoutRegion[],
): PdfLayoutRegion[] {
	return headers.filter((h) => {
		if (h.pageIndex !== pageIndex) return false;
		// Never treat table/algorithm captions as figure legends.
		const role = resolveCaptionRole(h);
		if (role === "table_main" || role === "algorithm_main") return false;
		if (role === "subpanel") return false;
		if (h.bbox.h > 0.12) return false;
		const hCy = h.bbox.y + h.bbox.h / 2;
		const bandTop = clusterBbox.y - 0.04;
		const bandBottom = title.bbox.y + title.bbox.h;
		if (hCy < bandTop || hCy > bandBottom) return false;
		const span = expandBbox(unionBbox(clusterBbox, title.bbox), 0.06);
		if (horizontalOverlapRatio(h.bbox, span) < 0.2) return false;
		for (const b of blockers) {
			if (b.pageIndex !== pageIndex) continue;
			const fam = hostFamily(b.kind);
			if (fam !== "table" && fam !== "algorithm") continue;
			const s = captionAttachScore(
				b.bbox,
				h.bbox,
				preferredCaptionPlacement(fam),
			);
			if (Number.isFinite(s) && s > 0.5) return false;
		}
		return true;
	});
}

/**
 * Fold (a)(b) subpanel titles into the nearest figure panel above them.
 */
function absorbSubpanelTitles(
	panels: PdfLayoutRegion[],
	subpanels: PdfLayoutRegion[],
): { panels: PdfLayoutRegion[]; usedSubIds: Set<string> } {
	const usedSubIds = new Set<string>();
	const next = panels.map((p) => ({ ...p }));

	for (const sub of subpanels) {
		let best: { idx: number; score: number } | null = null;
		for (let i = 0; i < next.length; i++) {
			const p = next[i];
			if (p.pageIndex !== sub.pageIndex) continue;
			if (!isFigureLayoutKind(p.kind)) continue;
			const score = captionAttachScore(p.bbox, sub.bbox, "below");
			if (!Number.isFinite(score)) continue;
			// Prefer subpanel whose width matches the panel.
			const wScore = horizontalOverlapRatio(p.bbox, sub.bbox);
			const total = score + wScore;
			if (!best || total > best.score) best = { idx: i, score: total };
		}
		if (!best) continue;
		const host = next[best.idx];
		next[best.idx] = {
			...host,
			bbox: unionBbox(host.bbox, sub.bbox),
			rect: unionRect(host.rect, sub.rect),
		};
		usedSubIds.add(sub.id);
	}
	return { panels: next, usedSubIds };
}

function mergeCluster(
	panels: PdfLayoutRegion[],
	title: PdfLayoutRegion,
	legends: PdfLayoutRegion[],
	extra: PdfLayoutRegion[] = [],
): PdfLayoutRegion {
	const panelBoxes = [...panels, ...extra].map((p) => p.bbox);
	const legendBoxes = legends.map((l) => l.bbox);
	// Title is always fully contained — never half-in / half-out.
	const bbox = buildFigureBboxWithFullTitle(
		panelBoxes,
		title.bbox,
		legendBoxes,
	);

	let rect = title.rect;
	for (const p of panels) rect = unionRect(rect, p.rect);
	for (const p of legends) rect = unionRect(rect, p.rect);
	for (const p of extra) rect = unionRect(rect, p.rect);

	const chartCount = panels.filter((p) => p.kind === "chart").length;
	const kind: PdfLayoutKind =
		chartCount >= panels.length / 2 ? "chart" : (panels[0]?.kind ?? "image");
	const score = Math.max(
		title.score,
		...panels.map((p) => p.score),
		...legends.map((p) => p.score),
		0,
	);
	const readingOrder = Math.min(
		title.readingOrder,
		...panels.map((p) => p.readingOrder),
	);
	return {
		id: title.id,
		pageIndex: title.pageIndex,
		kind,
		label: kind,
		score,
		readingOrder,
		rect,
		bbox,
		titleBbox: title.bbox,
		title: title.title,
		captionRole: "figure_main",
	};
}

function attachCaptionToHost(
	host: PdfLayoutRegion,
	caption: PdfLayoutRegion,
): PdfLayoutRegion {
	// Always expand host so the entire caption sits inside the box.
	const bbox = unionBbox(host.bbox, caption.bbox);
	return {
		...host,
		bbox,
		rect: unionRect(host.rect, caption.rect),
		titleBbox: caption.bbox,
		title: caption.title ?? host.title,
	};
}

/**
 * Every figure must have a title fully inside its box.
 * - No titleBbox → drop (panel without Figure N caption = mis-clustered)
 * - Title sticks out → expand bbox to cover full title
 */
export function requireFigureTitles(
	hosts: PdfLayoutRegion[],
): PdfLayoutRegion[] {
	const result: PdfLayoutRegion[] = [];
	for (const h of hosts) {
		if (!isFigureLayoutKind(h.kind)) {
			result.push(h);
			continue;
		}
		if (!h.titleBbox) continue;
		let bbox = h.bbox;
		if (!bboxFullyContains(bbox, h.titleBbox)) {
			bbox = unionBbox(bbox, h.titleBbox);
		}
		if (!bboxFullyContains(bbox, h.titleBbox)) continue;
		result.push({ ...h, bbox });
	}
	return result;
}

function pairCaptionsOneToOne(
	hosts: PdfLayoutRegion[],
	captions: PdfLayoutRegion[],
	familyFilter: LayoutHostFamily,
): Map<string, PdfLayoutRegion> {
	type Pair = { hostId: string; caption: PdfLayoutRegion; score: number };
	const pairs: Pair[] = [];
	const preferred = preferredCaptionPlacement(familyFilter);

	for (const host of hosts) {
		const family = hostFamily(host.kind);
		if (family !== familyFilter) continue;
		for (const caption of captions) {
			if (caption.pageIndex !== host.pageIndex) continue;
			const role = resolveCaptionRole(caption);
			if (!captionCompatibleWithHost(caption.kind, family, role)) continue;
			// Subpanels handled separately.
			if (role === "subpanel") continue;

			const place =
				role === "figure_main"
					? "below"
					: role === "table_main" || role === "algorithm_main"
						? "above"
						: preferred;

			const spatial = captionAttachScore(host.bbox, caption.bbox, place);
			if (!Number.isFinite(spatial)) continue;

			let score = spatial + caption.score * 0.1;
			if (role === "figure_main" && family === "figure") score += 0.8;
			if (role === "table_main" && family === "table") score += 0.8;
			if (role === "algorithm_main" && family === "algorithm") score += 0.8;
			// Don't let mislabeled figure_title win over tables if role is table.
			if (role === "table_main" && caption.kind === "figure_title")
				score += 0.5;

			pairs.push({ hostId: host.id, caption, score });
		}
	}

	pairs.sort((a, b) => b.score - a.score);
	const captionUsed = new Set<string>();
	const hostCaption = new Map<string, PdfLayoutRegion>();
	for (const pair of pairs) {
		if (captionUsed.has(pair.caption.id)) continue;
		if (hostCaption.has(pair.hostId)) continue;
		captionUsed.add(pair.caption.id);
		hostCaption.set(pair.hostId, pair.caption);
	}
	return hostCaption;
}

/** How much of `box` is covered by intersection with `other` (0–1). */
export function bboxCoveredBy(
	box: PdfAskNormalizedRect,
	other: PdfAskNormalizedRect,
): number {
	const ax2 = box.x + box.w;
	const ay2 = box.y + box.h;
	const bx2 = other.x + other.w;
	const by2 = other.y + other.h;
	const ix1 = Math.max(box.x, other.x);
	const iy1 = Math.max(box.y, other.y);
	const ix2 = Math.min(ax2, bx2);
	const iy2 = Math.min(ay2, by2);
	const iw = Math.max(0, ix2 - ix1);
	const ih = Math.max(0, iy2 - iy1);
	const inter = iw * ih;
	const area = box.w * box.h;
	return area > 0 ? inter / area : 0;
}

/**
 * Collect formula bodies for one formula_number (number-first, same-line only).
 *
 * - No multi-line vertical grow: stacked / interline body-text formulas must
 *   not be unioned into the display equation (they swallow paragraphs).
 * - Only short, confident bodies left of the number on the same baseline band.
 * - Same-line fragments may still merge when they heavily overlap the seed.
 */
export function selectFormulasForNumber(
	number: PdfLayoutRegion,
	formulas: PdfLayoutRegion[],
): PdfLayoutRegion[] {
	const pad = LAYOUT_MERGE.formulaNumberBandPad;
	const maxGap = LAYOUT_MERGE.formulaNumberMaxGap;
	const num = number.bbox;
	const numCy = num.y + num.h / 2;
	// Band height locked to the number box — never scale with a tall body.
	const halfBand = Math.max(num.h, 0.012) * 0.75 + pad;

	const eligible = (f: PdfLayoutRegion): boolean => {
		if (f.pageIndex !== number.pageIndex) return false;
		// Seeds must be confident formula bodies — not score~0.02 dual-label scraps.
		if (f.score < LAYOUT_MERGE.formulaBodyMinScore) return false;
		// Reject paragraph-tall "formula" mislabels / multi-line text blocks.
		if (f.bbox.h > LAYOUT_MERGE.formulaMaxBodyHeight) return false;
		const fRight = f.bbox.x + f.bbox.w;
		const fCy = f.bbox.y + f.bbox.h / 2;
		// Mostly left of the number (equation body, not another margin tag).
		if (f.bbox.x >= num.x + num.w * 0.5) return false;
		const gap = num.x - fRight;
		if (gap > maxGap) return false;
		if (gap < -0.12) return false; // heavy overlap with number box → skip
		const vOv = verticalOverlapRatio(f.bbox, expandBbox(num, 0, pad));
		const inBand = Math.abs(fCy - numCy) <= halfBand;
		return vOv >= 0.2 || inBand;
	};

	const seeds = formulas.filter(eligible);
	if (!seeds.length) return [];

	// Prefer highest-confidence body, then closest to the number.
	// (dy-first used to pick tiny margin scraps next to the number box.)
	seeds.sort((a, b) => {
		const aGap = Math.abs(num.x - (a.bbox.x + a.bbox.w));
		const bGap = Math.abs(num.x - (b.bbox.x + b.bbox.w));
		const aDy = Math.abs(a.bbox.y + a.bbox.h / 2 - numCy);
		const bDy = Math.abs(b.bbox.y + b.bbox.h / 2 - numCy);
		const aArea = a.bbox.w * a.bbox.h;
		const bArea = b.bbox.w * b.bbox.h;
		return b.score - a.score || bArea - aArea || aDy - bDy || aGap - bGap;
	});

	// Same-line fragments only — never grow to lines above/below (body text).
	const chosen = new Set<string>([seeds[0]!.id]);
	for (const s of seeds) {
		if (verticalOverlapRatio(s.bbox, seeds[0]!.bbox) >= 0.35) {
			chosen.add(s.id);
		}
	}

	return formulas.filter((f) => chosen.has(f.id));
}

function mergeFormulaCluster(
	formulas: PdfLayoutRegion[],
	number: PdfLayoutRegion,
): PdfLayoutRegion {
	let bbox = number.bbox;
	let rect = number.rect;
	for (const f of formulas) {
		bbox = unionBbox(bbox, f.bbox);
		rect = unionRect(rect, f.rect);
	}
	// Ensure full number box is inside host (same rule as figure titles).
	if (!bboxFullyContains(bbox, number.bbox)) {
		bbox = unionBbox(bbox, number.bbox);
	}
	const score = Math.max(number.score, ...formulas.map((f) => f.score), 0);
	const readingOrder = Math.min(
		number.readingOrder,
		...formulas.map((f) => f.readingOrder),
	);
	// No equation-id text parse: host has geometry only; sidebar uses fallback label.
	return {
		id: number.id,
		pageIndex: number.pageIndex,
		kind: "formula",
		label: "formula",
		score,
		readingOrder,
		rect,
		bbox,
		titleBbox: number.bbox,
	};
}

/**
 * Number-first formula aggregation (geometry-only):
 * - Only model `formula_number` anchors with score ≥ formulaNumberMinScore
 * - Drop unnumbered formulas and bare / low-score numbers
 * - No text-overlap gate (paragraph text boxes routinely contain display eqs;
 *   dual-label low-score `text` on the same bbox used to kill all merges)
 * - Does **not** parse equation number strings onto `title`
 */
export function mergeFormulasByNumber(
	regions: PdfLayoutRegion[],
): PdfLayoutRegion[] {
	const formulas = regions.filter((r) => isFormulaLayoutKind(r.kind));
	const numbers = regions.filter(
		(r) =>
			isFormulaNumberLayoutKind(r.kind) &&
			r.score >= LAYOUT_MERGE.formulaNumberMinScore,
	);
	const rest = regions.filter(
		(r) =>
			!isFormulaLayoutKind(r.kind) &&
			!isFormulaNumberLayoutKind(r.kind) &&
			!isTextLayoutKind(r.kind),
	);

	const usedFormulaIds = new Set<string>();
	const merged: PdfLayoutRegion[] = [];

	// Process numbers in reading order so eq sequence is stable (two-column aware).
	const sortedNumbers = [...numbers].sort((a, b) =>
		compareLayoutReadingOrder(a, b),
	);

	for (const num of sortedNumbers) {
		const free = formulas.filter((f) => !usedFormulaIds.has(f.id));
		const cluster = selectFormulasForNumber(num, free);
		if (!cluster.length) continue;

		const host = mergeFormulaCluster(cluster, num);
		merged.push(host);
		for (const f of cluster) usedFormulaIds.add(f.id);
	}

	// Bare formula without model formula_number box is dropped (geometry only).
	// Sort by number-box column/y so sidebar follows eq order on dual-column pages.
	merged.sort((a, b) => compareLayoutReadingOrder(a, b, formulaSortAnchor));
	// Rewrite readingOrder to match so NMS / gallery keep this sequence.
	const ordered = merged.map((r, i) => ({ ...r, readingOrder: i }));

	return [...rest, ...ordered];
}

/**
 * Title-first 联图 for figures; tables/algorithms use text-aware above captions.
 * "Table N" mislabeled as figure_title binds to tables; (a)(b) are subpanels only.
 * Formulas: number-first aggregation; unnumbered formulas dropped.
 */
export function mergeCaptionsIntoHosts(
	regions: PdfLayoutRegion[],
): PdfLayoutRegion[] {
	// Drop image/chart that are dual-labeled text/header before figure clustering.
	const cleaned = suppressSpuriousFigureDetections(regions);
	// Ensure roles are resolved for merge decisions.
	const tagged = cleaned.map((r) =>
		isCaptionLayoutKind(r.kind)
			? { ...r, captionRole: resolveCaptionRole(r) }
			: r,
	);

	const figures = tagged.filter((r) => isFigureLayoutKind(r.kind));
	const tables = tagged.filter((r) => isTableLayoutKind(r.kind));
	const algorithms = tagged.filter((r) => isAlgorithmLayoutKind(r.kind));
	const captions = tagged.filter((r) => isCaptionLayoutKind(r.kind));
	// formula + formula_number only (text no longer used as a formula merge gate).
	const formulaRelated = tagged.filter(
		(r) => isFormulaLayoutKind(r.kind) || isFormulaNumberLayoutKind(r.kind),
	);
	const others = tagged.filter(
		(r) =>
			!isFigureLayoutKind(r.kind) &&
			!isTableLayoutKind(r.kind) &&
			!isAlgorithmLayoutKind(r.kind) &&
			!isCaptionLayoutKind(r.kind) &&
			!isFormulaLayoutKind(r.kind) &&
			!isFormulaNumberLayoutKind(r.kind) &&
			!isTextLayoutKind(r.kind),
	);

	const mainFigureTitles = captions.filter(isMainFigureCaption);
	const tableCaptions = captions.filter(isMainTableCaption);
	const algorithmCaptions = captions.filter(isMainAlgorithmCaption);
	const subpanels = captions.filter(isSubpanelCaption);
	const otherCaptions = captions.filter(
		(c) =>
			!isMainFigureCaption(c) &&
			!isMainTableCaption(c) &&
			!isMainAlgorithmCaption(c) &&
			!isSubpanelCaption(c),
	);

	// Absorb (a)(b) into nearest panels first so cluster bbox includes them.
	const { panels: panelsWithSubs, usedSubIds } = absorbSubpanelTitles(
		figures,
		subpanels,
	);

	const usedPanelIds = new Set<string>();
	const usedCaptionIds = new Set<string>([...usedSubIds]);
	const clustered: PdfLayoutRegion[] = [];

	// ── Phase 1: main Figure N titles → multi-panel image/chart only ──
	const sortedMainFigs = [...mainFigureTitles].sort(
		(a, b) => a.pageIndex - b.pageIndex || a.bbox.y - b.bbox.y,
	);

	const tableAlgBlockers = [...tables, ...algorithms];

	for (const title of sortedMainFigs) {
		const freePanels = panelsWithSubs.filter((f) => !usedPanelIds.has(f.id));
		const cluster = selectClusterForTitle(title, freePanels, mainFigureTitles);
		if (!cluster.length) continue;

		const body = unionMany(cluster.map((c) => c.bbox));
		if (!body) continue;

		const freeHeaders = otherCaptions.filter(
			(h) => !usedCaptionIds.has(h.id) && h.kind === "header",
		);
		const legends = attachLegendHeaders(
			body,
			title,
			freeHeaders,
			title.pageIndex,
			tableAlgBlockers,
		);

		// Subpanel captions already absorbed into panel bboxes; also union
		// any remaining subpanels under this cluster band.
		const extraSubs = subpanels.filter((s) => {
			if (usedCaptionIds.has(s.id)) return false;
			if (s.pageIndex !== title.pageIndex) return false;
			const band = expandBbox(unionBbox(body, title.bbox), 0.04, 0.02);
			const cx = s.bbox.x + s.bbox.w / 2;
			const cy = s.bbox.y + s.bbox.h / 2;
			return (
				cx >= band.x &&
				cx <= band.x + band.w &&
				cy >= band.y &&
				cy <= band.y + band.h
			);
		});

		const merged = mergeCluster(cluster, title, legends, extraSubs);
		clustered.push(merged);
		usedCaptionIds.add(title.id);
		for (const p of cluster) usedPanelIds.add(p.id);
		for (const h of legends) usedCaptionIds.add(h.id);
		for (const s of extraSubs) usedCaptionIds.add(s.id);
	}

	// ── Phase 2: tables (above caption, including mislabeled figure_title) ──
	const freeTableCaps = [
		...tableCaptions.filter((c) => !usedCaptionIds.has(c.id)),
		...otherCaptions.filter((c) => !usedCaptionIds.has(c.id)),
	];
	const tablePairs = pairCaptionsOneToOne(tables, freeTableCaps, "table");
	for (const cap of tablePairs.values()) usedCaptionIds.add(cap.id);

	// ── Phase 3: algorithms ───────────────────────────────────────────
	const freeAlgCaps = [
		...algorithmCaptions.filter((c) => !usedCaptionIds.has(c.id)),
		...otherCaptions.filter((c) => !usedCaptionIds.has(c.id)),
	];
	const algPairs = pairCaptionsOneToOne(algorithms, freeAlgCaps, "algorithm");
	for (const cap of algPairs.values()) usedCaptionIds.add(cap.id);

	// ── Phase 4: orphan single figures ────────────────────────────────
	const freeFigures = panelsWithSubs.filter((f) => !usedPanelIds.has(f.id));
	const freeFigCaps = [
		...mainFigureTitles.filter((c) => !usedCaptionIds.has(c.id)),
		...otherCaptions.filter((c) => !usedCaptionIds.has(c.id)),
	];
	const figPairs = pairCaptionsOneToOne(freeFigures, freeFigCaps, "figure");
	for (const cap of figPairs.values()) usedCaptionIds.add(cap.id);

	const singles: PdfLayoutRegion[] = [];
	// Figures without a paired title are dropped — not a valid figure entry.
	for (const host of freeFigures) {
		const cap = figPairs.get(host.id);
		if (!cap) continue;
		singles.push(attachCaptionToHost(host, cap));
	}
	for (const host of tables) {
		const cap = tablePairs.get(host.id);
		singles.push(cap ? attachCaptionToHost(host, cap) : host);
	}
	for (const host of algorithms) {
		const cap = algPairs.get(host.id);
		singles.push(cap ? attachCaptionToHost(host, cap) : host);
	}

	// ── Phase 5: formulas by equation number (drop unnumbered) ──
	const numberedFormulas = mergeFormulasByNumber(formulaRelated);

	const hosts = [
		...clustered,
		...singles,
		...others.filter((r) => isSidebarLayoutKind(r.kind)),
		...numberedFormulas,
	];
	// Orphans inside 联图 → soft half-width split (title always re-included)
	// → keep only figures with full title inside bbox.
	return requireFigureTitles(
		resolveFigureBboxOverlaps(suppressOrphanFiguresInsideClusters(hosts)),
	);
}
