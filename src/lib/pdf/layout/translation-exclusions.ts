import { bboxCoveredBy } from "@/lib/pdf/layout/merge-captions";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

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
