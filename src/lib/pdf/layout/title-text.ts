import type { PdfTextRun } from "@embedpdf/models";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import { recoverCaptionsFromRuns } from "@/lib/pdf/layout/captions-from-runs";
import { figureCaptionKey } from "@/lib/pdf/layout/figure-caption-text";
import {
	isCaptionLayoutKind,
	isLayoutBodyTextKind,
} from "@/lib/pdf/layout/labels";
import {
	groupReadingLines,
	orderByReadingLine,
	type ReadingBox,
} from "@/lib/pdf/layout/reading-order";
import { sourceStyleFromRuns } from "@/lib/pdf/layout/source-style";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

/** Semantic role of a caption box (from PDF text, not model label alone). */
export type CaptionRole =
	| "figure_main"
	| "table_main"
	| "algorithm_main"
	| "subpanel"
	| "other";

function runCenterInBbox(
	run: PdfTextRun,
	bbox: PdfAskNormalizedRect,
	pageWidth: number,
	pageHeight: number,
): boolean {
	if (pageWidth <= 0 || pageHeight <= 0) return false;
	const cx = (run.rect.origin.x + run.rect.size.width / 2) / pageWidth;
	const cy = (run.rect.origin.y + run.rect.size.height / 2) / pageHeight;
	return (
		cx >= bbox.x &&
		cx <= bbox.x + bbox.w &&
		cy >= bbox.y &&
		cy <= bbox.y + bbox.h
	);
}

type TextRunLine = {
	runs: PdfTextRun[];
	top: number;
	bottom: number;
};

function runReadingBox(run: PdfTextRun): ReadingBox {
	return {
		x: run.rect.origin.x,
		y: run.rect.origin.y,
		width: run.rect.size.width,
		height: run.rect.size.height,
	};
}

function runsInBbox(
	runs: PdfTextRun[],
	bbox: PdfAskNormalizedRect,
	pageWidth: number,
	pageHeight: number,
): PdfTextRun[] {
	const inside = runs.filter(
		(run) =>
			Boolean(run.text?.trim()) &&
			runCenterInBbox(run, bbox, pageWidth, pageHeight),
	);
	return orderByReadingLine(inside, runReadingBox);
}

/**
 * Split an overly broad model text box at real PDF line gaps. Layout models
 * often group adjacent paragraphs into one `text` detection; translating that
 * as one unit produces a bad semantic boundary and a needlessly tiny overlay.
 */
export function splitBodyRegionAtParagraphGaps(
	region: PdfLayoutRegion,
	runs: PdfTextRun[],
	pageSize: { width: number; height: number },
): PdfLayoutRegion[] {
	if (region.kind !== "text" && region.kind !== "abstract") return [region];
	const inside = runsInBbox(runs, region.bbox, pageSize.width, pageSize.height);
	if (inside.length < 2) return [region];

	const lines = groupReadingLines(inside, runReadingBox).map((line) => ({
		runs: line.items,
		top: line.top,
		bottom: line.bottom,
	}));
	if (lines.length < 2) return [region];
	const heights = lines.map((line) => Math.max(1, line.bottom - line.top));
	const medianHeight = heights.slice().sort((a, b) => a - b)[
		Math.floor(heights.length / 2)
	];
	const paragraphs: TextRunLine[][] = [];
	let current: TextRunLine[] = [];
	for (const line of lines) {
		const previous = current.at(-1);
		if (
			previous &&
			line.top - previous.bottom > Math.max(2, (medianHeight ?? 1) * 0.55)
		) {
			paragraphs.push(current);
			current = [];
		}
		current.push(line);
	}
	if (current.length) paragraphs.push(current);
	if (paragraphs.length < 2) return [region];

	return paragraphs.map((paragraph, index) => {
		const paragraphRuns = paragraph.flatMap((line) => line.runs);
		const left = Math.min(...paragraphRuns.map((run) => run.rect.origin.x));
		const top = Math.min(...paragraphRuns.map((run) => run.rect.origin.y));
		const right = Math.max(
			...paragraphRuns.map((run) => run.rect.origin.x + run.rect.size.width),
		);
		const bottom = Math.max(
			...paragraphRuns.map((run) => run.rect.origin.y + run.rect.size.height),
		);
		const text = paragraphRuns
			.map((run) => run.text.replace(/\s+/g, " ").trim())
			.filter(Boolean)
			.join(" ");
		return {
			...region,
			id: `${region.id}::paragraph-${index + 1}`,
			readingOrder: region.readingOrder + index / 1000,
			rect: { x: left, y: top, w: right - left, h: bottom - top },
			bbox: {
				x: left / pageSize.width,
				y: top / pageSize.height,
				w: (right - left) / pageSize.width,
				h: (bottom - top) / pageSize.height,
			},
			text,
		};
	});
}

/**
 * Collect PDF text runs whose centers fall inside a normalized caption box.
 */
