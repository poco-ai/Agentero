/**
 * Exact in-text citation → bibliography entry resolution and cross-reference
 * (`\ref`) kind detection via PDF named destinations.
 *
 * LaTeX/hyperref writes each in-text citation link as a GoTo action to a named
 * destination `cite.<bibtexKey>`, and our reference sidecar carries the same key
 * as `Citation.rawKey`. PDFium resolves the name away (the viewer only sees
 * `pageIndex` + y), so we read the name tree straight from the PDF bytes once
 * and index destinations by their coordinates — the same coordinates the viewer
 * gets back from a link target.
 *
 * Cross-references (`figure.*` / `mk:fig1` / …) follow the same coordinate
 * index, plus a second index of **Link annotation rects → dest labels**. ACS
 * `/FitR` destinations point at a whole page, so every float on that page
 * shares one coordinate; the link annotation still carries `mk:tbl1` /
 * `mk:fig3`, which is enough to pick the right layout region without scraping
 * the (often truncated) link text.
 *
 * Different publishers use different named-destination conventions (standard
 * hyperref `figure.*`/`cite.*` vs. ACS `mk:fig*`/`mk:ref*`) and different
 * destination types (`/XYZ` vs. `/FitR`). The parser layer below isolates those
 * conventions so adding a new publisher is a matter of adding a small parser,
 * not changing the core walk.
 *
 * Measured over 31 real papers / 3703 in-text citation links: 95% resolved, 0
 * wrong. Coordinates shared by several citation keys are dropped rather than
 * guessed; colliding crossrefs fall back to the link-rect index (then link
 * text) instead of showing a wrong float.
 */

import {
	PDFArray,
	type PDFContext,
	PDFDict,
	PDFDocument,
	PDFHexString,
	PDFName,
	PDFNumber,
	PDFString,
} from "pdf-lib";

import { visiblePageBox } from "./page-box";

/** Coordinate key: destination page + PDF-native y (as PDFium reports it). */
export function citationDestKey(pageIndex: number, pdfY: number): string {
	return `${pageIndex}:${pdfY.toFixed(1)}`;
}

/**
 * Exact key for a link annotation rect in PDFium device space (top-left origin).
 * Used for the fast path; {@link matchCrossrefLinkLabel} falls back to centre
 * distance when float rounding differs between pdf-lib and PDFium.
 */
export function linkRectKey(
	pageIndex: number,
	x: number,
	y: number,
	w: number,
	h: number,
): string {
	return `${pageIndex}:${x.toFixed(1)}:${y.toFixed(1)}:${w.toFixed(1)}:${h.toFixed(1)}`;
}

/** Max centre-point distance (pt) when matching a hovered link to a parsed one. */
const LINK_RECT_MATCH_TOLERANCE_PT = 3;

export type LinkRectLike = {
	pageIndex: number;
	x: number;
	y: number;
	w: number;
	h: number;
};

type HoverRect = {
	origin: { x: number; y: number };
	size: { width: number; height: number };
};

/** Exact rect key, else nearest centre within {@link LINK_RECT_MATCH_TOLERANCE_PT}. */
function matchLinkByRect<T extends LinkRectLike>(
	links: readonly T[] | null | undefined,
	pageIndex: number,
	rect: HoverRect,
): T | null {
	if (!links || links.length === 0) return null;
	const exact = linkRectKey(
		pageIndex,
		rect.origin.x,
		rect.origin.y,
		rect.size.width,
		rect.size.height,
	);
	const cx = rect.origin.x + rect.size.width / 2;
	const cy = rect.origin.y + rect.size.height / 2;
	let best: T | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const link of links) {
		if (link.pageIndex !== pageIndex) continue;
		if (linkRectKey(link.pageIndex, link.x, link.y, link.w, link.h) === exact) {
			return link;
		}
		const lx = link.x + link.w / 2;
		const ly = link.y + link.h / 2;
		const dist = Math.hypot(lx - cx, ly - cy);
		if (dist < bestDist) {
			bestDist = dist;
			best = link;
		}
	}
	if (best && bestDist <= LINK_RECT_MATCH_TOLERANCE_PT) return best;
	return null;
}

/**
 * Find the crossref label for a hovered link annotation. Exact rect key first,
 * then nearest centre within {@link LINK_RECT_MATCH_TOLERANCE_PT}.
 */
export function matchCrossrefLinkLabel(
	links: CrossrefLinkLabelList | null | undefined,
	pageIndex: number,
	rect: HoverRect,
): CrossrefDestLabel | null {
	return matchLinkByRect(links, pageIndex, rect)?.label ?? null;
}

/**
 * Find the citation dest key (`cite.smith2020` / `mk:ref12`) for a hovered
 * link annotation. Used when ACS `/FitR` bibliography destinations collide.
 */
