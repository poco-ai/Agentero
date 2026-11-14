/**
 * Cross-reference (`\ref`) hover preview for the EmbedPDF viewer: hovering a
 * "Fig. 3" / "Table 1" / "Eq. (2)" link shows a crop of the figure / table /
 * equation it points at.
 *
 * Resolution order (see `lib/pdf/citation-dest-keys`):
 * 1. Unambiguous dest coordinate → kind (standard hyperref `/XYZ`).
 * 2. Link annotation rect → dest label (`mk:tbl1` / `mk:fig3`) — needed when
 *    ACS `/FitR` destinations share a whole page across every float.
 * 3. Single label at the dest coordinate, or link-text extraction + caption
 *    match as a last resort.
 * Layout analysis supplies the region bbox; the crop is rendered on demand.
 *
 * Citations without sidecar metadata fall back to a crop of the bibliography
 * entry the link jumps to (`lib/pdf/destination-crop`). A link counts as a
 * citation when its own dest name says so (`cite.*`, `mk:refN`, …) or when it
 * covers a number inside a `[…]` group of numbers (`lib/pdf/link-text`)
 * *and* the destination line opens that entry. Anything else shows nothing.
 *
 * Its own hook because the preview is a self-contained hover state machine that
 * runs an async crop — kept separate from `usePdfCitations` (citations resolve
 * synchronously to a sidecar entry). A coordinate is either a `cite.*` or a
 * cross-reference destination, never both, so both hover handlers can run on
 * the same link and at most one card appears.
 */

import type {
	PdfDocumentObject,
	PdfEngine,
	PdfLinkAnnoObject,
	PdfPageObject,
} from "@embedpdf/models";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	pageElByIndex,
	rectBottomCenterScreen,
} from "@/components/viewer/pdf/coords";
import { EPHEMERAL_PREVIEW_HIDE_MS } from "@/components/viewer/pdf/floating-hover";
import { useStickyHoverHide } from "@/components/viewer/pdf/hooks/use-sticky-hover-hide";
import { getLinkDestination } from "@/components/viewer/pdf/layers/citation-links";
import { renderPdfRegionPromptImage } from "@/components/viewer/pdf/region-crop";
import type {
	CrossrefPreviewState,
	ScreenPoint,
} from "@/components/viewer/pdf/types";
import type { PromptImage } from "@/lib/agent/api";
import { LruCache } from "@/lib/core/lru-cache";
import {
	type CitationDestKeyMap,
	type CitationLinkKeyList,
	type CrossrefDestLabelMap,
	type CrossrefDestMap,
	type CrossrefKind,
	type CrossrefKindMap,
	type CrossrefLinkLabelList,
	citationDestKey,
	citationRefNumber,
	destinationInPageBox,
	isOtherNamedLink,
	type LinkRectLike,
	matchCitationLinkKey,
	matchCrossrefLinkLabel,
	type PageOrigin,
} from "@/lib/pdf/citation-dest-keys";
import { schedulePdfDestMapsBuild } from "@/lib/pdf/citation-dest-map";
import {
	extractCrossrefLabel,
	pickCrossrefRegion,
	pickCrossrefRegionByLabel,
} from "@/lib/pdf/crossref-resolve";
import { pickDestinationRegion } from "@/lib/pdf/destination-crop";
import { getLayoutDocumentResult } from "@/lib/pdf/layout";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";
import {
	linkLabelText,
	type PageTextRect,
	parseBracketCitation,
} from "@/lib/pdf/link-text";

/**
 * Preview crops render at zoom × devicePixelRatio so they match the page 1:1,
 * never below 2× (crisp when zoomed out) nor above 4×, and never longer than
 * this many pixels on either edge.
 */
const PREVIEW_CROP_MIN_SCALE = 2;
const PREVIEW_CROP_MAX_SCALE = 4;
const PREVIEW_CROP_MAX_EDGE_PX = 1600;

/**
 * Hover previews re-read the same pages and re-render the same crops as the
 * pointer moves across a citation list. Keep the last few per document.
 */
const TEXT_RECTS_CACHE_PAGES = 8;
const CROP_CACHE_ENTRIES = 24;

type PageTextRects = readonly PageTextRect[];

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

