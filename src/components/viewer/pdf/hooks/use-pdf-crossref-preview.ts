/**
 * Cross-reference (`\ref`) hover preview for the EmbedPDF viewer: hovering a
 * "Fig. 3" / "Table 1" / "Eq. (2)" link shows its destination page in a
 * scrollable card, initially positioned at the referenced point.
 *
 * Resolution order (see `lib/pdf/citation-dest-keys`):
 * 1. Unambiguous dest coordinate → kind (standard hyperref `/XYZ`).
 * 2. Link annotation rect → dest label (`mk:tbl1` / `mk:fig3`) — needed when
 *    ACS `/FitR` destinations share a whole page across every float.
 * 3. Single label at the dest coordinate, or link-text extraction + caption
 *    match as a last resort.
 * Layout analysis supplies the focus region for page-only destinations.
 * Coordinate destinations also work before layout detection is available.
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

import {
	PdfActionType,
	type PdfDocumentObject,
	type PdfEngine,
	type PdfLinkAnnoObject,
	type PdfPageObject,
	PdfZoomMode,
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
	PdfLinkHoverPoint,
	ScreenPoint,
} from "@/components/viewer/pdf/types";
import type { PromptImage } from "@/lib/agent/api";
import { LruCache } from "@/lib/core/lru-cache";
import { clamp01 } from "@/lib/core/math";
import {
	type CitationDestination,
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
import {
	pickDestinationContinuation,
	pickDestinationRegions,
} from "@/lib/pdf/destination-crop";
import { getLayoutDocumentResult } from "@/lib/pdf/layout";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";
import {
	authorYearCitationGroup,
	authorYearLinkText,
	linkLabelText,
	type PageTextRect,
	pageTextRectsFromGlyphs,
	parseBracketCitation,
	parseSuperscriptCitation,
} from "@/lib/pdf/link-text";

/**
 * Preview crops render at zoom × devicePixelRatio so they match the page 1:1,
 * never below 2× (crisp when zoomed out) nor above 4×, and never longer than
 * this many pixels on either edge.
 */
const PREVIEW_CROP_MIN_SCALE = 2;
const PREVIEW_CROP_MAX_SCALE = 4;
const PREVIEW_CROP_MAX_EDGE_PX = 1600;
/** Whole pages need more raster detail than a small bibliography crop. */
const PREVIEW_PAGE_MAX_EDGE_PX = 3200;

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
	/** Continuous reading has a text scale independent of the source PDF zoom. */
	previewZoomRef?: RefObject<number | null>;
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
	showCitationPreview?: (
		link: PdfLinkAnnoObject,
		point?: ScreenPoint | null,
		keys?: string[],
	) => boolean;
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
		clientPoint?: PdfLinkHoverPoint | null,
	) => void;
};