export function textFromRunsInBbox(
	runs: PdfTextRun[],
	bbox: PdfAskNormalizedRect,
	pageWidth: number,
	pageHeight: number,
): string {
	const parts: string[] = [];
	for (const run of runsInBbox(runs, bbox, pageWidth, pageHeight)) {
		const t = run.text?.replace(/\s+/g, " ").trim();
		if (!t) continue;
		parts.push(t);
	}
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Classify caption text: main Figure/Table/Algorithm vs (a)(b) subpanel titles.
 */
export function captionRoleFromText(text: string): CaptionRole {
	const t = text.trim();
	if (!t) return "other";
	if (figureCaptionKey(t)) return "figure_main";
	// (a) Concentration — panel subtitle, not the whole-figure caption.
	if (/^[a-z]$/i.test(t)) return "subpanel";
	if (/^\(\s*[a-z]\s*\)/i.test(t)) return "subpanel";
	if (/^[a-z]\s*[).:]\s+\S/i.test(t) && t.length < 80) return "subpanel";
	if (/^table\s*\d/i.test(t) || /^tab\.\s*\d/i.test(t)) return "table_main";
	if (/^algorithm\s*\d/i.test(t) || /^alg\.\s*\d/i.test(t))
		return "algorithm_main";
	if (/^fig(?:ure)?\.?\s*\d/i.test(t)) return "figure_main";
	if (/^table\b/i.test(t)) return "table_main";
	if (/^algorithm\b/i.test(t)) return "algorithm_main";
	if (/^fig(?:ure)?\b/i.test(t)) return "figure_main";
	return "other";
}

/**
 * Geometry fallback when text is missing: wide boxes may be main captions.
 * Narrow boxes are ambiguous (single-column main caption or subpanel label).
 */
export function captionRoleFromGeometry(
	region: PdfLayoutRegion,
): CaptionRole | null {
	if (!isCaptionLayoutKind(region.kind)) return null;
	// Wide caption bar → likely main figure/table title.
	if (region.bbox.w >= 0.45 && region.bbox.h <= 0.2) {
		return region.kind === "figure_title" ? "figure_main" : "other";
	}
	// Only explicit text such as (a) establishes a subpanel role.
	return null;
}

export function resolveCaptionRole(region: PdfLayoutRegion): CaptionRole {
	// Old raw sidecars may cache a geometry-only subpanel role. Re-evaluate it
	// when no text supports that classification, so reopening fixes old results.
	if (
		region.captionRole &&
		!(region.captionRole === "subpanel" && !region.title?.trim())
	)
		return region.captionRole;
	const fromText = region.title ? captionRoleFromText(region.title) : "other";
	if (fromText !== "other") return fromText;
	return captionRoleFromGeometry(region) ?? "other";
}

/**
 * Write extracted text + role onto caption-like regions (figure_title / header)
 * and body text/abstract into `text`.
 * Formula / formula_number: no text parse — merge is geometry-only on model boxes.
 */
export function enrichCaptionRegionsWithText(
	regions: PdfLayoutRegion[],
	pageIndex: number,
	runs: PdfTextRun[],
	pageSize: { width: number; height: number },
): PdfLayoutRegion[] {
	const enriched = regions.flatMap((region) => {
		if (region.pageIndex !== pageIndex) return region;

		if (isCaptionLayoutKind(region.kind)) {
			const title = textFromRunsInBbox(
				runs,
				region.bbox,
				pageSize.width,
				pageSize.height,
			);
			const text = title || region.title || "";
			const role = text
				? captionRoleFromText(text)
				: (captionRoleFromGeometry(region) ?? "other");
			// Model often labels "Table N: …" as figure_title — keep kind for
			// geometry but role drives merge (table_main → attach to table).
			// Mirror extract into `text` so bulk translate can pick it up.
			return {
				...region,
				title: text || region.title,
				text: text || region.text,
				captionRole: role,
			};
		}

		if (isLayoutBodyTextKind(region.kind) && region.kind !== "header") {
			return splitBodyRegionAtParagraphGaps(region, runs, pageSize).map(
				(segment) => {
					// A box that does not split still carries previously stored
					// text. Prefer this walk so a bad word order is replaced.
					const fresh = textFromRunsInBbox(
						runs,
						segment.bbox,
						pageSize.width,
						pageSize.height,
					);
					return {
						...segment,
						text: fresh || segment.text,
					};
				},
			);
		}

		return region;
	});
	return recoverCaptionsFromRuns(enriched, pageIndex, runs, pageSize).map(
		(region) => {
			if (region.pageIndex !== pageIndex || !(region.text || region.title))
				return region;
			const sourceStyle = sourceStyleFromRuns(
				runsInBbox(runs, region.bbox, pageSize.width, pageSize.height),
				pageSize.height,
			);
			return sourceStyle ? { ...region, sourceStyle } : region;
		},
	);
}

/**
 * Attach caption strings onto host regions that already have `titleBbox`.
 */
export function attachTitlesFromTextRuns(
	regions: PdfLayoutRegion[],
	pageIndex: number,
	runs: PdfTextRun[],
	pageSize: { width: number; height: number },
): PdfLayoutRegion[] {
	return regions.map((region) => {
		if (region.pageIndex !== pageIndex || !region.titleBbox) return region;
		const title = textFromRunsInBbox(
			runs,
			region.titleBbox,
			pageSize.width,
			pageSize.height,
		);
		if (!title) return region;
		return { ...region, title };
	});
}