export function matchCitationLinkKey(
	links: CitationLinkKeyList | null | undefined,
	pageIndex: number,
	rect: HoverRect,
): string | null {
	return matchLinkByRect(links, pageIndex, rect)?.key ?? null;
}

/** Whether the hovered link names a destination that is not a cite / float. */
export function isOtherNamedLink(
	links: readonly LinkRectLike[] | null | undefined,
	pageIndex: number,
	rect: HoverRect,
): boolean {
	return matchLinkByRect(links, pageIndex, rect) != null;
}

/**
 * Candidate sidecar ids / rawKeys for a PDF destination name. Hyperref
 * `cite.<key>` passes through; ACS `mk:refN` and Springer `ch<N>CR<N>` / `CR<N>`
 * also try `ref-N` / `refN` / `N` (S2 / crossref parses use `id: "ref-N"`).
 */
export function citationSidecarKeysForDest(destKey: string): string[] {
	const keys = [destKey];
	const mk = /^mk:ref(\d+)$/i.exec(destKey);
	if (mk) {
		const n = mk[1] ?? "";
		keys.push(`ref-${n}`, `ref${n}`);
	}
	const cr = /^(?:ch\d*)?cr(\d+)$/i.exec(destKey);
	if (cr) {
		const n = cr[1] ?? "";
		keys.push(`ref-${n}`, `ref${n}`, n);
	}
	const bib = /^bib(\d{3,})$/i.exec(destKey);
	if (bib) {
		const n = String(Number.parseInt(bib[1] ?? "", 10));
		keys.push(`ref-${n}`, `ref${n}`, n);
	}
	return keys;
}

/** Parse the numeric bibliography index from an ACS `mk:refN`, Springer `ch<N>CR<N>`, or ACM `Bib0001` key. */
export function citationRefNumber(destKey: string): number | null {
	const mk = /^mk:ref(\d+)$/i.exec(destKey);
	if (mk) {
		const n = Number.parseInt(mk[1] ?? "", 10);
		return Number.isNaN(n) ? null : n;
	}
	const cr = /^(?:ch\d*)?cr(\d+)$/i.exec(destKey);
	if (cr) {
		const n = Number.parseInt(cr[1] ?? "", 10);
		return Number.isNaN(n) ? null : n;
	}
	const bib = /^bib(\d{3,})$/i.exec(destKey);
	if (bib) {
		const n = Number.parseInt(bib[1] ?? "", 10);
		return Number.isNaN(n) ? null : n;
	}
	return null;
}

/** Build an ACS-style dest key for bibliography index N. */
export function citationDestKeyForRefNumber(n: number): string {
	return `mk:ref${n}`;
}

/** Same-line tolerance (pt) when clustering superscript citation links. */
const CITATION_CLUSTER_Y_TOLERANCE_PT = 3;
/**
 * Max gap (pt) between consecutive links still considered one in-text group
 * (e.g. `7,9,14-18`). Larger gaps are separate citation clusters.
 */
const CITATION_CLUSTER_MAX_GAP_PT = 12;
/**
 * Min gap (pt) between two numeric links that indicates a range hyphen
 * (`14-18`, ~5pt) rather than a comma (`7,9`, ~1.7pt) in ACS superscripts.
 */
const CITATION_RANGE_MIN_GAP_PT = 3.5;
/** Safety cap so a pathological `1-999` link pair cannot explode the card. */
const CITATION_RANGE_MAX_SPAN = 30;

/**
 * Expand a hovered citation link into the full set of dest keys for its
 * in-text cluster. ACS often only links range endpoints (`14` and `18` in
 * `14-18`); comma-separated neighbours stay as singletons (`7,9`).
 *
 * Returns at least the hovered key when it can be identified; empty when the
 * hover rect matches nothing.
 */