export function usePdfCrossrefPreview({
	docId,
	hostRef,
	zoomRef,
	previewZoomRef,
	paperAbsPath,
	sourceBytes = null,
	engineRef,
	docCapRef,
	onPreviewShow,
	showCitationPreview,
}: UsePdfCrossrefPreviewOptions): PdfCrossrefPreview {
	const onPreviewShowRef = useRef(onPreviewShow);
	onPreviewShowRef.current = onPreviewShow;
	const showCitationPreviewRef = useRef(showCitationPreview);
	showCitationPreviewRef.current = showCitationPreview;
	const [crossrefPreview, setCrossrefPreview] =
		useState<CrossrefPreviewState | null>(null);
	const referenceTargetRef = useRef<string | null>(null);
	const hideCrossrefPreview = useCallback(() => {
		referenceTargetRef.current = null;
		setCrossrefPreview(null);
	}, []);
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
	const citationTargetsRef = useRef<ReadonlyMap<string, CitationDestination>>(
		new Map(),
	);
	/** Links whose own dest name is neither a cite nor a float (by rect). */
	const otherNamedLinksRef = useRef<readonly LinkRectLike[] | null>(null);
	/** Monotonic token so a stale crop never lands over a newer hover. */
	const renderTokenRef = useRef(0);
	const hoverTokenRef = useRef(0);
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

	/** Character boxes, shared by PDF and reader hovers of the same page. */
	const pageTextRects = useCallback(
		(
			engine: PdfEngine,
			document: PdfDocumentObject,
			page: PdfPageObject,
		): Promise<PageTextRects> => {
			const cache = cachesFor(document).textRects;
			const cached = cache.get(page.index);
			if (cached) return cached;
			const pending = (async (): Promise<PageTextRects> => {
				try {
					// A text rect can contain a whole line in a proportional font.
					// Spreading it evenly puts citation numbers under the wrong link.
					const glyphs = await engine.getPageGlyphs(document, page).toPromise();
					const text = await engine
						.getTextSlices(
							document,
							glyphs.map((_, charIndex) => ({
								pageIndex: page.index,
								charIndex,
								charCount: 1,
								rawCharacters: true,
							})),
						)
						.toPromise();
					const rects = pageTextRectsFromGlyphs(glyphs, text);
					if (rects.length) return rects;
				} catch {
					// Older engines can still supply the coarser text rectangles.
				}
				return engine.getPageTextRects(document, page).toPromise();
			})();
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
		citationTargetsRef.current = new Map();
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
				citationTargetsRef.current = maps.citationTargets ?? new Map();
				otherNamedLinksRef.current = maps.otherNamedLinks;
			},
		});
	}, [paperAbsPath]);

	// Reset the preview when the active PDF document changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: docId is the effect trigger, not a value read inside the effect.
	useEffect(() => {
		activeLinkRef.current = null;
		referenceTargetRef.current = null;
		linkHoveringRef.current = false;
		cachedDocRef.current = null;
		textRectsCacheRef.current.clear();
		cropCacheRef.current.clear();
		crossrefHoverSurfaceRef.current = false;
		setCrossrefPreview(null);
	}, [docId]);

	const clearCrossrefPreview = useCallback(() => {
		referenceTargetRef.current = null;
		hoverTokenRef.current += 1;
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
			referenceRegions?: {
				pageIndex: number;
				bbox: { x: number; y: number; w: number; h: number };
			}[],
			referenceStatus?: {
				referenceEntries: number[];
				missingReferences: number[];
			},
		) => {
			// A crop that resolves after the pointer has left both the link and
			// the card must not cancel the hide timer and stick the preview.
			if (!linkHoveringRef.current && !crossrefHoverSurfaceRef.current) return;
			cancelCrossrefHide();
			// Treat show as an active hover surface so mount-under-cursor skips
			// pointerenter do not auto-close.
			crossrefHoverSurfaceRef.current = true;
			const pageEl = pageElByIndex(hostRef.current, link.pageIndex);
			if (!clientPoint && !pageEl) return;
			onPreviewShowRef.current?.();

			const document = docCapRef.current?.getDocument(docId) ?? null;
			const targetPage = document?.pages[region.pageIndex];
			const pageWidthPt = targetPage?.size.width ?? 612;
			const pageHeightPt = targetPage?.size.height ?? 792;
			const zoom = zoomRef.current && zoomRef.current > 0 ? zoomRef.current : 1;
			const displayZoom = previewZoomRef?.current ?? zoom;
			// Render floats in their page context: side captions and adjacent panels
			// must remain accessible instead of depending on detector crop bounds.
			const focusedCrop = kind === "reference" || kind === "equation";
			const renderRegion = focusedCrop
				? region.bbox
				: { x: 0, y: 0, w: 1, h: 1 };
			const renderRegions = referenceRegions?.length
				? referenceRegions
				: [{ pageIndex: region.pageIndex, bbox: renderRegion }];
			const targetWidth = Math.round(
				Math.max(
					...renderRegions.map(
						(r) =>
							r.bbox.w *
							(document?.pages[r.pageIndex]?.size.width ?? pageWidthPt),
					),
				) * displayZoom,
			);
			const targetHeight = Math.round(
				renderRegions.reduce(
					(sum, r) =>
						sum +
						r.bbox.h *
							(document?.pages[r.pageIndex]?.size.height ?? pageHeightPt),
					0,
				) * displayZoom,
			);
			const target = link.target;
			const nativeDestination =
				target?.type === "destination"
					? target.destination
					: target?.type === "action" &&
							target.action.type === PdfActionType.Goto
						? target.action.destination
						: null;
			const destination = getLinkDestination(target);
			const pointDestination =
				nativeDestination &&
				destination &&
				(nativeDestination.zoom.mode === PdfZoomMode.XYZ ||
					nativeDestination.zoom.mode === PdfZoomMode.FitHorizontal)
					? destinationInPageBox(destination, pageOriginsRef.current)
					: null;
			const focusPoint = focusedCrop
				? undefined
				: pointDestination
					? {
							x: clamp01(
								pointDestination.pdfX == null
									? 0.5
									: pointDestination.pdfX / pageWidthPt,
							),
							y: clamp01(1 - pointDestination.pdfY / pageHeightPt),
						}
					: {
							x: region.bbox.x + region.bbox.w / 2,
							y: region.bbox.y + region.bbox.h / 2,
						};
			const screen =
				clientPoint ??
				(pageEl ? rectBottomCenterScreen(pageEl, link.rect, zoom) : null);
			if (!screen) return;
			const dpr =
				typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
			const cropScale = Math.min(
				PREVIEW_CROP_MAX_SCALE,
				Math.max(PREVIEW_CROP_MIN_SCALE, displayZoom * dpr),
			);
			const { x, y, w, h } = renderRegion;
			const cropKey = [region.pageIndex, x, y, w, h, cropScale]
				.map((n) => Math.round(n * 1e4))
				.join(":");
			const crops = document ? cachesFor(document).crops : null;
			const cachedImage =
				renderRegions.length === 1 ? (crops?.get(cropKey) ?? null) : null;

			setCrossrefPreview({
				screen,
				kind,
				page: region.pageIndex + 1,
				region: region.bbox,
				image: cachedImage,
				targetSize: { width: targetWidth, height: targetHeight },
				focusPoint,
				...referenceStatus,
			});

			// Crop the region asynchronously; drop the result if a newer hover
			// (or a document close) superseded it.
			const token = ++renderTokenRef.current;
			const engine = engineRef.current;
			if (cachedImage || !engine || !document || !crops) return;
			void Promise.all(
				renderRegions.map(async ({ pageIndex, bbox: box }) => {
					const key = [pageIndex, box.x, box.y, box.w, box.h, cropScale]
						.map((n) => Math.round(n * 1e4))
						.join(":");
					const image =
						crops.get(key) ??
						(await renderPdfRegionPromptImage({
							engine,
							document,
							pageIndex,
							region: box,
							scaleFactor: cropScale,
							maxEdgePx:
								kind === "reference"
									? PREVIEW_CROP_MAX_EDGE_PX
									: PREVIEW_PAGE_MAX_EDGE_PX,
						}));
					crops.set(key, image);
					return {
						id: key,
						image,
						width:
							box.w *
							(document.pages[pageIndex]?.size.width ?? pageWidthPt) *
							displayZoom,
						height:
							box.h *
							(document.pages[pageIndex]?.size.height ?? pageHeightPt) *
							displayZoom,
					};
				}),
			)
				.then((images) => {
					if (renderTokenRef.current !== token) return;
					setCrossrefPreview((prev) =>
						prev && prev.image === null
							? {
									...prev,
									image: images[0].image,
									referenceImages: images.length > 1 ? images : undefined,
								}
							: prev,
					);
				})
				.catch(() => {});
		},
		[
			docId,
			hostRef,
			zoomRef,
			previewZoomRef,
			engineRef,
			docCapRef,
			cancelCrossrefHide,
			crossrefHoverSurfaceRef,
			cachesFor,
		],
	);

	/**
	 * Crop every explicitly cited number, including ranges and cross-page
	 * groups. Numeric crops require a matching bibliography label; author-year
	 * citations use their native destination and full visible identity.
	 */
	const showDestinationCrop = useCallback(
		(
			link: PdfLinkAnnoObject,
			destination: CitationDestination,
			regions: readonly PdfLayoutRegion[],
			target: {
				entryIndex: number | null;
				endEntryIndex?: number | null;
				entries?: number[];
				citationText?: string;
				authorEntries?: { key: string; citationText: string }[];
			},
			clientPoint?: ScreenPoint | null,
		) => {
			const numbers =
				target.entries ??
				(target.entryIndex != null
					? Array.from(
							{
								length: Math.max(
									1,
									Math.min(
										31,
										(target.endEntryIndex ?? target.entryIndex) -
											target.entryIndex +
											1,
									),
								),
							},
							(_, i) => (target.entryIndex ?? 0) + i,
						)
					: []);
			const key = `${link.id}:${destination.pageIndex}:${numbers.join(",")}:${target.citationText}:${target.authorEntries?.map((entry) => entry.key).join(",")}:${clientPoint?.x}:${clientPoint?.y}`;
			if (referenceTargetRef.current === key) {
				cancelCrossrefHide();
				return;
			}
			referenceTargetRef.current = key;
			const document = docCapRef.current?.getDocument(docId) ?? null;
			const targetPage = document?.pages[destination.pageIndex];
			if (!document || !targetPage) {
				clearCrossrefPreview();
				return;
			}
			cancelCrossrefHide();
			const token = ++renderTokenRef.current;
			const engine = engineRef.current;
			void (async () => {
				const read = async (pageIndex: number) => {
					const page = document.pages[pageIndex];
					return engine && page
						? pageTextRects(engine, document, page).catch(() => [])
						: [];
				};
				const pick = async (
					dest: CitationDestination,
					entryIndex: number | null,
					pageOnly = false,
					citationText = target.citationText,
				) => {
					const page = document.pages[dest.pageIndex];
					if (!page) return [];
					const textRects = await read(dest.pageIndex);
					const options = {
						pageIndex: dest.pageIndex,
						pdfX: dest.pdfX,
						pdfY: dest.pdfY,
						pageWidthPt: page.size.width,
						pageHeightPt: page.size.height,
						regions,
						textRects,
						pageOnly,
						entryIndex,
						citationText,
					};
					const crops = pickDestinationRegions(options);
					const last = crops.at(-1);
					if (!last?.entryMatched) return crops;
					let continuation = pickDestinationContinuation(
						last,
						options,
						options,
					);
					const next = document.pages[dest.pageIndex + 1];
					if (!continuation && next && last.bbox.y + last.bbox.h > 0.7) {
						continuation = pickDestinationContinuation(last, options, {
							...options,
							pageIndex: dest.pageIndex + 1,
							pageWidthPt: next.size.width,
							pageHeightPt: next.size.height,
							textRects: await read(dest.pageIndex + 1),
						});
					}
					return continuation ? [...crops, continuation] : crops;
				};
				if (!numbers.length) {
					const entries: ReturnType<typeof pickDestinationRegions> = [];
					if (target.authorEntries?.length) {
						for (const entry of target.authorEntries) {
							if (renderTokenRef.current !== token) return;
							const named = citationTargetsRef.current.get(entry.key);
							const dest = named
								? destinationInPageBox(named, pageOriginsRef.current)
								: destination;
							const crops = await pick(dest, null, false, entry.citationText);
							// Do not display a silently incomplete author/year group.
							if (!crops.length) {
								clearCrossrefPreview();
								return;
							}
							entries.push(...crops);
						}
					} else entries.push(...(await pick(destination, null)));
					if (renderTokenRef.current !== token) return;
					if (!entries[0]) {
						clearCrossrefPreview();
						return;
					}
					showPreview(link, entries[0], "reference", clientPoint, entries);
					return;
				}
				// Named targets retain every bibliography page even when coordinates
				// collide. Probe these before adjacent pages, with a bounded page budget.
				const targets = [...citationTargetsRef.current.entries()];
				const pages = [
					...new Set([
						destination.pageIndex,
						...targets.map(([, d]) => d.pageIndex),
					]),
				].sort(
					(a, b) =>
						Math.abs(a - destination.pageIndex) -
						Math.abs(b - destination.pageIndex),
				);
				for (const offset of [1, -1, 2, -2]) {
					const page = destination.pageIndex + offset;
					if (document.pages[page] && !pages.includes(page)) pages.push(page);
				}
				const entries: ReturnType<typeof pickDestinationRegions> = [];
				const found: number[] = [],
					missing: number[] = [];
				for (const n of numbers) {
					if (renderTokenRef.current !== token) return;
					const exact = targets.find(
						([key]) => citationRefNumber(key) === n,
					)?.[1];
					const candidatePages = [
						...new Set([...(exact ? [exact.pageIndex] : []), ...pages]),
					].slice(0, 8);
					let match: ReturnType<typeof pickDestinationRegions> = [];
					for (const pageIndex of candidatePages) {
						const dest =
							exact?.pageIndex === pageIndex
								? destinationInPageBox(exact, pageOriginsRef.current)
								: { ...destination, pageIndex };
						const result = await pick(
							dest,
							n,
							pageIndex !== destination.pageIndex || numbers.length > 1,
						);
						match = result.filter((r) => r.entryMatched);
						if (match.length) break;
						if (renderTokenRef.current !== token) return;
					}
					if (match.length) {
						entries.push(...match);
						found.push(n);
					} else missing.push(n);
				}
				if (renderTokenRef.current !== token) return;
				if (!entries[0]) {
					clearCrossrefPreview();
					return;
				}
				showPreview(link, entries[0], "reference", clientPoint, entries, {
					referenceEntries: found,
					missingReferences: missing,
				});
			})().catch(() => {
				if (renderTokenRef.current === token) clearCrossrefPreview();
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
		(
			link: PdfLinkAnnoObject | null,
			clientPoint?: PdfLinkHoverPoint | null,
		) => {
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
			const linkLabel = matchCrossrefLinkLabel(
				crossrefLinksRef.current,
				link.pageIndex,
				link.rect,
			);
			const unambiguousKind =
				coord != null ? crossrefMapRef.current?.get(coord) : undefined;
			if (unambiguousKind && !linkLabel) {
				const region = pickCrossrefRegion(
					regions,
					destination.pageIndex,
					destination.pdfY,
					pageHeightPt,
					unambiguousKind,
				);
				if (region || document?.pages[destination.pageIndex]) {
					showPreview(
						link,
						region ?? {
							pageIndex: destination.pageIndex,
							bbox: { x: 0, y: 0, w: 1, h: 1 },
						},
						unambiguousKind,
						clientPoint,
					);
					return;
				}
			}

			// ACS `/FitR` (and similar): destination coords collide across every
			// float on the page. Recover the label from the *link annotation's*
			// dest name (`mk:tbl1` / `mk:fig3`) via its device-space rect — this
			// does not depend on fragile link-text extraction.
			if (linkLabel) {
				const region =
					linkLabel.kind === "equation"
						? pickCrossrefRegion(
								regions,
								destination.pageIndex,
								destination.pdfY,
								pageHeightPt,
								"equation",
							)
						: pickCrossrefRegionByLabel(
								regions,
								destination.pageIndex,
								linkLabel,
							);
				if (region || document?.pages[destination.pageIndex]) {
					showPreview(
						link,
						region ?? {
							pageIndex: destination.pageIndex,
							bbox: { x: 0, y: 0, w: 1, h: 1 },
						},
						linkLabel.kind,
						clientPoint,
					);
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
			} = {
				entryIndex: citeKey ? citationRefNumber(citeKey) : null,
			};

			const engine = engineRef.current;
			const page = document?.pages[link.pageIndex];
			if (engine && document && page) {
				cancelCrossrefHide();
				const token = ++hoverTokenRef.current;
				void pageTextRects(engine, document, page)
					.then(async (rects) => {
						if (hoverTokenRef.current !== token) return;
						const bracket =
							clientPoint?.citation ??
							parseBracketCitation(
								rects,
								link.rect,
								clientPoint?.sourcePoint,
							) ??
							parseSuperscriptCitation(
								rects,
								link.rect,
								clientPoint?.sourcePoint,
							);
						if (bracket) {
							const numbers = bracket.entries ?? [bracket.entry];
							const keys = numbers.map((n) => {
								const native = [...citationTargetsRef.current.keys()].find(
									(key) => citationRefNumber(key) === n,
								);
								if (native) return native;
								for (const part of citationLinksRef.current ?? []) {
									if (
										part.pageIndex !== link.pageIndex ||
										Math.abs(part.y - link.rect.origin.y) >
											link.rect.size.height * 3
									)
										continue;
									const rect = {
										origin: { x: part.x, y: part.y },
										size: { width: part.w, height: part.h },
									};
									const member =
										parseBracketCitation(rects, rect) ??
										parseSuperscriptCitation(rects, rect);
									if (member?.entry === n) return part.key;
								}
								return numbers.length === 1 ? citeKey : null;
							});
							if (
								keys.every((key): key is string => key != null) &&
								showCitationPreviewRef.current?.(link, clientPoint, keys)
							)
								return;
							showDestinationCrop(
								link,
								destination,
								regions,
								{
									entryIndex: bracket.range?.start ?? bracket.entry,
									endEntryIndex: bracket.range?.end ?? null,
									entries: bracket.entries,
								},
								clientPoint,
							);
							return;
						}
						const sourceLabel = linkLabelText(rects, link.rect);
						const label = extractCrossrefLabel(sourceLabel);
						if (label && (!kinds || kinds.includes(label.kind))) {
							const region =
								label.kind === "equation"
									? pickCrossrefRegion(
											regions,
											destination.pageIndex,
											destination.pdfY,
											pageHeightPt,
											"equation",
										)
									: pickCrossrefRegionByLabel(
											regions,
											destination.pageIndex,
											label,
										);
							if (region || document.pages[destination.pageIndex]) {
								showPreview(
									link,
									region ?? {
										pageIndex: destination.pageIndex,
										bbox: { x: 0, y: 0, w: 1, h: 1 },
									},
									label.kind,
									clientPoint,
								);
								return;
							}
						}
						// Reference columns in tables often use plain baseline numbers
						// with arbitrary publisher destination names. Require the matching
						// numbered bibliography entry before treating one as a citation.
						if (/^\s*\d{1,3}\s*$/.test(sourceLabel)) {
							showDestinationCrop(
								link,
								destination,
								regions,
								{
									entryIndex: Number(sourceLabel),
								},
								clientPoint,
							);
							return;
						}
						if (citeKey != null) {
							const authorEntries = authorYearCitationGroup(
								rects,
								link.rect,
								(citationLinksRef.current ?? [])
									.filter((part) => part.pageIndex === link.pageIndex)
									.map((part) => ({
										key: part.key,
										rect: {
											origin: { x: part.x, y: part.y },
											size: { width: part.w, height: part.h },
										},
									})),
							);
							// A single resolved member is still stronger than joining every
							// nearby annotation with the same destination. The same paper
							// may be cited again on the following line, with its own year.
							if (authorEntries.length > 0) {
								showDestinationCrop(
									link,
									destination,
									regions,
									{ entryIndex: null, authorEntries },
									clientPoint,
								);
								return;
							}
							if (
								showCitationPreviewRef.current?.(link, clientPoint, [citeKey])
							)
								return;
							// Hyperref can split one author-year citation into author,
							// continuation and year annotations. Join only nearby pieces
							// with the same native key; do not interpret BibTeX key text.
							const parts = (citationLinksRef.current ?? []).filter(
								(part) =>
									part.pageIndex === link.pageIndex && part.key === citeKey,
							);
							const group = [
								{
									x: link.rect.origin.x,
									y: link.rect.origin.y,
									w: link.rect.size.width,
									h: link.rect.size.height,
								},
							];
							for (let i = 0; i < group.length; i++) {
								const current = group[i];
								for (const part of parts) {
									if (
										group.some(
											(p) =>
												Math.abs(p.x - part.x) < 1 &&
												Math.abs(p.y - part.y) < 1,
										)
									)
										continue;
									const height = Math.max(current.h, part.h);
									const dy = Math.abs(current.y - part.y);
									const gap =
										Math.max(current.x, part.x) -
										Math.min(current.x + current.w, part.x + part.w);
									if (
										(dy <= height * 0.6 && gap <= height * 2) ||
										(dy > height * 0.6 && dy <= height * 2)
									)
										group.push(part);
								}
							}
							const joinedCitation = group
								.sort((a, b) =>
									Math.abs(a.y - b.y) < Math.max(a.h, b.h) * 0.6
										? a.x - b.x
										: a.y - b.y,
								)
								.map((part) =>
									linkLabelText(
										rects,
										{
											origin: { x: part.x, y: part.y },
											size: { width: part.w, height: part.h },
										},
										false,
									),
								)
								.join(" ");
							const yearOnly =
								/^\s*\(?\s*(?:18|19|20)\d{2}[a-z]?\s*\)?\s*$/i.test(
									joinedCitation,
								);
							let citationText = yearOnly
								? authorYearLinkText(rects, link.rect)
								: joinedCitation;
							if (
								!citationText &&
								yearOnly &&
								link.pageIndex > 0 &&
								link.rect.origin.y < link.rect.size.height * 10
							) {
								const previous = document.pages[link.pageIndex - 1];
								if (previous)
									citationText = authorYearLinkText(
										rects,
										link.rect,
										await pageTextRects(engine, document, previous),
									);
								if (hoverTokenRef.current !== token) return;
							}
							showDestinationCrop(
								link,
								destination,
								regions,
								{ ...citeEntry, citationText: citationText ?? joinedCitation },
								clientPoint,
							);
							return;
						}
						clearCrossrefPreview();
					})
					.catch(() => {
						if (hoverTokenRef.current !== token) return;
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
