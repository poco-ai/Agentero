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
import { normalizeArxivId } from "@/lib/paper/arxiv";

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
	label,
	onActivate,
	onTextActivate,
	onHover,
}: {
	links: PdfLinkAnnoObject[];
	textLinks: readonly PdfTextLink[];
	/** Page size in PDF points (CSS px ÷ zoom). */
	pageWidthPt: number;
	pageHeightPt: number;
	/** Accessible name for link hit targets. */
	label: string;
	onActivate: (link: PdfLinkAnnoObject) => void;
	onTextActivate: (url: string) => void;
	onHover: (link: PdfLinkAnnoObject | null) => void;
}) {
	if (
		(!links.length && !textLinks.length) ||
		pageWidthPt <= 0 ||
		pageHeightPt <= 0
	) {
		return null;
	}
	return (
		<>
			{links.map((link) => (
				<button
					key={`${link.id}-${link.rect.origin.x}-${link.rect.origin.y}-${link.rect.size.width}-${link.rect.size.height}`}
					type="button"
					tabIndex={-1}
					aria-label={label}
					className="absolute z-[2] cursor-pointer rounded-[2px] border-0 bg-transparent p-0 hover:bg-primary/10"
					style={{
						left: `${(link.rect.origin.x / pageWidthPt) * 100}%`,
						top: `${(link.rect.origin.y / pageHeightPt) * 100}%`,
						width: `${(link.rect.size.width / pageWidthPt) * 100}%`,
						height: `${(link.rect.size.height / pageHeightPt) * 100}%`,
					}}
					onClick={(e) => {
						e.stopPropagation();
						onActivate(link);
					}}
					onMouseEnter={() => onHover(link)}
					onMouseLeave={() => onHover(null)}
				/>
			))}
			{textLinks.map((link) => (
				<button
					key={`text-${link.url}-${link.rect.origin.x}-${link.rect.origin.y}`}
					type="button"
					tabIndex={-1}
					aria-label={link.url}
					title={link.url}
					className="absolute z-[2] cursor-pointer rounded-[2px] border-0 bg-transparent p-0 hover:bg-primary/10"
					style={{
						left: `${(link.rect.origin.x / pageWidthPt) * 100}%`,
						top: `${(link.rect.origin.y / pageHeightPt) * 100}%`,
						width: `${(link.rect.size.width / pageWidthPt) * 100}%`,
						height: `${(link.rect.size.height / pageHeightPt) * 100}%`,
					}}
					onClick={(e) => {
						e.stopPropagation();
						onTextActivate(link.url);
					}}
				/>
			))}
		</>
	);
});

/** Extract the destination page + vertical position from a link target, if any. */
export function getLinkDestination(
	target: PdfLinkTarget | undefined,
): { pageIndex: number; pdfY: number } | null {
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
			pdfY: destination.zoom.params.y,
		};
	}
	// For non-XYZ destinations the viewer still exposes the raw /View array.
	// /FitR: [left bottom right top]; /FitH: [top]. Use the vertical anchor so
	// the coordinate key matches the value parsed by pdf-lib in citation-dest-keys.
	const view = destination.view;
	if (destination.zoom.mode === PdfZoomMode.FitRectangle && view.length >= 4) {
		return { pageIndex: destination.pageIndex, pdfY: view[3] };
	}
	if (destination.zoom.mode === PdfZoomMode.FitHorizontal && view.length >= 1) {
		return { pageIndex: destination.pageIndex, pdfY: view[0] };
	}
	return { pageIndex: destination.pageIndex, pdfY: 0 };
}