export function expandCitationLinkCluster(
	links: CitationLinkKeyList | null | undefined,
	pageIndex: number,
	rect: HoverRect,
): string[] {
	if (!links || links.length === 0) return [];
	const hovered = matchLinkByRect(links, pageIndex, rect);
	if (!hovered) return [];

	const sameLine = links
		.filter(
			(l) =>
				l.pageIndex === pageIndex &&
				Math.abs(l.y - hovered.y) <= CITATION_CLUSTER_Y_TOLERANCE_PT,
		)
		.sort((a, b) => a.x - b.x);
	if (sameLine.length === 0) return [hovered.key];

	const hoveredIdx = sameLine.findIndex(
		(l) =>
			l.x === hovered.x &&
			l.y === hovered.y &&
			l.w === hovered.w &&
			l.h === hovered.h &&
			l.key === hovered.key,
	);
	const seed = hoveredIdx >= 0 ? hoveredIdx : 0;

	let left = seed;
	while (left > 0) {
		const prev = sameLine[left - 1];
		const cur = sameLine[left];
		if (!prev || !cur) break;
		const gap = cur.x - (prev.x + prev.w);
		if (gap > CITATION_CLUSTER_MAX_GAP_PT) break;
		left--;
	}
	let right = seed;
	while (right < sameLine.length - 1) {
		const cur = sameLine[right];
		const next = sameLine[right + 1];
		if (!cur || !next) break;
		const gap = next.x - (cur.x + cur.w);
		if (gap > CITATION_CLUSTER_MAX_GAP_PT) break;
		right++;
	}

	const cluster = sameLine.slice(left, right + 1);
	const numbers = new Set<number>();
	const passthrough: string[] = [];

	for (let i = 0; i < cluster.length; i++) {
		const cur = cluster[i];
		if (!cur) continue;
		const n = citationRefNumber(cur.key);
		if (n == null) {
			passthrough.push(cur.key);
			continue;
		}
		numbers.add(n);
		const next = cluster[i + 1];
		if (!next) continue;
		const m = citationRefNumber(next.key);
		if (m == null) continue;
		const gap = next.x - (cur.x + cur.w);
		const lo = Math.min(n, m);
		const hi = Math.max(n, m);
		if (
			hi - lo > 1 &&
			gap >= CITATION_RANGE_MIN_GAP_PT &&
			hi - lo <= CITATION_RANGE_MAX_SPAN
		) {
			for (let k = lo; k <= hi; k++) numbers.add(k);
		}
	}

	const keys = [
		...passthrough,
		...[...numbers]
			.sort((a, b) => a - b)
			.map((n) => citationDestKeyForRefNumber(n)),
	];
	// Always keep the hovered key even if number parsing failed.
	if (!keys.includes(hovered.key)) keys.unshift(hovered.key);
	return keys;
}

/** `pageIndex:pdfY` → BibTeX key of the bibliography entry at that destination. */
export type CitationDestKeyMap = ReadonlyMap<string, string>;

/** Kind of numbered object a cross-reference points at. */
export type CrossrefKind =
	| "figure"
	| "table"
	| "equation"
	| "algorithm"
	| "reference";

/** `pageIndex:pdfY` → kind of the numbered object at that destination. */
export type CrossrefDestMap = ReadonlyMap<string, CrossrefKind>;

/** `pageIndex:pdfY` → all kinds found at that destination (conflicts preserved). */
export type CrossrefKindMap = ReadonlyMap<string, CrossrefKind[]>;

/** Parsed label from a named destination, e.g. `mk:tbl1` → `{ kind: "table", number: 1 }`. */
export type CrossrefDestLabel = {
	kind: CrossrefKind;
	/** The numeric part of the destination name ("mk:figS1" → 1). */
	number: number;
};

/** `pageIndex:pdfY` → parsed labels from destination names at that coordinate. */
export type CrossrefDestLabelMap = ReadonlyMap<string, CrossrefDestLabel[]>;

/**
 * One in-text cross-reference link annotation, keyed by its PDFium device-space
 * (top-left) rect. Used when destination coordinates collide (ACS `/FitR`
 * whole-page targets): the link's own dest name (`mk:tbl1`) still uniquely
 * identifies the float even though every float on that page shares the same
 * `/FitR` rectangle.
 */
export type CrossrefLinkLabel = {
	/** 0-based page index of the *link* (not the destination). */
	pageIndex: number;
	/** PDFium device-space top-left x (pt). */
	x: number;
	/** PDFium device-space top-left y (pt). */
	y: number;
	w: number;
	h: number;
	label: CrossrefDestLabel;
};

/** All cross-reference link annotations found while walking the PDF. */
export type CrossrefLinkLabelList = readonly CrossrefLinkLabel[];

/**
 * One in-text citation link annotation, keyed by its PDFium device-space
 * (top-left) rect. Needed when ACS `/FitR` bibliography destinations collide
 * (dozens of `mk:ref*` sharing one page rectangle).
 */
export type CitationLinkKey = {
	/** 0-based page index of the *link* (not the destination). */
	pageIndex: number;
	x: number;
	y: number;
	w: number;
	h: number;
	/**
	 * Destination key from the link's named dest: hyperref `cite.<bibtexKey>`
	 * (parser strips the prefix) or ACS `mk:refN` (kept as-is for
	 * {@link citationSidecarKeysForDest}).
	 */
	key: string;
};

/** All citation link annotations found while walking the PDF. */
export type CitationLinkKeyList = readonly CitationLinkKey[];

