/**
 * Dedicated worker: parse hyperref named destinations off the main thread.
 *
 * pdf-lib has no lazy parsing — `PDFDocument.load` walks the whole PDF object
 * tree, which blocks for seconds on 100MB+ papers. The parse runs here and
 * only the small `pageIndex:pdfY → value` entry lists (citations + cross-refs)
 * cross back.
 *
 * Entity-file module worker on purpose: blob-URL workers can fail to spawn on
 * Windows WebView2, so this must stay a real file that Vite bundles as its own
 * worker chunk (`new URL(..., import.meta.url)` in `citation-dest-map.ts`).
 */

import { errorText } from "@/lib/core/error";
import {
	buildPdfDestMaps,
	type CitationLinkKey,
	type CrossrefDestLabel,
	type CrossrefKind,
	type CrossrefLinkLabel,
	type LinkRectLike,
	type PageOrigin,
} from "@/lib/pdf/citation-dest-keys";

export type CitationDestKeysRequest = {
	id: number;
	/** PDF bytes; transferred in by the caller (zero-copy). */
	bytes: ArrayBuffer;
};

export type CitationDestKeysResponse =
	| {
			id: number;
			ok: true;
			cites: [string, string][];
			crossrefs: [string, CrossrefKind][];
			crossrefKinds: [string, CrossrefKind[]][];
			crossrefLabels: [string, CrossrefDestLabel[]][];
			crossrefLinks: CrossrefLinkLabel[];
			citationLinks: CitationLinkKey[];
			pageOrigins: PageOrigin[];
			otherNamedLinks: LinkRectLike[];
	  }
	| { id: number; ok: false; error: string };

/** Typed view of the dedicated-worker scope (tsconfig lib is DOM, not webworker). */
const scope = self as unknown as {
	onmessage: ((event: MessageEvent<CitationDestKeysRequest>) => void) | null;
	postMessage: (message: CitationDestKeysResponse) => void;
};

scope.onmessage = (event) => {
	const { id, bytes } = event.data;
	void buildPdfDestMaps(bytes)
		.then((maps) => {
			scope.postMessage({
				id,
				ok: true,
				cites: [...maps.cites.entries()],
				crossrefs: [...maps.crossrefs.entries()],
				crossrefKinds: [...maps.crossrefKinds.entries()],
				crossrefLabels: [...maps.crossrefLabels.entries()],
				crossrefLinks: [...maps.crossrefLinks],
				citationLinks: [...maps.citationLinks],
				pageOrigins: [...maps.pageOrigins],
				otherNamedLinks: [...maps.otherNamedLinks],
			});
		})
		.catch((error: unknown) => {
			scope.postMessage({
				id,
				ok: false,
				error: errorText(error),
			});
		});
};
