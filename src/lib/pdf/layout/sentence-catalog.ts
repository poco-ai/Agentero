/**
 * Sentence catalog entries for layout text blocks that have no translation.
 *
 * The hover catalog used to publish every raw text detection. The model
 * re-detects the same prose at many confidence levels, and a low-confidence box
 * that spans both columns gets its text-layer runs interleaved — "tion, which …
 * ( Yao Fetching Unit (Sec." — so splitting it invents a sentence whose glyphs
 * land in two columns and hover lights both at once. Publish the deduped,
 * score-gated text blocks instead (the same set the element-selection hit test
 * uses), and skip text detected inside figures / tables / algorithms, which
 * are graphic content rather than prose.
 */

import { LAYOUT_SIDEBAR_MIN_SCORE } from "@/lib/pdf/layout/constants";
import { dedupeLayoutRegions } from "@/lib/pdf/layout/dedupe";
import { isLayoutElementTextKind } from "@/lib/pdf/layout/labels";
import { splitLayoutSentences } from "@/lib/pdf/layout/layout-sentences";
import { isInsideVisualLayoutRegion } from "@/lib/pdf/layout/translatable";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

export type HoverSentenceSourceItem = {
	id: string;
	pageIndex: number;
	bbox: PdfLayoutRegion["bbox"];
	source: string;
	sentences: { quote: string; translated: string }[];
};

export function hoverSentenceSourceItems(
	regions: readonly PdfLayoutRegion[],
	translatedIds: ReadonlySet<string>,
): HoverSentenceSourceItem[] {
	const textBlocks = regions.filter(
		(region) =>
			isLayoutElementTextKind(region.kind) &&
			region.bbox.w > 0 &&
			region.bbox.h > 0 &&
			!isInsideVisualLayoutRegion(region, regions),
	);
	// Dedupe before dropping translated ids: a translated block still suppresses
	// its own low-confidence duplicates.
	return dedupeLayoutRegions(textBlocks, {
		minScore: LAYOUT_SIDEBAR_MIN_SCORE,
	})
		.filter((region) => !translatedIds.has(region.id))
		.map((region) => {
			const source = region.text ?? "";
			return {
				id: region.id,
				pageIndex: region.pageIndex,
				bbox: region.bbox,
				source,
				sentences: splitLayoutSentences(source).map((quote) => ({
					quote,
					translated: "",
				})),
			};
		});
}
