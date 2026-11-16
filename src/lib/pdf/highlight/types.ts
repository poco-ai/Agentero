/** PDF highlight annotation model. See docs/development/pdf-ask.md */

import type {
	PdfHighlightAnnoObject,
	PdfUnderlineAnnoObject,
} from "@embedpdf/models";

export type PdfHighlightRect = {
	/** 0–1 relative to page box */
	x: number;
	y: number;
	w: number;
	h: number;
};

/**
 * Shape of a text-markup annotation. The palette is orthogonal: every shape
 * accepts the same five colors. `highlight` and `underline` are the shapes the
 * reader can create; unknown stored values degrade to `highlight`.
 */
export type PdfTextMarkupKind = "highlight" | "underline";

/** EmbedPDF annotation object for either text-markup shape. */
export type PdfTextMarkupAnnoObject =
	| PdfHighlightAnnoObject
	| PdfUnderlineAnnoObject;

export type PdfHighlight = {
	version: 1;
	/** marks/ discriminator */
	kind: PdfTextMarkupKind;
	id: string;
	/** Vault-relative paper folder when known; else absolute hint */
	paperPath: string;
	createdAt: string;
	updatedAt: string;
	/** 1-based page number */
	page: number;
	/** Normalized rects covering the highlighted text */
	rects: PdfHighlightRect[];
	/** Highlighted source text */
	quote: string;
	/** Palette key (see pdf-highlight/palette); defaults to yellow when absent */
	color?: string;
	/** Zotero-style annotation note; non-empty means this highlight is an annotation */
	comment?: string;
	/**
	 * Page-fraction boxes of the translated text that was selected. Present
	 * only for highlights made on the translation overlay. English glyph boxes
	 * stay in `rects`.
	 */
	translatedRects?: PdfHighlightRect[];
};
