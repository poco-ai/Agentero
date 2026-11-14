/**
 * Gutter-pin and comment-rail index over the viewer's mark arrays.
 *
 * Pure derivation (no React) so the caller controls memoization: built once per
 * mark/text change — pin placement walks the page's whole text-rect list, so
 * doing it inside renderPage cost that walk for every mounted page on every
 * scroll frame.
 */

import type { AskPinAnchor } from "@/components/viewer/pdf/hooks/use-pdf-pin-anchors";
import type { PageAnnotationComment } from "@/components/viewer/pdf/types";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import { tracePreview } from "@/lib/pdf/agent-trace";
import { traceMessages } from "@/lib/pdf/agent-trace/schema";
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
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";

export type MarksIndexInput = {
	highlights: PdfHighlight[];
	/** Annotation id → normalized rect, for gutter-pin placement. */
	highlightAnchors: ReadonlyMap<string, NormalizedRect>;
	askPinAnchors: AskPinAnchor[];
	translates: PdfTranslateRecord[];
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
	translates,
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
			shape: highlight.kind,
			...(highlight.translatedRects?.length
				? { translatedRects: highlight.translatedRects }
				: {}),
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
			rects: anchor.rects,
			...(anchor.translatedRects?.length
				? { translatedRects: anchor.translatedRects }
				: {}),
		});
	}
	for (const translate of translates) {
		if (!translate.pinned || translate.rects.length === 0) continue;
		const pageText = pageTextMap.get(translate.page - 1);
		const pin = pinFromRects(translate.rects, pageText);
		const preview = (translate.quote || translate.result || "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 96);
		add(translate.page, {
			id: translate.id,
			kind: "translate",
			x: pin.x,
			y: pin.y,
			preview,
			overText: pinObscuresBodyText(pin, pageText),
			side: pin.side,
		});
	}
	for (const trace of visualTraces) {
		const hasAgent = Boolean(trace.agent);
		const hasComment = trace.comment.trim().length > 0;
		// Empty crops are in-progress drafts. The open editor injects its own
		// card; blur / outside click / Escape drops them. Agent-only marks use
		// the conversation pin instead of an empty comment card.
		if (hasComment) {
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
				...(hasAgent
					? {
							messages: traceMessages(trace).map((m) => ({
								id: m.id,
								role: m.role,
								content: m.content,
							})),
						}
					: {}),
			};
			const list = comments.get(trace.page);
			if (list) list.push(entry);
			else comments.set(trace.page, [entry]);
		}
		// Marks with an active Agent conversation keep a gutter pin. When there is
		// no comment the pin becomes the conversation entry point.
		if (hasAgent) {
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
	}
	return { pinsByPage: pins, commentsByPage: comments };
}

/**
 * While a translation is showing, a note that recorded the translated
 * selection anchors to those boxes. English glyph boxes stay in place for the
 * original page.
 */
export function commentForVisibleTranslation(
	comment: PageAnnotationComment,
	translationVisible: boolean,
): PageAnnotationComment {
	const rects = comment.translatedRects;
	if (!translationVisible || !rects?.length) return comment;
	let anchorY = rects[0]?.y ?? comment.anchorY;
	for (const rect of rects) anchorY = Math.min(anchorY, rect.y);
	return { ...comment, rects, anchorY };
}

/**
 * Boxes for a quick-chat highlight. Translation mode uses the boxes the reader
 * selected on the overlay; otherwise the English glyph boxes.
 */
export function askHighlightRects(
	anchor: {
		rects?: readonly NormalizedRect[] | null;
		translatedRects?: readonly NormalizedRect[] | null;
	},
	translationVisible: boolean,
): readonly NormalizedRect[] {
	if (translationVisible && anchor.translatedRects?.length) {
		return anchor.translatedRects;
	}
	return anchor.rects ?? [];
}

/**
 * Move an ask gutter pin next to the translated selection while that
 * translation is showing. English pin geometry is unchanged.
 */
export function selectionPinForVisibleTranslation(
	pin: SelectionPin,
	translationVisible: boolean,
): SelectionPin {
	const rects = pin.translatedRects;
	if (pin.kind !== "ask" || !translationVisible || !rects?.length) return pin;
	let y = rects[0]?.y ?? pin.y;
	for (const rect of rects) y = Math.min(y, rect.y);
	return y === pin.y ? pin : { ...pin, y };
}