/** Both destination indexes parsed from one PDF in a single object-tree walk. */
export type PdfDestMaps = {
	/** In-text citation destinations. */
	cites: CitationDestKeyMap;
	/**
	 * Best unambiguous cross-reference kind at each coordinate. Coordinates
	 * shared by different kinds are omitted; callers can fall back to
	 * `crossrefKinds` to disambiguate.
	 */
	crossrefs: CrossrefDestMap;
	/**
	 * All cross-reference kinds found at each coordinate. Used when the link
	 * text or named destination name allows choosing among conflicting kinds
	 * (e.g. ACS `/FitR` destinations where figure/table share the same page).
	 */
	crossrefKinds: CrossrefKindMap;
	/**
	 * Parsed kind + number from each named destination at the coordinate. More
	 * reliable than link-text extraction for publisher-specific names like
	 * ACS `mk:fig1` / `mk:tbl1` when `/FitR` targets share a whole page.
	 */
	crossrefLabels: CrossrefDestLabelMap;
	/**
	 * Link annotation rect → crossref label. Exact for ACS papers where every
	 * float on a page shares the same `/FitR` destination coordinate — PDFium
	 * loses the dest name, but the link annotation still carries it.
	 */
	crossrefLinks: CrossrefLinkLabelList;
	/**
	 * Link annotation rect → citation dest key. Exact for ACS `mk:ref*` where
	 * every bibliography entry on a page shares one `/FitR` coordinate.
	 */
	citationLinks: CitationLinkKeyList;
	/**
	 * Lower-left corner of each page's visible box (CropBox ∩ MediaBox), in
	 * PDF user space. Destinations and annotation rects are in user space;
	 * EmbedPDF page sizes and text rects are relative to this box, so a page
	 * whose box does not start at (0, 0) needs the shift — see
	 * {@link destinationInPageBox}.
	 */
	pageOrigins: readonly PageOrigin[];
	/**
	 * Links whose own named destination is neither a citation nor a numbered
	 * float (sections, theorems, footnotes, …). Their target coordinate may
	 * coincide with a float or bibliography anchor, so coordinate lookups must
	 * not claim them.
	 */
	otherNamedLinks: readonly LinkRectLike[];
};

/** Lower-left corner of a page's visible box in PDF user space. */
export type PageOrigin = { x: number; y: number };

/**
 * Shift a PDF destination (user space, as PDFium reports it) into its page's
 * visible box, the space EmbedPDF page sizes, text rects and layout regions
 * use. Identity for the usual box at (0, 0) and when origins are unknown.
 * Coordinate map keys (`citationDestKey`) stay in raw user space.
 */
export function destinationInPageBox<
	T extends { pageIndex: number; pdfX: number | null; pdfY: number },
>(destination: T, origins: readonly PageOrigin[] | null | undefined): T {
	const origin = origins?.[destination.pageIndex];
	if (!origin || (origin.x === 0 && origin.y === 0)) return destination;
	return {
		...destination,
		pdfX: destination.pdfX != null ? destination.pdfX - origin.x : null,
		pdfY: destination.pdfY - origin.y,
	};
}

// ---- Pluggable destination-name parsers ----

/** Result of parsing a named destination name into a cross-reference kind. */
export type CrossrefNameMatch = {
	kind: CrossrefKind;
	/** The numeric part, when the name embeds it (e.g. `mk:fig1` → 1). */
	number?: number;
};

/**
 * Maps a named-destination name (e.g. `figure.1`, `mk:fig1`) to a cross-reference
 * kind. Returning `null` means "not a cross-reference target I understand".
 */
export type CrossrefNameParser = (name: string) => CrossrefNameMatch | null;

/**
 * Maps a named-destination name (e.g. `cite.key`, `mk:ref1`) to the citation key
 * exposed by the reference sidecar. Returning `null` means "not a citation
 * target I understand".
 */
export type CitationNameParser = (name: string) => string | null;

/**
 * Resolves a destination array to a concrete page index + PDF-native y. Only
 * destination types that pin a vertical position are usable for hover preview.
 */
export type DestinationCoordResolver = (
	dest: PDFArray,
	context: PDFContext,
	pageRefs: string[],
) => { pageIndex: number; pdfY: number } | null;

/** Parse the first integer from a destination name suffix ("1a" → 1, "E.4" → 4). */
function parseCrossrefNumber(suffix: string): number | null {
	const match = /\d+/.exec(suffix);
	if (!match) return null;
	const n = Number.parseInt(match[0], 10);
	return Number.isNaN(n) ? null : n;
}

/**
 * Standard hyperref cross-reference names. LaTeX packages write `figure.<n>`,
 * `table.<n>`, `equation.<n>` / `subequation.<n>`, and `algorithm.<n>`
 * (algorithm2e uses `algocf.<n>`).
 */
