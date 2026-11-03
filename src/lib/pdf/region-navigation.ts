import type { PdfDocumentObject } from "@embedpdf/models";
import type { ScrollScope } from "@embedpdf/plugin-scroll";
import {
	expandFocusBboxForOverlay,
	layoutKindFromRegionId,
	setFocusedLayoutRegion,
} from "@/lib/pdf/layout";
import type { PdfNavigationRegion } from "@/lib/pdf/pending-pdf-page";

export function scrollToPdfRegion(
	documentId: string,
	region: PdfNavigationRegion,
	document: PdfDocumentObject | null | undefined,
	scroll: ScrollScope,
	options?: { embedded?: boolean },
): void {
	const kind = region.kind ?? layoutKindFromRegionId(region.id);
	const bbox = options?.embedded
		? region.bbox
		: expandFocusBboxForOverlay(region.bbox, kind);
	const size = document?.pages[region.pageIndex]?.size;
	scroll.scrollToPage({
		pageNumber: region.pageIndex + 1,
		behavior: "instant",
		...(size
			? {
					pageCoordinates: { x: bbox.x * size.width, y: bbox.y * size.height },
					alignX: 0,
					alignY: 18,
				}
			: {}),
	});
	// Embeds paint their own persistent overlay, independent of global focus.
	if (options?.embedded) return;
	setFocusedLayoutRegion(
		documentId,
		region.id,
		{ pageIndex: region.pageIndex, bbox, kind },
		{ flash: true },
	);
}
