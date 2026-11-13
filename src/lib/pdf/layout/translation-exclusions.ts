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

function regionText(region: Pick<PdfLayoutRegion, "text" | "title">): string {
	return (region.text ?? region.title ?? "").trim();
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
		const rawText = regionText(region);
		const text = textKey(rawText);
		// Short journal names are common running headers. Exact text and
		// margin-position repetition across pages is the guard against section
		// headings and one-off labels.
		if (text.length < 2) continue;
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
type MetadataBand = {
	low: number;
	high: number;
	/** False when the lower edge is only the 22% title fallback. */
	anchored: boolean;
	anchorIds: ReadonlySet<string>;
};

/** "Abstract" / "摘要" as its own line, including a plain `text` label. */
function isAbstractHeadingText(text: string): boolean {
	return /^(?:abstract|summary|摘\s*要)[\s.:：]*$/iu.test(text.trim());
}

/**
 * Abstract heading merged into the body, with or without ":" / ".".
 * The keyword has to end the line or be followed by whitespace or punctuation,
 * so a closed compound such as "AbstractAlgebra" stays ordinary text.
 */
function isAbstractLeadText(text: string): boolean {
	return /^(?:abstract|summary|摘\s*要)(?:\s|[:：.]|$)/iu.test(text.trim());
}

function isAbstractHeading(
	region: Pick<PdfLayoutRegion, "kind" | "text" | "title">,
): boolean {
	return region.kind === "header" && isAbstractHeadingText(regionText(region));
}

function isMetadataAnchor(
	region: Pick<PdfLayoutRegion, "kind" | "label" | "text" | "title">,
): boolean {
	if (region.kind === "abstract") return true;
	if (isAbstractHeading(region)) return true;
	// A later section title is not an abstract boundary. Using it would keep
	// excluding an unlabeled abstract that sits between the title and the section.
	return isAbstractLeadText(regionText(region));
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

const NAME_PARTICLES = new Set([
	"and",
	"&",
	"of",
	"the",
	"de",
	"van",
	"von",
	"da",
	"di",
	"la",
	"le",
	"y",
	"und",
]);

/** Short capitalized byline. Sentences and single common words stay translatable. */
function looksLikePersonLine(text: string): boolean {
	const cleaned = text
		.normalize("NFKC")
		.replace(/[*†‡§¶∗]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.;,]+$/u, "");
	if (!cleaned || cleaned.length > 140) return false;
	if (/[.!?。！？]/u.test(cleaned)) return false;
	const words = cleaned.split(/[\s,;/]+/u).filter(Boolean);
	if (words.length < 2 || words.length > 14) return false;
	const significant = words.filter(
		(word) => !NAME_PARTICLES.has(word.toLowerCase()),
	);
	if (significant.length < 2) return false;
	const titled = significant.filter((word) =>
		/^[\p{Lu}][\p{L}'’-]*$/u.test(word),
	);
	return titled.length >= 2 && titled.length / significant.length >= 0.6;
}

function looksLikeAuthorMetadata(text: string): boolean {
	if (isAbstractLeadText(text)) return false;
	if (looksLikeAffiliation(text)) return true;
	if (/(?:corresponding\s+authors?|通讯作者|联系人|e-?mail)/iu.test(text))
		return true;
	return looksLikePersonLine(text);
}

/** Author / affiliation / contact lines sit between the paper title and abstract. */
function firstPageMetadataBand(
	regions: readonly PdfLayoutRegion[],
	titleIds: ReadonlySet<string>,
): MetadataBand | null {
	const pageZero = regions.filter((region) => region.pageIndex === 0);
	const titles = pageZero.filter((region) => titleIds.has(region.id));
	if (!titles.length) return null;
	const origin = inferVerticalOrigin(pageZero, titles);
	const anchors = pageZero.filter(
		(region) => !titleIds.has(region.id) && isMetadataAnchor(region),
	);
	const anchorIds = new Set(anchors.map((region) => region.id));
	if (origin === "top") {
		const titleBottom = Math.max(
			...titles.map((region) => region.bbox.y + region.bbox.h),
		);
		const below = anchors.filter(
			(region) => region.bbox.y >= titleBottom - 0.005,
		);
		const nearest = below.length
			? Math.min(...below.map((region) => region.bbox.y))
			: null;
		const high =
			nearest == null
				? titleBottom + 0.22
				: Math.min(titleBottom + 0.22, nearest);
		return high > titleBottom + 0.01
			? { low: titleBottom, high, anchored: nearest != null, anchorIds }
			: null;
	}
	const titleTop = Math.min(...titles.map((region) => region.bbox.y));
	const above = anchors.filter(
		(region) => region.bbox.y + region.bbox.h <= titleTop + 0.005,
	);
	const nearest = above.length
		? Math.max(...above.map((region) => region.bbox.y + region.bbox.h))
		: null;
	const low =
		nearest == null ? titleTop - 0.22 : Math.max(titleTop - 0.22, nearest);
	return low < titleTop - 0.01
		? { low, high: titleTop, anchored: nearest != null, anchorIds }
		: null;
}

function isMetadataBandRegion(
	region: PdfLayoutRegion,
	band: MetadataBand,
): boolean {
	// The band is inferred from page 0. The same normalized height on a later
	// page is body text.
	if (region.pageIndex !== 0) return false;
	if (band.anchorIds.has(region.id)) return false;
	const label = labelKey(region);
	if (label !== "text" && label !== "content" && label !== "header")
		return false;
	if (isCaptionHeader(region)) return false;
	const text = regionText(region);
	if (isAbstractLeadText(text)) return false;
	const inside =
		region.bbox.y >= band.low - 0.005 &&
		region.bbox.y + region.bbox.h <= band.high + 0.005;
	if (!inside) return false;
	// A real abstract or section anchor bounds the author block. Without one,
	// vertical position alone cannot tell an abstract paragraph from a byline.
	return band.anchored || looksLikeAuthorMetadata(text);
}

function looksLikeNumberedSection(text: string): boolean {
	return /^\d+(?:\.\d+)*[.)]?\s+\S/u.test(text.trim());
}

function isPaperTitleHeading(region: PdfLayoutRegion): boolean {
	if (region.pageIndex !== 0 || labelKey(region) !== "paragraph_title")
		return false;
	if (isCaptionHeader(region) || isReferenceSectionTitle(regionText(region)))
		return false;
	const text = regionText(region);
	return (
		text.length > 0 &&
		region.bbox.y <= 0.32 &&
		!looksLikeNumberedSection(text) &&
		!/^(?:abstract|summary|摘\s*要)[\s.:：]*$/iu.test(text)
	);
}

function median(values: readonly number[]): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? (sorted[middle] ?? null)
		: ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function looksLikeAffiliation(text: string): boolean {
	return /(?:@|\b(?:university|institute|department|school|laboratory|research|college|academy)\b|大学|学院|研究院|研究所|实验室)/iu.test(
		text,
	);
}

/**
 * Older MinerU Content Lists collapse the paper title into a `paragraph_title`
 * (`text_level: 1`) instead of emitting `doc_title`. Infer only the leading
 * heading, and only with an abstract, affiliation, or noticeably larger type
 * below it. Numbered section headings stay translatable.
 */
function firstPageTitleIds(
	regions: readonly PdfLayoutRegion[],
	geometryCandidates: readonly PdfLayoutRegion[],
): ReadonlySet<string> {
	const pageZero = regions.filter((region) => region.pageIndex === 0);
	const explicit = pageZero.filter(
		(region) => labelKey(region) === "doc_title",
	);
	if (explicit.length) return new Set(explicit.map((region) => region.id));

	const candidate = geometryCandidates
		.filter((region) => region.pageIndex === 0 && isPaperTitleHeading(region))
		.sort(
			(a, b) =>
				a.bbox.y - b.bbox.y ||
				a.readingOrder - b.readingOrder ||
				a.bbox.x - b.bbox.x,
		)[0];
	if (!candidate) return new Set();
	const candidateBottom = candidate.bbox.y + candidate.bbox.h;
	const abstractBelow = pageZero.some(
		(region) =>
			region.bbox.y >= candidateBottom - 0.005 &&
			(region.kind === "abstract" ||
				(labelKey(region) === "paragraph_title" &&
					/^(?:abstract|summary|摘\s*要)[\s.:：]*$/iu.test(
						regionText(region),
					))),
	);
	const affiliationBelow = pageZero.some(
		(region) =>
			region.id !== candidate.id &&
			region.bbox.y >= candidateBottom - 0.005 &&
			region.bbox.y <= candidate.bbox.y + 0.22 &&
			looksLikeAffiliation(regionText(region)),
	);
	const bodyFontSizes = pageZero
		.filter(
			(region) =>
				region.kind === "text" &&
				region.sourceStyle &&
				!isMetadataAnchor(region),
		)
		.map((region) => region.sourceStyle?.fontSize ?? 0)
		.filter((fontSize) => fontSize > 0);
	const bodyFontSize = median(bodyFontSizes);
	const largerThanBody =
		candidate.sourceStyle != null &&
		bodyFontSize != null &&
		candidate.sourceStyle.fontSize >= bodyFontSize * 1.25;
	return abstractBelow || affiliationBelow || largerThanBody
		? new Set([candidate.id])
		: new Set();
}

const ALWAYS_PRESERVE_LABELS = new Set([
	"doc_title",
	"footnote",
	"vision_footnote",
	"footer",
	"number",
	"seal",
	"aside_text",
]);

function isAlwaysPreservedRegion(region: PdfLayoutRegion): boolean {
	return (
		ALWAYS_PRESERVE_LABELS.has(labelKey(region)) ||
		isAbstractHeading(region) ||
		region.kind === "abstract" ||
		region.kind === "algorithm" ||
		isReferenceLayoutRegion(region)
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
	const geometryCandidates = regions.filter(
		(region) => region.score >= minScore || isAlwaysPreservedRegion(region),
	);
	const titleIds = firstPageTitleIds(regions, geometryCandidates);
	const marginHeaders = marginHeaderIds(regions);
	const metadataBand = firstPageMetadataBand(regions, titleIds);
	const out = new Map<string, LayoutPreserveReason>();
	for (const region of regions) {
		const label = labelKey(region);
		let reason: LayoutPreserveReason | undefined;
		if (isReferenceLayoutRegion(region)) reason = "reference";
		else if (region.kind === "algorithm") reason = "algorithm";
		else if (titleIds.has(region.id)) reason = "paper-title";
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
