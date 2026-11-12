/**
 * PDF selection-translate record.
 * Used for reading heatmap (page/rects) and reopenable result cards.
 */

export type PdfTranslateRect = {
	/** 0–1 relative to page box */
	x: number;
	y: number;
	w: number;
	h: number;
};

export type PdfTranslateRecord = {
	version: 1;
	/** marks/ discriminator */
	kind: "translate";
	id: string;
	/** Vault-relative paper folder when known; else absolute hint */
	paperPath: string;
	createdAt: string;
	/** Last update (result stream / complete) */
	updatedAt?: string;
	/** 1-based page number */
	page: number;
	rects: PdfTranslateRect[];
	/** All selected pages for a cross-page translation; page/rects anchor the card. */
	selectionPages?: { page: number; rects: PdfTranslateRect[] }[];
	/** Source text that was translated */
	quote?: string;
	/** Translation body (persisted so the card can be reopened) */
	result?: string;
	/** Whether a page gutter marker keeps this result reachable after hiding. */
	pinned: boolean;
	/** Last error message if the run failed */
	error?: string;
};