export type UsePdfCrossrefPreviewOptions = {
	docId: string;
	hostRef: RefObject<HTMLDivElement | null>;
	/** Current zoom, mirrored so the preview anchor never re-creates handlers. */
	zoomRef: RefObject<number>;
	/** Absolute paper folder; used to read PDF bytes for the dest map. */
	paperAbsPath: string | null;
	/** PDF bytes the viewer already holds; reused (copied) by the map build. */
	sourceBytes?: ArrayBuffer | null;
	/** Engine + document manager, for cropping the resolved region. */
	engineRef: RefObject<PdfEngine | null>;
	docCapRef: RefObject<DocumentManagerCapability>;
	/**
	 * Fired when a crossref card is about to show. Used by the viewer to clear
	 * sibling ephemeral overlays (citation preview).
	 */
	onPreviewShow?: () => void;
	/**
	 * Returns true when an in-text link resolves to structured citation metadata,
	 * in which case usePdfCitations renders its rich card and crossref preview stands down.
	 */
	hasCitationMatch?: (link: PdfLinkAnnoObject) => boolean;
};

export type PdfCrossrefPreview = {
	crossrefPreview: CrossrefPreviewState | null;
	cancelCrossrefHide: () => void;
	scheduleCrossrefHide: () => void;
	/** Keep the card open while the pointer is over it. */
	markCrossrefHoverEnter: () => void;
	/** Drop the preview immediately (overlay exclusivity / suppress). */
	clearCrossrefPreview: () => void;
	handleCrossrefLinkHover: (
		link: PdfLinkAnnoObject | null,
		clientPoint?: ScreenPoint | null,
	) => void;
};

