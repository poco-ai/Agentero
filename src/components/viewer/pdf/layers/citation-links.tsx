/**
 * Per-page overlay for PDF Link annotations (in-text citations, figure/section
 * refs, external URLs). PDFium already parses each link's rect + target; this
 * layer makes them clickable and shows a destination-preview card on hover.
 */

import type {
	PdfAnnotationObject,
	PdfDestinationObject,
	PdfDocumentObject,
	PdfLinkAnnoObject,
	PdfLinkTarget,
	PdfTextRectObject,
} from "@embedpdf/models";
import {
	PdfActionType,
	PdfAnnotationSubtype,
	PdfZoomMode,
} from "@embedpdf/models";
import { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import { memo, useCallback, useRef } from "react";
import { usePdfEngineContext } from "@/components/viewer/pdf/engine-provider";

export function isLinkObject(
	object: PdfAnnotationObject,
): object is PdfLinkAnnoObject {
	return object.type === PdfAnnotationSubtype.LINK;
}

/**
 * Transparent hit targets over each link rect. Positioned in page-percentage
 * units so they track zoom for free.
 *
 * Memoized: every mounted page re-renders whenever the scroller layout changes.
 */
export const CitationLinkLayer = memo(function CitationLinkLayer({
	links,
	pageWidthPt,
	pageHeightPt,
	label,
	onActivate,
	onHover,
}: {
	links: PdfLinkAnnoObject[];
	/** Page size in PDF points (CSS px ÷ zoom). */
	pageWidthPt: number;
	pageHeightPt: number;
	/** Accessible name for link hit targets. */
	label: string;
	onActivate: (link: PdfLinkAnnoObject) => void;
	onHover: (link: PdfLinkAnnoObject | null) => void;
}) {
	if (!links.length || pageWidthPt <= 0 || pageHeightPt <= 0) return null;
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
		</>
	);
});

/** Extract the destination page + vertical position from a link target, if any. */
function getLinkDestination(
	target: PdfLinkTarget | undefined,
): { pageIndex: number; y: number } | null {
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
		return { pageIndex: destination.pageIndex, y: destination.zoom.params.y };
	}
	return { pageIndex: destination.pageIndex, y: 0 };
}

/**
 * Resolve a preview snippet for a Link annotation by reading the text at its
 * destination (usually the bibliography entry). Returns null when the engine is
 * unavailable or the target is not a GoTo/destination.
 */
export function useDestinationPreviewResolver(
	docId: string,
): (link: PdfLinkAnnoObject) => Promise<string | null> {
	const { engine } = usePdfEngineContext();
	const { provides: docCap } = useDocumentManagerCapability();
	const cacheRef = useRef(new Map<string, Promise<string | null>>());

	return useCallback(
		async (link) => {
			const destination = getLinkDestination(link.target);
			if (!destination) return null;
			const cacheKey = `${destination.pageIndex}:${destination.y.toFixed(1)}`;
			const cached = cacheRef.current.get(cacheKey);
			if (cached !== undefined) return cached;

			const promise = (async () => {
				const doc: PdfDocumentObject | undefined | null =
					docCap?.getDocument(docId);
				const page = doc?.pages[destination.pageIndex];
				if (!engine || !doc || !page) return null;
				try {
					const textRects: PdfTextRectObject[] = await engine
						.getPageTextRects(doc, page)
						.toPromise();
					return mergeBibliographyEntryAtY(textRects, destination.y);
				} catch {
					return null;
				}
			})();

			cacheRef.current.set(cacheKey, promise);
			return promise;
		},
		[engine, docCap, docId],
	);
}

/**
 * Merge text rects that belong to the same bibliography entry as the target y
 * coordinate. We start from the rect closest to targetY and expand up/down while
 * the horizontal overlap and vertical gap suggest the same paragraph/entry.
 */
function mergeBibliographyEntryAtY(
	textRects: PdfTextRectObject[],
	targetY: number,
): string | null {
	if (!textRects.length) return null;

	const sorted = [...textRects].sort(
		(a, b) => a.rect.origin.y - b.rect.origin.y,
	);

	let mainIndex = 0;
	let bestDistance = Infinity;
	for (let i = 0; i < sorted.length; i++) {
		const rect = sorted[i];
		const midY = rect.rect.origin.y + rect.rect.size.height / 2;
		const distance = Math.abs(midY - targetY);
		if (distance < bestDistance) {
			bestDistance = distance;
			mainIndex = i;
		}
	}

	const main = sorted[mainIndex];
	const lineHeight = main.rect.size.height;
	const selected: PdfTextRectObject[] = [main];

	const overlapsMain = (rect: PdfTextRectObject): boolean => {
		const left = Math.max(rect.rect.origin.x, main.rect.origin.x);
		const right = Math.min(
			rect.rect.origin.x + rect.rect.size.width,
			main.rect.origin.x + main.rect.size.width,
		);
		const overlap = Math.max(0, right - left);
		const minWidth = Math.min(rect.rect.size.width, main.rect.size.width);
		return minWidth > 0 && overlap / minWidth >= 0.25;
	};

	// Expand upward.
	for (let i = mainIndex - 1; i >= 0; i--) {
		const rect = sorted[i];
		const gap =
			main.rect.origin.y - (rect.rect.origin.y + rect.rect.size.height);
		if (gap > lineHeight * 1.5 || !overlapsMain(rect)) break;
		selected.unshift(rect);
	}

	// Expand downward.
	for (let i = mainIndex + 1; i < sorted.length; i++) {
		const rect = sorted[i];
		const gap =
			rect.rect.origin.y - (main.rect.origin.y + main.rect.size.height);
		if (gap > lineHeight * 1.5 || !overlapsMain(rect)) break;
		selected.push(rect);
	}

	selected.sort((a, b) => {
		const ay = a.rect.origin.y;
		const by = b.rect.origin.y;
		if (Math.abs(ay - by) > lineHeight * 0.5) return ay - by;
		return a.rect.origin.x - b.rect.origin.x;
	});

	return (
		selected
			.map((r) => r.content)
			.join(" ")
			.trim() || null
	);
}