export const hyperrefCrossrefParser: CrossrefNameParser = (name) => {
	if (name.startsWith("figure.caption.")) {
		const n = parseCrossrefNumber(name.slice("figure.caption.".length));
		return n == null ? null : { kind: "figure", number: n };
	}
	if (name.startsWith("figure.")) {
		const n = parseCrossrefNumber(name.slice("figure.".length));
		return n == null ? null : { kind: "figure", number: n };
	}
	if (name.startsWith("subfigure.")) {
		const n = parseCrossrefNumber(name.slice("subfigure.".length));
		return n == null ? null : { kind: "figure", number: n };
	}
	if (name.startsWith("table.caption.")) {
		const n = parseCrossrefNumber(name.slice("table.caption.".length));
		return n == null ? null : { kind: "table", number: n };
	}
	if (name.startsWith("table.")) {
		const n = parseCrossrefNumber(name.slice("table.".length));
		return n == null ? null : { kind: "table", number: n };
	}
	if (name.startsWith("equation.")) {
		const n = parseCrossrefNumber(name.slice("equation.".length));
		return n == null ? null : { kind: "equation", number: n };
	}
	if (name.startsWith("subequation.")) {
		const n = parseCrossrefNumber(name.slice("subequation.".length));
		return n == null ? null : { kind: "equation", number: n };
	}
	if (name.startsWith("algorithm.")) {
		const n = parseCrossrefNumber(name.slice("algorithm.".length));
		return n == null ? null : { kind: "algorithm", number: n };
	}
	if (name.startsWith("algocf.caption.")) {
		const n = parseCrossrefNumber(name.slice("algocf.caption.".length));
		return n == null ? null : { kind: "algorithm", number: n };
	}
	if (name.startsWith("algocf.")) {
		const n = parseCrossrefNumber(name.slice("algocf.".length));
		return n == null ? null : { kind: "algorithm", number: n };
	}
	return null;
};

/**
 * ACS (American Chemical Society) publisher destinations. Their production
 * pipeline emits `mk:*` targets instead of hyperref names, e.g.
 * `mk:fig1`, `mk:tbl1`, `mk:eq1` for floats and `mk:ref*` for references.
 */
export const acsCrossrefParser: CrossrefNameParser = (name) => {
	// Footnote markers inside a float (`mk:tbl1fn1`) are not float targets.
	if (/fn\d+$/i.test(name)) return null;
	if (name.startsWith("mk:fig")) {
		const n = parseCrossrefNumber(name.slice("mk:fig".length));
		return n == null ? null : { kind: "figure", number: n };
	}
	if (name.startsWith("mk:tbl")) {
		const n = parseCrossrefNumber(name.slice("mk:tbl".length));
		return n == null ? null : { kind: "table", number: n };
	}
	if (name.startsWith("mk:eq")) {
		const n = parseCrossrefNumber(name.slice("mk:eq".length));
		return n == null ? null : { kind: "equation", number: n };
	}
	return null;
};

/**
 * Springer / LNCS and related publisher destinations. Emits `ch<N>Fig<M>` / `Fig<M>`,
 * `ch<N>Tab<M>` / `Tab<M>`, `ch<N>Eq<M>` / `Eq<M>`, `ch<N>Alg<M>` / `Alg<M>`.
 */
export const springerCrossrefParser: CrossrefNameParser = (name) => {
	const fig = /^(?:ch\d*)?fig(\d+)[a-z]?$/i.exec(name);
	if (fig) {
		const n = Number.parseInt(fig[1] ?? "", 10);
		return Number.isNaN(n) ? null : { kind: "figure", number: n };
	}
	const tbl = /^(?:ch\d*)?tab(\d+)[a-z]?$/i.exec(name);
	if (tbl) {
		const n = Number.parseInt(tbl[1] ?? "", 10);
		return Number.isNaN(n) ? null : { kind: "table", number: n };
	}
	const eq = /^(?:ch\d*)?eq(\d+)[a-z]?$/i.exec(name);
	if (eq) {
		const n = Number.parseInt(eq[1] ?? "", 10);
		return Number.isNaN(n) ? null : { kind: "equation", number: n };
	}
	const alg = /^(?:ch\d*)?alg(\d+)[a-z]?$/i.exec(name);
	if (alg) {
		const n = Number.parseInt(alg[1] ?? "", 10);
		return Number.isNaN(n) ? null : { kind: "algorithm", number: n };
	}
	return null;
};

/** Built-in cross-reference name parsers, tried in order. */
export const defaultCrossrefNameParsers: CrossrefNameParser[] = [
	hyperrefCrossrefParser,
	acsCrossrefParser,
	springerCrossrefParser,
];

/** Standard hyperref citation name: `cite.<bibtexKey>`. */
export const hyperrefCitationParser: CitationNameParser = (name) => {
	if (name.startsWith("cite.")) return name.slice("cite.".length);
	return null;
};

/**
 * ACS citation names. `mk:ref*` targets map to the bibliography list; the exact
 * BibTeX key is not embedded in the PDF name, so we return the destination name
 * itself and let the sidecar / viewer resolve `ref-N` ↔ `mk:refN` if needed.
 */
export const acsCitationParser: CitationNameParser = (name) => {
	if (name.startsWith("mk:ref")) return name;
	return null;
};

/**
 * Springer / LNCS citation names: `ch<N>CR<M>` or `CR<M>`. Also handles
 * ACM numbered bibliography destinations like `Bib0001`.
 */