export function usePdfCrossrefPreview({
	docId,
	hostRef,
	zoomRef,
	paperAbsPath,
	sourceBytes = null,
	engineRef,
	docCapRef,
	onPreviewShow,
	hasCitationMatch,
}: UsePdfCrossrefPreviewOptions): PdfCrossrefPreview {
	const onPreviewShowRef = useRef(onPreviewShow);
	onPreviewShowRef.current = onPreviewShow;
	const hasCitationMatchRef = useRef(hasCitationMatch);
	hasCitationMatchRef.current = hasCitationMatch;
	const [crossrefPreview, setCrossrefPreview] =
		useState<CrossrefPreviewState | null>(null);
	const hideCrossrefPreview = useCallback(() => setCrossrefPreview(null), []);
	/**
	 * Leave link / card. Delay so the pointer can bridge into the card; never
	 * dismiss while the card is still hovered / focused.
	 */
	const {
		hoverSurfaceRef: crossrefHoverSurfaceRef,
		cancelHide: cancelCrossrefHide,
		markHoverEnter: markCrossrefHoverEnter,
		scheduleHide: scheduleCrossrefHide,
	} = useStickyHoverHide({
		delayMs: EPHEMERAL_PREVIEW_HIDE_MS,
		hide: hideCrossrefPreview,
	});
	/** hyperref cross-reference destinations of the open PDF, by coords. */
	const crossrefMapRef = useRef<CrossrefDestMap | null>(null);
	/**
	 * All cross-reference kinds found at each coordinate. Used as a fallback when
	 * the unambiguous map drops a coordinate because multiple kinds share it
	 * (e.g. ACS `/FitR` destinations pointing at a whole page).
	 */
	const crossrefKindsRef = useRef<CrossrefKindMap | null>(null);
	/**
	 * Parsed kind + number from each named destination at the coordinate. More
	 * reliable than link-text extraction for publisher-specific names like ACS
	 * `mk:fig1` / `mk:tbl1` when `/FitR` targets share a whole page.
	 */
	const crossrefLabelsRef = useRef<CrossrefDestLabelMap | null>(null);
	/**
	 * Link annotation rect → label. Exact for ACS `/FitR` collisions where the
	 * destination coordinate is shared by every float on the page — the link's
	 * own dest name (`mk:tbl1` / `mk:fig3`) still uniquely identifies the float.
	 */
	const crossrefLinksRef = useRef<CrossrefLinkLabelList | null>(null);
	/** Visible page box origins, to map destinations into page space. */
	const pageOriginsRef = useRef<readonly PageOrigin[] | null>(null);
	const citesMapRef = useRef<CitationDestKeyMap | null>(null);
	const citationLinksRef = useRef<CitationLinkKeyList | null>(null);
	/** Links whose own dest name is neither a cite nor a float (by rect). */
	const otherNamedLinksRef = useRef<readonly LinkRectLike[] | null>(null);
	/** Monotonic token so a stale crop never lands over a newer hover. */
	const renderTokenRef = useRef(0);
	const activeLinkRef = useRef<PdfLinkAnnoObject | null>(null);
	/** True while the pointer is still on the link that opened the card. */
	const linkHoveringRef = useRef(false);
	/** Page text / rendered crops of `cachedDocRef`'s document. */
	const cachedDocRef = useRef<PdfDocumentObject | null>(null);
	const textRectsCacheRef = useRef(
		new LruCache<number, Promise<PageTextRects>>(TEXT_RECTS_CACHE_PAGES),
	);
	const cropCacheRef = useRef(
		new LruCache<string, PromptImage>(CROP_CACHE_ENTRIES),
	);

	/** Drop cached page data when the viewer swaps to another document object. */
	const cachesFor = useCallback((document: PdfDocumentObject) => {
		if (cachedDocRef.current !== document) {
			cachedDocRef.current = document;
			textRectsCacheRef.current.clear();
			cropCacheRef.current.clear();
		}
		return {
			textRects: textRectsCacheRef.current,
			crops: cropCacheRef.current,
		};
	}, []);

	/** `getPageTextRects`, shared across hovers of the same page. */
	const pageTextRects = useCallback(
		(
			engine: PdfEngine,
			document: PdfDocumentObject,
			page: PdfPageObject,
		): Promise<PageTextRects> => {
			const cache = cachesFor(document).textRects;
			const cached = cache.get(page.index);
			if (cached) return cached;
			const pending = engine.getPageTextRects(document, page).toPromise();
			cache.set(page.index, pending);
			// Failed reads must not stick.
			pending.catch(() => cache.delete(page.index));
			return pending;
		},
		[cachesFor],
	);

	const sourceBytesRef = useRef<ArrayBuffer | null>(sourceBytes);
	sourceBytesRef.current = sourceBytes;

	useEffect(() => {
		crossrefMapRef.current = null;
		crossrefKindsRef.current = null;
		crossrefLabelsRef.current = null;
		crossrefLinksRef.current = null;
		pageOriginsRef.current = null;
		citesMapRef.current = null;
		citationLinksRef.current = null;
		otherNamedLinksRef.current = null;
		if (!paperAbsPath) return;
		return schedulePdfDestMapsBuild({
			paperAbsPath,
			viewerBytes: () => sourceBytesRef.current,
			warnLabel: "crossref dest map failed",
			onMaps: (maps) => {
				crossrefMapRef.current = maps.crossrefs;
				crossrefKindsRef.current = maps.crossrefKinds;
				crossrefLabelsRef.current = maps.crossrefLabels;
				crossrefLinksRef.current = maps.crossrefLinks;
				pageOriginsRef.current = maps.pageOrigins;
				citesMapRef.current = maps.cites;
				citationLinksRef.current = maps.citationLinks;
				otherNamedLinksRef.current = maps.otherNamedLinks;
			},
		});
	}, [paperAbsPath]);

	// Reset the preview when the active PDF document changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: docId is the effect trigger, not a value read inside the effect.
	useEffect(() => {
		activeLinkRef.current = null;
		linkHoveringRef.current = false;
		cachedDocRef.current = null;
		textRectsCacheRef.current.clear();
		cropCacheRef.current.clear();
		crossrefHoverSurfaceRef.current = false;
		setCrossrefPreview(null);
	}, [docId]);

	const clearCrossrefPreview = useCallback(() => {
		cancelCrossrefHide();
		crossrefHoverSurfaceRef.current = false;
		// Invalidate in-flight crops so a stale resolve cannot remount the card.
		renderTokenRef.current += 1;
		setCrossrefPreview(null);
	}, [cancelCrossrefHide, crossrefHoverSurfaceRef]);

	const showPreview = useCallback(
		(
			link: PdfLinkAnnoObject,
			region: {
				pageIndex: number;
				bbox: { x: number; y: number; w: number; h: number };
			},
			kind: CrossrefKind,
			clientPoint?: ScreenPoint | null,
		) => {
			// A crop that resolves after the pointer has left both the link and
			// the card must not cancel the hide timer and stick the preview.
			if (!linkHoveringRef.current && !crossrefHoverSurfaceRef.current) return;
			cancelCrossrefHide();
			// Treat show as an active hover surface so mount-under-cursor skips
			// pointerenter do not auto-close.
			crossrefHoverSurfaceRef.current = true;
			const pageEl = pageElByIndex(hostRef.current, link.pageIndex);
			if (!pageEl) return;
			onPreviewShowRef.current?.();

			const document = docCapRef.current?.getDocument(docId) ?? null;
			const targetPage = document?.pages[region.pageIndex];
			const pageWidthPt = targetPage?.size.width ?? 612;
			const pageHeightPt = targetPage?.size.height ?? 792;
			const zoom = zoomRef.current && zoomRef.current > 0 ? zoomRef.current : 1;
			const targetWidth = Math.round(region.bbox.w * pageWidthPt * zoom);
			const targetHeight = Math.round(region.bbox.h * pageHeightPt * zoom);
			const screen =
				clientPoint ?? rectBottomCenterScreen(pageEl, link.rect, zoom);
			const dpr =
				typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
			const cropScale = Math.min(
				PREVIEW_CROP_MAX_SCALE,
				Math.max(PREVIEW_CROP_MIN_SCALE, zoom * dpr),
			);
			const { x, y, w, h } = region.bbox;
			const cropKey = [region.pageIndex, x, y, w, h, cropScale]
				.map((n) => Math.round(n * 1e4))
				.join(":");
			const crops = document ? cachesFor(document).crops : null;
			const cachedImage = crops?.get(cropKey) ?? null;

			setCrossrefPreview({
				screen,
				kind,
				page: region.pageIndex + 1,
				region: region.bbox,
				image: cachedImage,
				targetSize: { width: targetWidth, height: targetHeight },
			});

			// Crop the region asynchronously; drop the result if a newer hover
			// (or a document close) superseded it.
			const token = ++renderTokenRef.current;
			const engine = engineRef.current;
			if (cachedImage || !engine || !document || !crops) return;
			void renderPdfRegionPromptImage({
				engine,
				document,
				pageIndex: region.pageIndex,
				region: region.bbox,
				scaleFactor: cropScale,
				maxEdgePx: PREVIEW_CROP_MAX_EDGE_PX,
			})
				.then((image) => {
					crops.set(cropKey, image);
					if (renderTokenRef.current !== token) return;
					setCrossrefPreview((prev) =>
						prev && prev.image === null ? { ...prev, image } : prev,
					);
				})
				.catch(() => {});
		},
		[
			docId,
			hostRef,
			zoomRef,
			engineRef,
			docCapRef,
			cancelCrossrefHide,
			crossrefHoverSurfaceRef,
			cachesFor,
		],
	);

	/**
	 * Crop the bibliography entry (or `[8–12]` range of entries) a citation
	 * link jumps to. `requireEntry` (text-recognized citations) shows nothing
	 * unless the destination really has entry `entryIndex` / an entry of the
	 * range.
	 */
	const showDestinationCrop = useCallback(
		(
			link: PdfLinkAnnoObject,
			destination: { pageIndex: number; pdfX: number | null; pdfY: number },
			regions: readonly PdfLayoutRegion[],
			target: {
				entryIndex: number | null;
				endEntryIndex?: number | null;
				requireEntry: boolean;
			},
			clientPoint?: ScreenPoint | null,
		) => {
			const document = docCapRef.current?.getDocument(docId) ?? null;
			const targetPage = document?.pages[destination.pageIndex];
			if (!document || !targetPage) {
				clearCrossrefPreview();
				return;
			}
			const show = (textRects?: readonly PageTextRect[]) => {
				const region = pickDestinationRegion({
					pageIndex: destination.pageIndex,
					pdfX: destination.pdfX,
					pdfY: destination.pdfY,
					pageWidthPt: targetPage.size.width,
					pageHeightPt: targetPage.size.height,
					regions,
					textRects,
					entryIndex: target.entryIndex,
					endEntryIndex: target.endEntryIndex,
				});
				if (target.requireEntry && !region.entryMatched) {
					clearCrossrefPreview();
					return;
				}
				showPreview(link, region, "reference", clientPoint);
			};
			const engine = engineRef.current;
			if (!engine) {
				show();
				return;
			}
			cancelCrossrefHide();
			const token = ++renderTokenRef.current;
			void pageTextRects(engine, document, targetPage)
				.then((textRects) => {
					if (renderTokenRef.current === token) show(textRects);
				})
				.catch(() => {
					if (renderTokenRef.current === token) show();
				});
		},
		[
			docId,
			docCapRef,
			engineRef,
			cancelCrossrefHide,
			clearCrossrefPreview,
			showPreview,
			pageTextRects,
		],
	);

	const handleCrossrefLinkHover = useCallback(
		(link: PdfLinkAnnoObject | null, clientPoint?: ScreenPoint | null) => {
			if (!link) {
				// Keep activeLinkRef so re-entering the same link does not
				// immediately dismiss a card the pointer is moving toward.
				linkHoveringRef.current = false;
				scheduleCrossrefHide();
				return;
			}
			linkHoveringRef.current = true;
			if (activeLinkRef.current !== link) {
				activeLinkRef.current = link;
				clearCrossrefPreview();
			}
			// If structured citation lookup resolved this link, usePdfCitations
			// will render its rich metadata card — do not override with a crop preview.
			if (hasCitationMatchRef.current?.(link)) {
				clearCrossrefPreview();
				return;
			}
			const rawDestination = getLinkDestination(link.target);
			if (!rawDestination) {
				clearCrossrefPreview();
				return;
			}

			// Map keys use raw user-space coordinates; geometry uses page space.
			// A link naming a section / theorem / footnote may land on the same
			// coordinate as a float or bibliography anchor; only its own text
			// can then make it a preview.
			const coord = isOtherNamedLink(
				otherNamedLinksRef.current,
				link.pageIndex,
				link.rect,
			)
				? null
				: citationDestKey(rawDestination.pageIndex, rawDestination.pdfY);
			const destination = destinationInPageBox(
				rawDestination,
				pageOriginsRef.current,
			);
			const regions = getLayoutDocumentResult(docId)?.regions ?? [];
			const document = docCapRef.current?.getDocument(docId) ?? null;
			const pageHeightPt =
				document?.pages[destination.pageIndex]?.size.height ?? null;

			// Fast path: unambiguous destination (standard hyperref /XYZ).
			const unambiguousKind =
				coord != null ? crossrefMapRef.current?.get(coord) : undefined;
			if (unambiguousKind) {
				const region = pickCrossrefRegion(
					regions,
					destination.pageIndex,
					destination.pdfY,
					pageHeightPt,
					unambiguousKind,
				);
				if (region) {
					showPreview(link, region, unambiguousKind, clientPoint);
					return;
				}
			}

			// ACS `/FitR` (and similar): destination coords collide across every
			// float on the page. Recover the label from the *link annotation's*
			// dest name (`mk:tbl1` / `mk:fig3`) via its device-space rect — this
			// does not depend on fragile link-text extraction.
			const linkLabel = matchCrossrefLinkLabel(
				crossrefLinksRef.current,
				link.pageIndex,
				link.rect,
			);
			if (linkLabel) {
				const region = pickCrossrefRegionByLabel(
					regions,
					destination.pageIndex,
					linkLabel,
				);
				if (region) {
					showPreview(link, region, linkLabel.kind, clientPoint);
					return;
				}
			}

			// Fallback: ambiguous or page-only destination without a link-name
			// hit. Infer the kind/number from the link text and match layout
			// regions by caption title.
			const kinds =
				coord != null ? crossrefKindsRef.current?.get(coord) : undefined;
			if (kinds && kinds.length > 0) {
				// If the destination name itself embeds an unambiguous label (e.g.
				// ACS `mk:fig1` / `mk:tbl1`) and it is the only label at this
				// coordinate, skip text extraction entirely.
				const labels =
					coord != null ? crossrefLabelsRef.current?.get(coord) : undefined;
				if (labels && labels.length === 1) {
					const label = labels[0];
					if (label) {
						const region = pickCrossrefRegionByLabel(
							regions,
							destination.pageIndex,
							label,
						);
						if (region) {
							showPreview(link, region, label.kind, clientPoint);
							return;
						}
					}
				}
			}

			// The link's own dest name is exact; the coordinate map can collide
			// across destinations sharing one anchor, so it only backs it up.
			const citeKey =
				matchCitationLinkKey(
					citationLinksRef.current,
					link.pageIndex,
					link.rect,
				) ??
				(coord != null ? citesMapRef.current?.get(coord) : null) ??
				null;
			const citeEntry: {
				entryIndex: number | null;
				endEntryIndex?: number | null;
				requireEntry: boolean;
			} = {
				entryIndex: citeKey ? citationRefNumber(citeKey) : null,
				requireEntry: false,
			};

			const engine = engineRef.current;
			const page = document?.pages[link.pageIndex];
			if (engine && document && page) {
				cancelCrossrefHide();
				const token = ++renderTokenRef.current;
				void pageTextRects(engine, document, page)
					.then((rects) => {
						if (renderTokenRef.current !== token) return;
						const label = extractCrossrefLabel(linkLabelText(rects, link.rect));
						if (label && (!kinds || kinds.includes(label.kind))) {
							const region = pickCrossrefRegionByLabel(
								regions,
								destination.pageIndex,
								label,
							);
							if (region) {
								showPreview(link, region, label.kind, clientPoint);
								return;
							}
						}
						const bracket = parseBracketCitation(rects, link.rect);
						if (citeKey != null) {
							// A `[8–12]` around the link widens the crop to the range
							// (when it agrees with the dest name's own number).
							const range = bracket?.range;
							const named = citeEntry.entryIndex;
							const useRange =
								range &&
								(named == null || (named >= range.start && named <= range.end));
							showDestinationCrop(
								link,
								destination,
								regions,
								useRange
									? {
											entryIndex: range.start,
											endEntryIndex: range.end,
											requireEntry: false,
										}
									: citeEntry,
								clientPoint,
							);
							return;
						}
						// No citation dest name: only a `[…]` number group counts,
						// and the destination must open that entry.
						if (bracket) {
							showDestinationCrop(
								link,
								destination,
								regions,
								{
									entryIndex: bracket.range?.start ?? bracket.entry,
									endEntryIndex: bracket.range?.end ?? null,
									requireEntry: true,
								},
								clientPoint,
							);
							return;
						}
						clearCrossrefPreview();
					})
					.catch(() => {
						if (renderTokenRef.current !== token) return;
						if (citeKey != null) {
							showDestinationCrop(
								link,
								destination,
								regions,
								citeEntry,
								clientPoint,
							);
						} else {
							clearCrossrefPreview();
						}
					});
				return;
			}

			// If engine or text extraction is unavailable:
			if (kinds && kinds.length === 1) {
				const region = pickCrossrefRegion(
					regions,
					destination.pageIndex,
					destination.pdfY,
					pageHeightPt,
					kinds[0],
				);
				if (region) {
					showPreview(link, region, kinds[0], clientPoint);
					return;
				}
			}

			if (citeKey != null) {
				showDestinationCrop(link, destination, regions, citeEntry, clientPoint);
				return;
			}

			clearCrossrefPreview();
		},
		[
			docId,
			engineRef,
			docCapRef,
			cancelCrossrefHide,
			clearCrossrefPreview,
			scheduleCrossrefHide,
			showPreview,
			showDestinationCrop,
			pageTextRects,
		],
	);

	// Clean up the hide timer when the document changes or unmounts.
	// biome-ignore lint/correctness/useExhaustiveDependencies: docId is the effect trigger, not a value read inside the cleanup.
	useEffect(
		() => () => {
			cancelCrossrefHide();
		},
		[docId, cancelCrossrefHide],
	);

	return {
		crossrefPreview,
		cancelCrossrefHide,
		scheduleCrossrefHide,
		markCrossrefHoverEnter,
		clearCrossrefPreview,
		handleCrossrefLinkHover,
	};
}
