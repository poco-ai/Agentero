import { LAYOUT_SIDEBAR_MIN_SCORE } from "@/lib/pdf/layout/constants";
import {
	isInsideAlgorithmRegion,
	listTranslatableLayoutRegions,
} from "@/lib/pdf/layout/translatable";
import { preservedLayoutRegions } from "@/lib/pdf/layout/translation-exclusions";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

const MIN_WARNING_TEXT_CHARS = 32;
const VISUAL_PAGE_AREA = 0.45;

const VISUAL_KINDS = new Set<PdfLayoutRegion["kind"]>([
	"image",
	"chart",
	"table",
	"algorithm",
	"formula",
	"formula_number",
]);

export type LayoutPageStats = {
	pageIndex: number;
	regionCount: number;
	/** Characters found in this page's PDF text layer. */
	textChars: number;
	translatableRegionCount: number;
	/** Detected text that intentionally stays in the source language. */
	excludedTextChars?: number;
	/** Union-free visual coverage estimate; enough to suppress image-only pages. */
	visualArea?: number;
};

export type LayoutCompletenessWarning = {
	code: "content-gap";
	/** Zero-based page indexes with text but no translatable layout result. */
	pages: number[];
};

export type LayoutCompleteness = {
	pageCount: number;
	processedPages: number[];
	textLayerComplete: boolean;
	pageStats: LayoutPageStats[];
	warnings: LayoutCompletenessWarning[];
	/**
	 * A content-gap reparse has already run. Translation may proceed with the
	 * remaining warnings instead of paying for the same repair repeatedly.
	 */
	contentRepairAttempted: boolean;
};

export type LayoutReadinessStatus =
	| "ready"
	| "warning"
	| "incomplete"
	| "unknown";

