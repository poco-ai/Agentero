/**
 * Per-page overlay for PDF Link annotations (in-text citations, figure/section
 * refs, external URLs). PDFium already parses each link's rect + target; this
 * layer makes them clickable. The reference behind a citation is resolved from
 * the hyperref cite-key map by destination coordinates (see
 * `lib/pdf/citation-dest-keys`).
 */

import type {
	PdfAnnotationObject,
	PdfDestinationObject,
	PdfLinkAnnoObject,
	PdfLinkTarget,
	PdfTextRectObject,
	Rect,
} from "@embedpdf/models";
import {
	PdfActionType,
	PdfAnnotationSubtype,
	PdfZoomMode,
} from "@embedpdf/models";
import { memo } from "react";
import type {
	PdfLinkHoverPoint,
	ScreenPoint,
} from "@/components/viewer/pdf/types";
import { normalizeArxivId } from "@/lib/paper/arxiv";
import {
	linkHoverSuppressed,
	linkPreviewDragActive,
} from "@/lib/pdf/link-preview-drag";
import { linkTargetUrl } from "@/lib/pdf/link-target";

export { linkTargetUrl };

export function isLinkObject(
	object: PdfAnnotationObject,
): object is PdfLinkAnnoObject {
	return object.type === PdfAnnotationSubtype.LINK;
}

export type PdfTextLink = {
	url: string;
	rect: Rect;
};

function matchedTextRect(
	rect: Rect,
	contentLength: number,
	start: number,
	length: number,
): Rect {
	const unitWidth = rect.size.width / contentLength;
	return {
		origin: {
			x: rect.origin.x + start * unitWidth,
			y: rect.origin.y,
		},
		size: {
			width: length * unitWidth,
			height: rect.size.height,
		},
	};
}

/** Detect external URLs that PDF authors left as unannotated page text. */
export function detectPdfTextLinks(
	textRects: readonly PdfTextRectObject[],
): PdfTextLink[] {
	return textRects.flatMap(({ content, rect }) => {
		const links: { index: number; link: PdfTextLink }[] = [];
		for (const match of content.matchAll(/https?:\/\/\S+/gi)) {
			const url = match[0].replace(/[.,;:!?]+$/, "");
			links.push({
				index: match.index,
				link: {
					url,
					rect: matchedTextRect(rect, content.length, match.index, url.length),
				},
			});
		}
		for (const match of content.matchAll(/\barxiv\s*:\s*(\S+)/gi)) {
			const matchedText = match[0].replace(/[.,;:!?]+$/, "");
			const id = normalizeArxivId(match[1]?.replace(/[.,;:!?]+$/, "") ?? "");
			if (!id) continue;
			links.push({
				index: match.index,
				link: {
					url: `https://arxiv.org/abs/${id}`,
					rect: matchedTextRect(
						rect,
						content.length,
						match.index,
						matchedText.length,
					),
				},
			});
		}
		return links.sort((a, b) => a.index - b.index).map(({ link }) => link);
	});
}

function rectsIntersect(a: Rect, b: Rect): boolean {
	return (
		a.origin.x < b.origin.x + b.size.width &&
		a.origin.x + a.size.width > b.origin.x &&
		a.origin.y < b.origin.y + b.size.height &&
		a.origin.y + a.size.height > b.origin.y
	);
}

export function excludeOverlappingPdfTextLinks(
	textLinks: readonly PdfTextLink[],
	nativeLinks: readonly Pick<PdfLinkAnnoObject, "rect">[],
): PdfTextLink[] {
	return textLinks.filter(
		(textLink) =>
			!nativeLinks.some((nativeLink) =>
				rectsIntersect(textLink.rect, nativeLink.rect),
			),
	);
}

/**
 * Transparent hit targets over each link rect. Positioned in page-percentage
 * units so they track zoom for free.
 *
 * Memoized: every mounted page re-renders whenever the scroller layout changes.
 */
