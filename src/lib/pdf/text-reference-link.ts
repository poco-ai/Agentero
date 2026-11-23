import {
	PdfActionType,
	PdfAnnotationSubtype,
	type PdfLinkAnnoObject,
	type Rect,
} from "@embedpdf/models";
import type { TextReference } from "@/lib/pdf/text-references";

export type TextReferenceLink = PdfLinkAnnoObject & {
	textReference: TextReference;
};

export function textReferenceForLink(
	link: PdfLinkAnnoObject,
): TextReference | null {
	return "textReference" in link
		? (link as TextReferenceLink).textReference
		: null;
}

export function citationLinksForTranslation(
	links: readonly PdfLinkAnnoObject[],
): PdfLinkAnnoObject[] {
	const nativeReferences = new Set<TextReference>();
	for (const link of links) {
		const reference = textReferenceForLink(link);
		if (
			reference &&
			(link.target?.type === "destination" ||
				link.target?.action.type === PdfActionType.Goto)
		) {
			nativeReferences.add(reference);
		}
	}
	return links.filter((link) => {
		const reference = textReferenceForLink(link);
		return link.target || !reference || !nativeReferences.has(reference);
	});
}

/** Viewer-only hit target; never imported into annotations or written to the PDF. */
export function textReferenceLink(
	reference: TextReference,
	pageIndex: number,
	index: number,
	rect: Rect = reference.rect,
): TextReferenceLink {
	return {
		id: `text-ref-${pageIndex}-${index}`,
		pageIndex,
		type: PdfAnnotationSubtype.LINK,
		rect,
		textReference: reference,
	} as TextReferenceLink;
}