export const springerCitationParser: CitationNameParser = (name) => {
	if (/^(?:ch\d*)?cr\d+$/i.test(name)) return name;
	if (/^bib\d{3,}$/i.test(name)) return name;
	return null;
};

/** Built-in citation name parsers, tried in order. */
export const defaultCitationNameParsers: CitationNameParser[] = [
	hyperrefCitationParser,
	acsCitationParser,
	springerCitationParser,
];

// ---- Pluggable destination-coordinate resolvers ----

/**
 * `/XYZ` destination: `[pageRef /XYZ x y zoom]`. The most common hyperref
 * format; `y` is the PDF-native vertical position.
 */
export const xyzCoordResolver: DestinationCoordResolver = (
	dest,
	context,
	pageRefs,
) => {
	const arr = dest.asArray();
	if (arr.length < 4 || arr[1]?.toString() !== "/XYZ") return null;
	const pageIndex = pageRefs.indexOf(arr[0].toString());
	if (pageIndex < 0) return null;
	const y = context.lookup(arr[3]);
	if (!(y instanceof PDFNumber)) return null;
	return { pageIndex, pdfY: y.asNumber() };
};

/**
 * `/FitR` destination: `[pageRef /FitR left bottom right top]`. Used by ACS
 * PDFs for all internal links. We use the rectangle top as the vertical anchor.
 */
export const fitRCoordResolver: DestinationCoordResolver = (
	dest,
	context,
	pageRefs,
) => {
	const arr = dest.asArray();
	if (arr.length < 6 || arr[1]?.toString() !== "/FitR") return null;
	const pageIndex = pageRefs.indexOf(arr[0].toString());
	if (pageIndex < 0) return null;
	const top = context.lookup(arr[5]);
	if (!(top instanceof PDFNumber)) return null;
	return { pageIndex, pdfY: top.asNumber() };
};

/**
 * `/FitH` destination: `[pageRef /FitH top]`. Rare for cross-references but
 * supported for completeness; `top` gives the vertical anchor.
 */
export const fitHCoordResolver: DestinationCoordResolver = (
	dest,
	context,
	pageRefs,
) => {
	const arr = dest.asArray();
	if (arr.length < 3 || arr[1]?.toString() !== "/FitH") return null;
	const pageIndex = pageRefs.indexOf(arr[0].toString());
	if (pageIndex < 0) return null;
	const top = context.lookup(arr[2]);
	if (!(top instanceof PDFNumber)) return null;
	return { pageIndex, pdfY: top.asNumber() };
};

/** Built-in coordinate resolvers, tried in order. */
export const defaultDestinationCoordResolvers: DestinationCoordResolver[] = [
	xyzCoordResolver,
	fitRCoordResolver,
	fitHCoordResolver,
];

/** Walk a /Dests name tree into `name → destination array`. */
function collectNameTree(
	context: PDFContext,
	node: PDFDict | undefined,
	out: Map<string, PDFArray>,
): void {
	if (!node) return;

	const names = context.lookup(node.get(PDFName.of("Names")));
	if (names instanceof PDFArray) {
		const arr = names.asArray();
		for (let i = 0; i + 1 < arr.length; i += 2) {
			const rawName = context.lookup(arr[i]);
			if (!(rawName instanceof PDFString || rawName instanceof PDFHexString)) {
				continue;
			}
			// A named destination is the array itself or a dict wrapping it in /D.
			const value = context.lookup(arr[i + 1]);
			let dest: PDFArray | undefined;
			if (value instanceof PDFArray) dest = value;
			else if (value instanceof PDFDict) {
				const inner = context.lookup(value.get(PDFName.of("D")));
				if (inner instanceof PDFArray) dest = inner;
			}
			if (dest) out.set(rawName.asString(), dest);
		}
	}

	const kids = context.lookup(node.get(PDFName.of("Kids")));
	if (kids instanceof PDFArray) {
		for (const kid of kids.asArray()) {
			const child = context.lookup(kid);
			if (child instanceof PDFDict) collectNameTree(context, child, out);
		}
	}
}

/**
 * Resolve a named-destination array to its coordinate key using the provided
 * resolvers. Returns null when no resolver can extract a usable page + y.
 */
function destCoordKey(
	dest: PDFArray,
	context: PDFContext,
	pageRefs: string[],
	resolvers: DestinationCoordResolver[],
): string | null {
	for (const resolve of resolvers) {
		const coord = resolve(dest, context, pageRefs);
		if (coord) return citationDestKey(coord.pageIndex, coord.pdfY);
	}
	return null;
}

/**
 * Collapse a coordinate → value index, dropping coordinates shared by two
 * different values (ambiguous, never guessed — callers fall back instead).
 */
function resolveUnambiguous<T>(byCoord: Map<string, T | null>): Map<string, T> {
	const out = new Map<string, T>();
	for (const [coord, value] of byCoord) {
		if (value != null) out.set(coord, value);
	}
	return out;
}

