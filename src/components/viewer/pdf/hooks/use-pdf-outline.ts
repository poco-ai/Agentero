/**
 * Document outline (bookmarks / TOC) for the EmbedPDF viewer: the loaded
 * bookmark tree.
 *
 * The panel's open state lives in `use-pdf-left-panels` next to the other
 * left-rail panels; this hook only owns the bookmark data. The load also
 * publishes the tree to `setPaperOutline` so Markdown annotation embeds can
 * render location breadcrumbs, which is the only cross-feature edge and
 * belongs next to its single writer.
 */

import type { PdfBookmarkObject } from "@embedpdf/models";
import type { BookmarkCapability } from "@embedpdf/plugin-bookmark/react";
import { useEffect, useState } from "react";
import { setPaperOutline } from "@/lib/pdf/outline-location";

export type UsePdfOutlineOptions = {
	/** EmbedPDF capability; owned by `PdfViewerInner` (plugin context). */
	bookmarkCap: Readonly<BookmarkCapability> | null;
	docId: string;
	/** Bookmarks are only readable once the document reports its page count. */
	totalPages: number;
	paperAbsPath: string | null;
	paperRelPath: string | null;
};

export type PdfOutline = {
	outline: PdfBookmarkObject[];
	outlineReady: boolean;
};

export function usePdfOutline({
	bookmarkCap,
	docId,
	totalPages,
	paperAbsPath,
	paperRelPath,
}: UsePdfOutlineOptions): PdfOutline {
	const [outline, setOutline] = useState<PdfBookmarkObject[]>([]);
	const [outlineReady, setOutlineReady] = useState(false);

	// Load the document outline (bookmarks / TOC) once available.
	useEffect(() => {
		if (!bookmarkCap || totalPages <= 0) return;
		let cancelled = false;
		void bookmarkCap
			.forDocument(docId)
			.getBookmarks()
			.toPromise()
			.then((res) => {
				if (cancelled) return;
				const bookmarks = res?.bookmarks ?? [];
				setOutlineReady(true);
				setOutline(bookmarks);
				// Share with annotation embeds for location breadcrumbs.
				const paperKey = paperAbsPath || paperRelPath;
				if (paperKey) setPaperOutline(paperKey, bookmarks);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [bookmarkCap, docId, totalPages, paperAbsPath, paperRelPath]);

	return { outline, outlineReady };
}
