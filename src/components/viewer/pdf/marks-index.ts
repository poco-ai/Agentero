/**
 * Gutter-pin and comment-rail index over the viewer's mark arrays.
 *
 * Pure derivation (no React) so the caller controls memoization: built once per
 * mark/text change — pin placement walks the page's whole text-rect list, so
 * doing it inside renderPage cost that walk for every mounted page on every
 * scroll frame.
 */

import type {
	AskPinAnchor,
	TranslatePinAnchor,
} from "@/components/viewer/pdf/hooks/use-pdf-pin-anchors";
import type { PageAnnotationComment } from "@/components/viewer/pdf/types";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import { tracePreview } from "@/lib/pdf/agent-trace";
import {
	annotationSnippet,
	annotationWikilinkAlias,
} from "@/lib/pdf/annotation-ref";
import {
	DEFAULT_HIGHLIGHT_COLOR,
	normalizeHighlightColor,
} from "@/lib/pdf/highlight/palette";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";
import {
	type NormalizedRect,
	pinFromRects,
	pinObscuresBodyText,
	type SelectionPin,
} from "@/lib/pdf/selection";

export type MarksIndexInput = {
	highlights: PdfHighlight[];
	/** Annotation id → normalized rect, for gutter-pin placement. */
	highlightAnchors: ReadonlyMap<string, NormalizedRect>;
	askPinAnchors: AskPinAnchor[];
	translatePinAnchors: TranslatePinAnchor[];
	visualTraces: PdfVisualSessionTrace[];
	/** 0-based page index → normalized text rects (missing while unloaded). */
	pageTextMap: ReadonlyMap<number, NormalizedRect[]>;
	/** Catalog title for comment-rail wikilink aliases. */
	paperTitle: string | undefined;
};

export type MarksIndex = {
	/** Gutter pins per page (1-based). */
	pinsByPage: Map<number, SelectionPin[]>;
	/** Right-rail comment entries per page (1-based). */
	commentsByPage: Map<number, PageAnnotationComment[]>;
};

export function buildMarksIndex({
	highlights,
	highlightAnchors,
	askPinAnchors,
	translatePinAnchors,
	visualTraces,
	pageTextMap,
	paperTitle,
}: MarksIndexInput): MarksIndex {
	const pins = new Map<number, SelectionPin[]>();
	const comments = new Map<number, PageAnnotationComment[]>();
	const add = (page: number, pin: SelectionPin) => {
		const list = pins.get(page);
		if (list) list.push(pin);
		else pins.set(page, [pin]);
	};
	for (const highlight of highlights) {
		const comment = highlight.comment?.trim();
		if (!comment) continue;
		const anchor = highlightAnchors.get(highlight.id);
		if (!anchor) continue;
		// Highlight notes always live in the right-edge comment rail.
		const entry: PageAnnotationComment = {
			id: highlight.id,
			pageIndex: highlight.page - 1,
			anchorY: anchor.y,
			rects: highlight.rects,
			quote: highlight.quote,
			comment,
			color: normalizeHighlightColor(highlight.color),
			kind: "highlight",
			linkAlias:
				annotationWikilinkAlias(
					paperTitle,
					annotationSnippet({ comment, quote: highlight.quote }),
				) ?? null,
		};
		const list = comments.get(highlight.page);
		if (list) list.push(entry);
		else comments.set(highlight.page, [entry]);
	}
	for (const anchor of askPinAnchors) {
		const pageText = pageTextMap.get(anchor.page - 1);
		const pin = pinFromRects(anchor.rects, pageText);
		add(anchor.page, {
			id: anchor.id,
			kind: "ask",
			x: pin.x,
			y: pin.y,
			preview: anchor.preview,
			ended: anchor.ended,
			overText: pinObscuresBodyText(pin, pageText),
			side: pin.side,
		});
	}
	for (const anchor of translatePinAnchors) {
		if (anchor.hasError) continue;
		const pageText = pageTextMap.get(anchor.page - 1);
		const pin = pinFromRects(anchor.rects, pageText);
		add(anchor.page, {
			id: anchor.id,
			kind: "translate",
			x: pin.x,
			y: pin.y,
			preview: anchor.preview,
			overText: pinObscuresBodyText(pin, pageText),
			side: pin.side,
		});
	}
	for (const trace of visualTraces) {
		const hasAgent = Boolean(trace.agent);
		const note = trace.comment.trim();
		// Note-only visual marks (and visual marks that already have a
		// comment) live in the comment rail.
		if (!hasAgent || note) {
			const entry: PageAnnotationComment = {
				id: trace.id,
				pageIndex: trace.page - 1,
				anchorY: trace.rects[0]?.y ?? 0,
				rects: trace.rects,
				quote: "",
				comment: trace.comment,
				color: DEFAULT_HIGHLIGHT_COLOR,
				kind: "visual",
				linkAlias:
					annotationWikilinkAlias(
						paperTitle,
						annotationSnippet({ comment: trace.comment }),
					) ?? null,
			};
			const list = comments.get(trace.page);
			if (list) list.push(entry);
			else comments.set(trace.page, [entry]);
			if (!hasAgent) continue;
		}
		const pageText = pageTextMap.get(trace.page - 1);
		const pin = pinFromRects(trace.rects, pageText);
		add(trace.page, {
			id: trace.id,
			kind: "visual",
			x: pin.x,
			y: pin.y,
			preview: tracePreview(trace),
			ended: trace.agent?.status !== "running",
			traceId: trace.id,
			overText: pinObscuresBodyText(pin, pageText),
			side: pin.side,
		});
	}
	return { pinsByPage: pins, commentsByPage: comments };
}