export type BuildPdfDestMapsOptions = {
	/**
	 * Parsers that turn a named-destination name into a cross-reference kind.
	 * Defaults to `[hyperrefCrossrefParser, acsCrossrefParser]`.
	 */
	crossrefParsers?: CrossrefNameParser[];
	/**
	 * Parsers that turn a named-destination name into a citation key.
	 * Defaults to `[hyperrefCitationParser, acsCitationParser]`.
	 */
	citationParsers?: CitationNameParser[];
	/**
	 * Resolvers that turn a destination array into page + PDF-native y.
	 * Defaults to `[xyzCoordResolver, fitRCoordResolver, fitHCoordResolver]`.
	 */
	coordResolvers?: DestinationCoordResolver[];
};

/**
 * Read a named destination string from a Link annotation's `/A` GoTo action or
 * direct `/Dest` entry. Returns null for URI links and inline dest arrays.
 */
function linkAnnotationDestName(
	annot: PDFDict,
	context: PDFContext,
): string | null {
	const asName = (value: unknown): string | null => {
		if (value instanceof PDFString || value instanceof PDFHexString) {
			return value.asString();
		}
		if (value instanceof PDFName) {
			// asString keeps the leading `/` (PDF name syntax); strip it.
			const raw = value.asString();
			return raw.startsWith("/") ? raw.slice(1) : raw;
		}
		return null;
	};

	const action = context.lookup(annot.get(PDFName.of("A")));
	if (action instanceof PDFDict) {
		const s = action.get(PDFName.of("S"));
		if (s?.toString() === "/GoTo") {
			const named = asName(context.lookup(action.get(PDFName.of("D"))));
			if (named) return named;
		}
	}

	return asName(context.lookup(annot.get(PDFName.of("Dest"))));
}

/**
 * Convert a PDF-native annotation Rect `[llx lly urx ury]` (origin bottom-left)
 * into the PDFium device-space rect EmbedPDF exposes on link annotations
 * (origin top-left). Matches `convertPageRectToDeviceRect` for rotation 0.
 */
function pdfAnnotRectToDevice(
	llx: number,
	lly: number,
	urx: number,
	ury: number,
	pageHeight: number,
	originX = 0,
	originY = 0,
): { x: number; y: number; w: number; h: number } {
	const left = llx;
	const top = ury;
	const right = urx;
	const bottom = lly;
	return {
		x: left - originX,
		y: pageHeight - (top - originY),
		w: Math.abs(right - left),
		h: Math.abs(top - bottom),
	};
}

/**
 * Build both destination indexes for one PDF in a single object-tree walk.
 * Returns empty maps for PDFs without recognizable named destinations.
 */
