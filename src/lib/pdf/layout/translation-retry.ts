/**
 * In-place retry anchors for paragraph translations that failed after the
 * reliability layer's retries.
 *
 * A failed page keeps its source text on screen, so the only useful feedback
 * is a warning at the spot where the running spinner sat — the paragraph tail.
 * Clicking it retries that paragraph's page (the same path as the page tab's
 * "translate this page"), which is why a page failure no longer needs a toast.
 */
import { translationParagraphGroups } from "@/lib/pdf/layout/translation-spinner";
import type {
	LayoutTranslateItem,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";

/** Bottom-most, then left-most: the last fragment a reader sees in a paragraph. */
function readingOrder(a: LayoutTranslateItem, b: LayoutTranslateItem): number {
	return a.bbox.y + a.bbox.h - (b.bbox.y + b.bbox.h) || a.bbox.x - b.bbox.x;
}

/**
 * One item per paragraph that settled on an error with no retry in flight.
 * Anchors the paragraph tail, exactly where the running spinner would be.
 *
 * Fails share the spinner's paragraph grouping (and figure suppression), so a
 * split paragraph shows one marker, not one per fragment.
 */
export function translationRetryItems(
	items: readonly LayoutTranslateItem[],
	regions: readonly PdfLayoutRegion[] = [],
): readonly LayoutTranslateItem[] {
	return translationParagraphGroups(items, regions)
		.filter((group) => !group.some((item) => item.status === "running"))
		.filter((group) => group.some((item) => item.status === "error"))
		.flatMap((group) => {
			const last = group.sort(readingOrder).at(-1);
			return last ? [last] : [];
		});
}
