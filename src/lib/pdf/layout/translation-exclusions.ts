import { LAYOUT_SIDEBAR_MIN_SCORE } from "@/lib/pdf/layout/constants";
import { bboxCoveredBy } from "@/lib/pdf/layout/merge-captions";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

export type LayoutPreserveReason =
	| "paper-title"
	| "metadata-band"
	| "footnote"
	| "page-header"
	| "footer"
	| "page-number"
	| "seal"
	| "aside-text"
	| "reference"
	| "algorithm";

/** Layout providers preserve bibliography labels even when mapped to `text`. */
export function isReferenceLayoutLabel(label: string): boolean {
	const key = label.trim().toLowerCase();
	return key === "reference" || key === "reference_content";
}

export function isReferenceSectionTitle(text: string): boolean {
	return /^(?:(?:\d+(?:\.\d+)*|[A-Z])[.)]?\s+)?(?:references?|bibliography|works\s+cited|[参參]考文[献獻])[\s.:：。]*$/iu.test(
		text.trim(),
	);
}

/** Exclude detected bibliography blocks without extending into later appendices. */
export function isReferenceLayoutRegion(region: PdfLayoutRegion): boolean {
	return (
		isReferenceLayoutLabel(region.label) ||
		(region.kind === "header" &&
			isReferenceSectionTitle(region.text ?? region.title ?? ""))
	);
}

/** Also reject supplemental or cached IR blocks inside a bibliography region. */
export function isInsideReferenceRegion(
	item: Pick<PdfLayoutRegion, "id" | "pageIndex" | "bbox">,
	references: readonly PdfLayoutRegion[],
): boolean {
	return references.some(
		(region) =>
			region.pageIndex === item.pageIndex &&
			(region.id === item.id || bboxCoveredBy(item.bbox, region.bbox) >= 0.45),
	);
}

/** Reject supplemental or cached IR blocks that revisit a preserved region. */
export function isInsidePreservedRegion(
	item: Pick<PdfLayoutRegion, "id" | "pageIndex" | "bbox">,
	regions: readonly PdfLayoutRegion[],
	preserved: ReadonlyMap<string, LayoutPreserveReason>,
): boolean {
	return regions.some(
		(region) =>
			preserved.has(region.id) &&
			region.pageIndex === item.pageIndex &&
			(region.id === item.id || bboxCoveredBy(item.bbox, region.bbox) >= 0.45),
	);
}

function labelKey(region: Pick<PdfLayoutRegion, "label">): string {
	return region.label.trim().toLowerCase();
}

function textKey(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, "");
}

function isCaptionHeader(
	region: Pick<PdfLayoutRegion, "kind" | "captionRole" | "text" | "title">,
): boolean {
	if (region.kind !== "header") return false;
	if (region.captionRole && region.captionRole !== "other") return true;
	return /^(?:figure|fig\.?|table)\s*\d/iu.test(
		(region.text ?? region.title ?? "").trim(),
	);
}

function isMarginHeader(
	region: Pick<PdfLayoutRegion, "label" | "bbox">,
): boolean {
	if (labelKey(region) !== "header") return false;
	// Providers expose normalized boxes with either a top-left or bottom-left
	// origin. Distance to the nearest vertical edge works for both.
	const marginDistance = Math.min(
		region.bbox.y,
		1 - region.bbox.y - region.bbox.h,
	);
	return marginDistance <= 0.12;
}

function looksLikePublicationHeader(text: string): boolean {
	return /(?:\b(?:journal|transactions|proceedings|conference|symposium|workshop|volume|vol|issue|issn|isbn|doi|preprint|arxiv|copyright)\b|©|第\s*\d+\s*[卷期])/iu.test(
		text,
	);
}

/**
 * Page headers live in a page-margin band. Headings and captions can also
 * arrive with the raw `header` label, so center-page headers stay translatable.
 */
function marginHeaderIds(
	regions: readonly PdfLayoutRegion[],
): ReadonlySet<string> {
	const pagesByKey = new Map<string, Set<number>>();
	const idsByKey = new Map<string, string[]>();
	for (const region of regions) {
		if (!isMarginHeader(region) || isCaptionHeader(region)) continue;
		const rawText = region.text ?? region.title ?? "";
		const text = textKey(rawText);
		if (text.length < 8) continue;
		const key = `${Math.round(region.bbox.y * 100)}:${text}`;
		const pages = pagesByKey.get(key) ?? new Set<number>();
		pages.add(region.pageIndex);
		pagesByKey.set(key, pages);
		idsByKey.set(key, [...(idsByKey.get(key) ?? []), region.id]);
	}
	const out = new Set<string>();
	for (const [key, pages] of pagesByKey)
		if (pages.size >= 2) for (const id of idsByKey.get(key) ?? []) out.add(id);
	for (const region of regions) {
		if (
			isMarginHeader(region) &&
			!isCaptionHeader(region) &&
			looksLikePublicationHeader(region.text ?? region.title ?? "")
		)
			out.add(region.id);
	}
	return out;
}