export const CitationLinkLayer = memo(function CitationLinkLayer({
	links,
	textLinks,
	pageWidthPt,
	pageHeightPt,
	viewport,
	label,
	onActivate,
	onTextActivate,
	onHover,
	onUrlHover,
}: {
	links: PdfLinkAnnoObject[];
	textLinks: readonly PdfTextLink[];
	/** Page size in PDF points (CSS px ÷ zoom). */
	pageWidthPt: number;
	pageHeightPt: number;
	/** A reader image crop in page coordinates; events retain the native link. */
	viewport?: Rect;
	/** Accessible name for link hit targets. */
	label: string;
	onActivate: (link: PdfLinkAnnoObject) => void;
	onTextActivate: (url: string) => void;
	onHover: (
		link: PdfLinkAnnoObject | null,
		clientPoint?: PdfLinkHoverPoint | null,
	) => void;
	/** Full external URL (annotation URI / Launch, or detected page text). */
	onUrlHover?: (url: string | null, clientPoint?: ScreenPoint | null) => void;
}) {
	if (
		(!links.length && !textLinks.length) ||
		pageWidthPt <= 0 ||
		pageHeightPt <= 0
	) {
		return null;
	}
	const visibleRect = (rect: Rect): Rect | null => {
		if (!viewport) return rect;
		const x = Math.max(rect.origin.x, viewport.origin.x);
		const y = Math.max(rect.origin.y, viewport.origin.y);
		const right = Math.min(
			rect.origin.x + rect.size.width,
			viewport.origin.x + viewport.size.width,
		);
		const bottom = Math.min(
			rect.origin.y + rect.size.height,
			viewport.origin.y + viewport.size.height,
		);
		return right > x && bottom > y
			? { origin: { x, y }, size: { width: right - x, height: bottom - y } }
			: null;
	};
	const position = (rect: Rect) => ({
		left: `${((rect.origin.x - (viewport?.origin.x ?? 0)) / (viewport?.size.width ?? pageWidthPt)) * 100}%`,
		top: `${((rect.origin.y - (viewport?.origin.y ?? 0)) / (viewport?.size.height ?? pageHeightPt)) * 100}%`,
		width: `${(rect.size.width / (viewport?.size.width ?? pageWidthPt)) * 100}%`,
		height: `${(rect.size.height / (viewport?.size.height ?? pageHeightPt)) * 100}%`,
	});
	return (
		<>
			{links.map((link) => {
				const rect = visibleRect(link.rect);
				if (!rect) return null;
				return (
					<button
						key={`${link.id}-${link.rect.origin.x}-${link.rect.origin.y}-${link.rect.size.width}-${link.rect.size.height}`}
						type="button"
						tabIndex={-1}
						aria-label={label}
						data-pdf-link={link.id}
						className="absolute z-[2] cursor-pointer rounded-[2px] border-0 bg-transparent p-0 hover:bg-primary/10"
						style={position(rect)}
						onClick={(e) => {
							e.stopPropagation();
							onActivate(link);
						}}
						// Match floating preview cards (pointerenter/leave) so hide
						// timers do not race mouse-only leave on trackpads.
						// Skip while a primary button is held, and while a translation
						// DOM drag is in progress (`pointerenter.buttons` stays 0 then).
						onPointerEnter={(e) => {
							if (linkHoverSuppressed(e.buttons)) return;
							const box = e.currentTarget.getBoundingClientRect();
							const point = {
								x: box.left + box.width / 2,
								y: box.bottom,
								top: box.top,
								bottom: box.bottom,
								sourcePoint: {
									x:
										rect.origin.x +
										((e.clientX - box.left) / Math.max(box.width, 1)) *
											rect.size.width,
									y:
										rect.origin.y +
										((e.clientY - box.top) / Math.max(box.height, 1)) *
											rect.size.height,
								},
							};
							onHover(link, point);
							const url = linkTargetUrl(link.target);
							onUrlHover?.(url, url ? point : null);
						}}
						onPointerMove={(e) => {
							if (linkHoverSuppressed(e.buttons) || linkTargetUrl(link.target))
								return;
							const box = e.currentTarget.getBoundingClientRect();
							onHover(link, {
								x: box.left + box.width / 2,
								y: box.bottom,
								top: box.top,
								bottom: box.bottom,
								sourcePoint: {
									x:
										rect.origin.x +
										((e.clientX - box.left) / Math.max(box.width, 1)) *
											rect.size.width,
									y:
										rect.origin.y +
										((e.clientY - box.top) / Math.max(box.height, 1)) *
											rect.size.height,
								},
							});
						}}
						onPointerLeave={() => {
							if (linkPreviewDragActive()) return;
							onHover(null);
							onUrlHover?.(null);
						}}
					/>
				);
			})}
			{textLinks.map((link) => {
				const rect = visibleRect(link.rect);
				if (!rect) return null;
				return (
					<button
						key={`text-${link.url}-${link.rect.origin.x}-${link.rect.origin.y}`}
						type="button"
						tabIndex={-1}
						aria-label={link.url}
						data-url={link.url}
						className="absolute z-[2] cursor-pointer rounded-[2px] border-0 bg-transparent p-0 hover:bg-primary/10"
						style={position(rect)}
						onClick={(e) => {
							e.stopPropagation();
							onTextActivate(link.url);
						}}
						onPointerEnter={(e) => {
							if (linkHoverSuppressed(e.buttons)) return;
							const box = e.currentTarget.getBoundingClientRect();
							onUrlHover?.(link.url, {
								x: box.left + box.width / 2,
								y: box.bottom,
								top: box.top,
								bottom: box.bottom,
							});
						}}
						onPointerLeave={() => {
							if (linkPreviewDragActive()) return;
							onUrlHover?.(null);
						}}
					/>
				);
			})}
		</>
	);
});