export type LayoutReadiness = {
	status: LayoutReadinessStatus;
	missingPages: number[];
	warningPages: number[];
	needsContentRepair: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPageIndex(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parsePageStats(value: unknown): LayoutPageStats | null {
	if (!isObject(value)) return null;
	const {
		pageIndex,
		regionCount,
		textChars,
		translatableRegionCount,
		excludedTextChars,
		visualArea,
	} = value;
	if (
		!isPageIndex(pageIndex) ||
		!isPageIndex(regionCount) ||
		!isPageIndex(textChars) ||
		!isPageIndex(translatableRegionCount)
	) {
		return null;
	}
	const out: LayoutPageStats = {
		pageIndex,
		regionCount,
		textChars,
		translatableRegionCount,
	};
	if (isPageIndex(excludedTextChars)) out.excludedTextChars = excludedTextChars;
	if (
		typeof visualArea === "number" &&
		Number.isFinite(visualArea) &&
		visualArea >= 0
	) {
		out.visualArea = visualArea;
	}
	return out;
}

export function parseLayoutCompleteness(
	value: unknown,
): LayoutCompleteness | null {
	if (!isObject(value)) return null;
	if (!isPageIndex(value.pageCount) || value.pageCount === 0) return null;
	if (typeof value.textLayerComplete !== "boolean") return null;
	if (!Array.isArray(value.processedPages)) return null;
	if (!value.processedPages.every(isPageIndex)) return null;
	if (!Array.isArray(value.pageStats)) return null;
	const pageStats = value.pageStats.map(parsePageStats);
	if (pageStats.some((page) => page === null)) return null;
	if (!Array.isArray(value.warnings)) return null;
	const warnings: LayoutCompletenessWarning[] = [];
	for (const warning of value.warnings) {
		if (!isObject(warning) || warning.code !== "content-gap") return null;
		if (!Array.isArray(warning.pages) || !warning.pages.every(isPageIndex))
			return null;
		warnings.push({
			code: "content-gap",
			pages: [...new Set(warning.pages as number[])].sort((a, b) => a - b),
		});
	}
	return {
		pageCount: value.pageCount,
		processedPages: [...new Set(value.processedPages as number[])],
		textLayerComplete: value.textLayerComplete,
		pageStats: pageStats as LayoutPageStats[],
		warnings,
		contentRepairAttempted: value.contentRepairAttempted === true,
	};
}

function pageTextChars(region: PdfLayoutRegion): number {
	return (region.text ?? region.title ?? "").replace(/\s+/g, "").length;
}

function excludedPageText(
	regions: readonly PdfLayoutRegion[],
): Map<number, number> {
	const out = new Map<number, number>();
	const preserved = preservedLayoutRegions(regions);
	const algorithms = regions.filter(
		(region) =>
			region.kind === "algorithm" && region.score >= LAYOUT_SIDEBAR_MIN_SCORE,
	);
	for (const region of regions) {
		if (
			!preserved.has(region.id) &&
			!VISUAL_KINDS.has(region.kind) &&
			!isInsideAlgorithmRegion(region, algorithms)
		) {
			continue;
		}
		out.set(
			region.pageIndex,
			(out.get(region.pageIndex) ?? 0) + pageTextChars(region),
		);
	}
	return out;
}

/**
 * Build every page's stats from the same text-layer walk that enriched the
 * regions. Pages with no region still get a row so coverage can be verified.
 */
export function buildLayoutPageStats(args: {
	regions: readonly PdfLayoutRegion[];
	pageCount: number;
	textCharsByPage: ReadonlyMap<number, number>;
}): LayoutPageStats[] {
	const translatableByPage = new Map<number, number>();
	for (const region of listTranslatableLayoutRegions(args.regions)) {
		translatableByPage.set(
			region.pageIndex,
			(translatableByPage.get(region.pageIndex) ?? 0) + 1,
		);
	}
	const excludedByPage = excludedPageText(args.regions);
	const stats: LayoutPageStats[] = [];
	for (let pageIndex = 0; pageIndex < args.pageCount; pageIndex++) {
		const regions = args.regions.filter(
			(region) => region.pageIndex === pageIndex,
		);
		let visualArea = 0;
		for (const region of regions) {
			if (!VISUAL_KINDS.has(region.kind)) continue;
			visualArea += Math.max(0, region.bbox.w * region.bbox.h);
		}
		stats.push({
			pageIndex,
			regionCount: regions.length,
			textChars: args.textCharsByPage.get(pageIndex) ?? 0,
			translatableRegionCount: translatableByPage.get(pageIndex) ?? 0,
			excludedTextChars: excludedByPage.get(pageIndex) ?? 0,
			visualArea: Math.min(1, visualArea),
		});
	}
	return stats;
}

export function buildLayoutCompleteness(args: {
	pageCount: number;
	pageStats: LayoutPageStats[];
	textLayerComplete: boolean;
	contentRepairAttempted: boolean;
}): LayoutCompleteness {
	const pageStats = [...args.pageStats].sort(
		(a, b) => a.pageIndex - b.pageIndex,
	);
	const warningPages = args.textLayerComplete
		? pageStats
				.filter((page) => {
					if (page.translatableRegionCount > 0) return false;
					if ((page.visualArea ?? 0) >= VISUAL_PAGE_AREA) return false;
					const uncoveredText = Math.max(
						0,
						page.textChars - (page.excludedTextChars ?? 0),
					);
					return uncoveredText >= MIN_WARNING_TEXT_CHARS;
				})
				.map((page) => page.pageIndex)
		: [];
	return {
		pageCount: args.pageCount,
		processedPages: pageStats.map((page) => page.pageIndex),
		textLayerComplete: args.textLayerComplete,
		pageStats,
		warnings:
			warningPages.length > 0
				? [{ code: "content-gap", pages: warningPages }]
				: [],
		contentRepairAttempted: args.contentRepairAttempted,
	};
}

export function assessLayoutReadiness(
	completeness: LayoutCompleteness | null | undefined,
): LayoutReadiness {
	if (!completeness) {
		return {
			status: "unknown",
			missingPages: [],
			warningPages: [],
			needsContentRepair: false,
		};
	}
	const expected = new Set(
		Array.from({ length: completeness.pageCount }, (_, index) => index),
	);
	const processed = new Set(completeness.processedPages);
	const stats = new Set(completeness.pageStats.map((page) => page.pageIndex));
	const missingPages = [...expected].filter(
		(page) => !processed.has(page) || !stats.has(page),
	);
	const warningPages = [
		...new Set(completeness.warnings.flatMap((warning) => warning.pages)),
	].sort((a, b) => a - b);
	let status: LayoutReadinessStatus;
	if (!completeness.textLayerComplete || missingPages.length > 0) {
		status = "incomplete";
	} else if (warningPages.length > 0) {
		status = "warning";
	} else {
		status = "ready";
	}
	return {
		status,
		missingPages,
		warningPages,
		needsContentRepair:
			status === "warning" && !completeness.contentRepairAttempted,
	};
}

/** 1-based compact range label such as `3, 7–9`. */
export function formatLayoutPageRanges(pages: readonly number[]): string {
	const sorted = [...new Set(pages)].sort((a, b) => a - b);
	const ranges: string[] = [];
	for (let index = 0; index < sorted.length; index++) {
		const start = sorted[index] + 1;
		let end = start;
		while (sorted[index + 1] === sorted[index] + 1) {
			index += 1;
			end = sorted[index] + 1;
		}
		ranges.push(start === end ? `${start}` : `${start}–${end}`);
	}
	return ranges.join(", ");
}