type VerticalOrigin = "top" | "bottom";
type MetadataBand = { low: number; high: number };

function isMetadataAnchor(
	region: Pick<PdfLayoutRegion, "kind" | "label" | "text" | "title">,
): boolean {
	if (region.kind === "abstract") return true;
	if (labelKey(region) === "paragraph_title") return true;
	return (
		region.kind === "header" &&
		/^(?:abstract|summary|摘\s*要)[\s.:：]*$/iu.test(
			(region.text ?? region.title ?? "").trim(),
		)
	);
}

function inferVerticalOrigin(
	pageZero: readonly PdfLayoutRegion[],
	titles: readonly PdfLayoutRegion[],
): VerticalOrigin {
	const titleLow = Math.min(...titles.map((region) => region.bbox.y));
	const titleHigh = Math.max(
		...titles.map((region) => region.bbox.y + region.bbox.h),
	);
	const titleMiddle = (titleLow + titleHigh) / 2;
	const anchor = pageZero.find(
		(region) =>
			isMetadataAnchor(region) &&
			Math.abs(region.bbox.y + region.bbox.h / 2 - titleMiddle) > 0.01,
	);
	if (anchor) {
		const anchorMiddle = anchor.bbox.y + anchor.bbox.h / 2;
		return anchorMiddle > titleMiddle ? "top" : "bottom";
	}
	return titleMiddle > 0.5 ? "bottom" : "top";
}

/** Author / affiliation / contact lines sit between the paper title and abstract. */
function firstPageMetadataBand(
	regions: readonly PdfLayoutRegion[],
): MetadataBand | null {
	const pageZero = regions.filter((region) => region.pageIndex === 0);
	const titles = pageZero.filter((region) => labelKey(region) === "doc_title");
	if (!titles.length) return null;
	const origin = inferVerticalOrigin(pageZero, titles);
	const anchors = pageZero.filter(isMetadataAnchor);
	if (origin === "top") {
		const titleBottom = Math.max(
			...titles.map((region) => region.bbox.y + region.bbox.h),
		);
		const anchorTop = Math.min(
			titleBottom + 0.22,
			...anchors
				.filter((region) => region.bbox.y >= titleBottom - 0.005)
				.map((region) => region.bbox.y),
		);
		return anchorTop > titleBottom + 0.01
			? { low: titleBottom, high: anchorTop }
			: null;
	}
	const titleBottom = Math.min(...titles.map((region) => region.bbox.y));
	const anchorBottom = Math.max(
		titleBottom - 0.22,
		...anchors
			.filter((region) => region.bbox.y + region.bbox.h <= titleBottom + 0.005)
			.map((region) => region.bbox.y + region.bbox.h),
	);
	return anchorBottom < titleBottom - 0.01
		? { low: anchorBottom, high: titleBottom }
		: null;
}

function isMetadataBandRegion(
	region: PdfLayoutRegion,
	band: MetadataBand,
): boolean {
	const label = labelKey(region);
	if (label !== "text" && label !== "content" && label !== "header")
		return false;
	if (isCaptionHeader(region)) return false;
	return (
		region.bbox.y >= band.low - 0.005 &&
		region.bbox.y + region.bbox.h <= band.high + 0.005
	);
}

/**
 * Regions left in their source language during paper-wide PDF translation.
 * Bibliographic metadata and page furniture are not reading content; captions,
 * abstracts and section headings remain translatable.
 */
export function preservedLayoutRegions(
	regions: readonly PdfLayoutRegion[],
	minScore: number = LAYOUT_SIDEBAR_MIN_SCORE,
): ReadonlyMap<string, LayoutPreserveReason> {
	const candidates = regions.filter(
		(region) => region.score >= minScore || isReferenceLayoutRegion(region),
	);
	const marginHeaders = marginHeaderIds(candidates);
	const metadataBand = firstPageMetadataBand(candidates);
	const out = new Map<string, LayoutPreserveReason>();
	for (const region of candidates) {
		const label = labelKey(region);
		let reason: LayoutPreserveReason | undefined;
		if (isReferenceLayoutRegion(region)) reason = "reference";
		else if (region.kind === "algorithm") reason = "algorithm";
		else if (label === "doc_title") reason = "paper-title";
		else if (label === "footnote" || label === "vision_footnote")
			reason = "footnote";
		else if (marginHeaders.has(region.id)) reason = "page-header";
		else if (label === "footer") reason = "footer";
		else if (label === "number") reason = "page-number";
		else if (label === "seal") reason = "seal";
		else if (label === "aside_text") reason = "aside-text";
		else if (metadataBand && isMetadataBandRegion(region, metadataBand))
			reason = "metadata-band";
		if (reason) out.set(region.id, reason);
	}
	return out;
}