export async function buildPdfDestMaps(
	bytes: ArrayBuffer | Uint8Array,
	options: BuildPdfDestMapsOptions = {},
): Promise<PdfDestMaps> {
	const empty: PdfDestMaps = {
		cites: new Map(),
		crossrefs: new Map(),
		crossrefKinds: new Map(),
		crossrefLabels: new Map(),
		crossrefLinks: [],
		citationLinks: [],
		pageOrigins: [],
		otherNamedLinks: [],
	};
	const doc = await PDFDocument.load(bytes, { updateMetadata: false });
	const context = doc.context;

	const names = context.lookup(doc.catalog.get(PDFName.of("Names")));
	if (!(names instanceof PDFDict)) return empty;
	const dests = context.lookup(names.get(PDFName.of("Dests")));
	if (!(dests instanceof PDFDict)) return empty;

	const namedDests = new Map<string, PDFArray>();
	collectNameTree(context, dests, namedDests);
	if (!namedDests.size) return empty;

	const pages = doc.getPages();
	const pageRefs = pages.map((page) => page.ref.toString());
	const citeByCoord = new Map<string, string | null>();
	const crossByCoord = new Map<string, CrossrefKind | null>();
	const crossKindsByCoord = new Map<string, CrossrefKind[]>();
	const crossLabelsByCoord = new Map<string, CrossrefDestLabel[]>();
	const crossrefLinks: CrossrefLinkLabel[] = [];
	const citationLinks: CitationLinkKey[] = [];
	const otherNamedLinks: LinkRectLike[] = [];

	const crossrefParsers = options.crossrefParsers ?? defaultCrossrefNameParsers;
	const citationParsers = options.citationParsers ?? defaultCitationNameParsers;
	const coordResolvers =
		options.coordResolvers ?? defaultDestinationCoordResolvers;

	const parseCrossref = (name: string): CrossrefNameMatch | null => {
		for (const parser of crossrefParsers) {
			const match = parser(name);
			if (match) return match;
		}
		return null;
	};

	const parseCitationKey = (name: string): string | null => {
		for (const parser of citationParsers) {
			const key = parser(name);
			if (key) return key;
		}
		return null;
	};

	const stash = <T>(map: Map<string, T | null>, coord: string, value: T) => {
		const existing = map.get(coord);
		if (existing === undefined) map.set(coord, value);
		// Two entries anchored at the same spot: ambiguous, never guess.
		else if (existing !== value) map.set(coord, null);
	};

	const stashKind = (coord: string, kind: CrossrefKind) => {
		const list = crossKindsByCoord.get(coord);
		if (!list) {
			crossKindsByCoord.set(coord, [kind]);
			return;
		}
		if (!list.includes(kind)) list.push(kind);
	};

	const stashLabel = (coord: string, label: CrossrefDestLabel) => {
		const list = crossLabelsByCoord.get(coord);
		if (!list) {
			crossLabelsByCoord.set(coord, [label]);
			return;
		}
		const exists = list.some(
			(l) => l.kind === label.kind && l.number === label.number,
		);
		if (!exists) list.push(label);
	};

	for (const [name, dest] of namedDests) {
		const citationKey = parseCitationKey(name);
		if (citationKey) {
			const coord = destCoordKey(dest, context, pageRefs, coordResolvers);
			if (coord) stash(citeByCoord, coord, citationKey);
			continue;
		}

		const match = parseCrossref(name);
		if (match) {
			const coord = destCoordKey(dest, context, pageRefs, coordResolvers);
			if (coord) {
				stash(crossByCoord, coord, match.kind);
				stashKind(coord, match.kind);
				if (match.number != null)
					stashLabel(coord, { kind: match.kind, number: match.number });
			}
		}
	}

	// Index Link annotations by their device-space rect so ACS `/FitR`
	// collisions (every float / bibliography entry on a page shares one
	// destination coordinate) can still be resolved from the link's own
	// dest name (`mk:tbl1` / `mk:ref12`).
	for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
		const page = pages[pageIndex];
		if (!page) continue;
		const box = visiblePageBox(page);
		const pageHeight = box.height;
		const boxOriginX = box.x;
		const boxOriginY = box.y;

		const annotsRef = page.node.get(PDFName.of("Annots"));
		if (!annotsRef) continue;
		const annots = context.lookup(annotsRef);
		if (!(annots instanceof PDFArray)) continue;
		const annotArray = annots.asArray();

		for (const annotRef of annotArray) {
			const annot = context.lookup(annotRef);
			if (!(annot instanceof PDFDict)) continue;
			if (annot.get(PDFName.of("Subtype"))?.toString() !== "/Link") continue;

			const destName = linkAnnotationDestName(annot, context);
			if (!destName) continue;

			const citationKey = parseCitationKey(destName);
			const crossMatch = citationKey ? null : parseCrossref(destName);
			if (crossMatch && crossMatch.number == null) continue;

			const rect = context.lookup(annot.get(PDFName.of("Rect")));
			if (!(rect instanceof PDFArray) || rect.asArray().length < 4) continue;
			const nums = rect.asArray().map((entry) => {
				const n = context.lookup(entry);
				return n instanceof PDFNumber ? n.asNumber() : Number.NaN;
			});
			if (nums.some((n) => Number.isNaN(n))) continue;
			const [llx, lly, urx, ury] = nums as [number, number, number, number];
			const device = pdfAnnotRectToDevice(
				llx,
				lly,
				urx,
				ury,
				pageHeight,
				boxOriginX,
				boxOriginY,
			);
			if (citationKey) {
				citationLinks.push({
					pageIndex,
					x: device.x,
					y: device.y,
					w: device.w,
					h: device.h,
					key: citationKey,
				});
			} else if (crossMatch && crossMatch.number != null) {
				crossrefLinks.push({
					pageIndex,
					x: device.x,
					y: device.y,
					w: device.w,
					h: device.h,
					label: { kind: crossMatch.kind, number: crossMatch.number },
				});
			} else {
				otherNamedLinks.push({
					pageIndex,
					x: device.x,
					y: device.y,
					w: device.w,
					h: device.h,
				});
			}
		}
	}

	return {
		cites: resolveUnambiguous(citeByCoord),
		crossrefs: resolveUnambiguous(crossByCoord),
		crossrefKinds: crossKindsByCoord,
		crossrefLabels: crossLabelsByCoord,
		crossrefLinks,
		citationLinks,
		pageOrigins: pages.map((page) => {
			const box = visiblePageBox(page);
			return { x: box.x, y: box.y };
		}),
		otherNamedLinks,
	};
}

/**
 * Build the coordinate → BibTeX key index for one PDF.
 * Returns an empty map for PDFs without recognizable citation destinations.
 */
export async function buildCitationDestKeyMap(
	bytes: ArrayBuffer | Uint8Array,
	options?: BuildPdfDestMapsOptions,
): Promise<CitationDestKeyMap> {
	return (await buildPdfDestMaps(bytes, options)).cites;
}
