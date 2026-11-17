import { PdfAnnotationSubtype, type PdfLinkAnnoObject } from "@embedpdf/models";
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

/** Viewer-only hit target; never imported into annotations or written to the PDF. */
export function textReferenceLink(
	reference: TextReference,
	pageIndex: number,
	index: number,
): TextReferenceLink {
	return {
		id: `text-ref-${pageIndex}-${index}`,
		pageIndex,
		type: PdfAnnotationSubtype.LINK,
		rect: reference.rect,
		textReference: reference,
	} as TextReferenceLink;
}