/**
 * Extract the destination page + anchor position from a link target, if any.
 * Coordinates are PDF-native (origin bottom-left). `pdfX` is null when the
 * destination only pins a row (FitH) or the viewer does not expose x.
 */
/** URI action target, when this link opens an external URL. */
export function linkAnnotationUri(link: PdfLinkAnnoObject): string | null {
	const target = link.target;
	if (
		target?.type === "action" &&
		target.action.type === PdfActionType.URI &&
		target.action.uri
	) {
		return target.action.uri;
	}
	return null;
}

export function getLinkDestination(
	target: PdfLinkTarget | undefined,
): { pageIndex: number; pdfX: number | null; pdfY: number } | null {
	if (!target) return null;
	let destination: PdfDestinationObject | null = null;
	if (target.type === "destination") {
		destination = target.destination;
	} else if (
		target.type === "action" &&
		target.action.type === PdfActionType.Goto
	) {
		destination = target.action.destination;
	}
	if (!destination) return null;
	if (destination.zoom.mode === PdfZoomMode.XYZ) {
		// PDF-native coordinate: origin bottom-left, y grows upward.
		return {
			pageIndex: destination.pageIndex,
			pdfX: destination.zoom.params.x ?? null,
			pdfY: destination.zoom.params.y,
		};
	}
	// For non-XYZ destinations the viewer still exposes the raw /View array.
	// /FitR: [left bottom right top]; /FitH: [top]. Use the vertical anchor so
	// the coordinate key matches the value parsed by pdf-lib in citation-dest-keys.
	const view = destination.view;
	if (destination.zoom.mode === PdfZoomMode.FitRectangle && view.length >= 4) {
		return { pageIndex: destination.pageIndex, pdfX: view[0], pdfY: view[3] };
	}
	if (destination.zoom.mode === PdfZoomMode.FitHorizontal && view.length >= 1) {
		return { pageIndex: destination.pageIndex, pdfX: null, pdfY: view[0] };
	}
	return { pageIndex: destination.pageIndex, pdfX: null, pdfY: 0 };
}
