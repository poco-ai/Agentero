/**
 * Recognition clip for a ⌘. drag on the translation.
 *
 * The drag still builds a DOM range. Chinese sentence spans sit flush, so a
 * pointer that only crosses the next line makes that span part of the range,
 * and the sentence quote then takes the whole line. Element mode keeps a block
 * only when the stroke actually covers it. A graze along the edge does not.
 * An uncovered header is a section wall: the title and the body after it stay
 * out, unless the rectangle really covers that next section.
 *
 * Ordinary reading-mode selection does not call this.
 */

import { selectedRangeWithin } from "@/lib/pdf/layout/layout-sentence-selection";
import type { PdfLayoutKind } from "@/lib/pdf/layout/types";
import { mergeClientRectsIntoLines } from "@/lib/pdf/layout/visible-selection-rects";

/** Pointer contact thinner than this does not pull another block in. */
export const ELEMENT_DRAG_GRAZE_PX = 8;

/**
 * A section after an uncovered header is part of the drag only when the
 * rectangle covers at least this share of that section's box.
 */
const SECTION_COVER_RATIO = 0.5;

export type ElementDragBox = {
	left: number;
	top: number;
	right: number;
	bottom: number;
};

export type ElementDragHit = {
	itemId: string;
	sentenceIndex: number | null;
};

export type ElementDragTarget = ElementDragHit & {
	kind: PdfLayoutKind;
	order: number;
	box: ElementDragBox;
	lines?: readonly ElementDragBox[];
};

export type ElementDragPoint = { x: number; y: number };

export function elementDragHitKey(hit: ElementDragHit): string {
	return `${hit.itemId}\u0000${hit.sentenceIndex ?? ""}`;
}

export function elementDragBoxFromPoints(
	start: ElementDragPoint,
	end: ElementDragPoint,
): ElementDragBox {
	return {
		left: Math.min(start.x, end.x),
		top: Math.min(start.y, end.y),
		right: Math.max(start.x, end.x),
		bottom: Math.max(start.y, end.y),
	};
}

function boxArea(box: ElementDragBox): number {
	return Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
}

function overlapAmount(
	drag: ElementDragBox,
	box: ElementDragBox,
): { w: number; h: number } | null {
	const w = Math.min(drag.right, box.right) - Math.max(drag.left, box.left);
	const h = Math.min(drag.bottom, box.bottom) - Math.max(drag.top, box.top);
	if (w <= 0 || h <= 0) return null;
	return { w, h };
}

function pointInBox(point: ElementDragPoint, box: ElementDragBox): boolean {
	return (
		point.x >= box.left &&
		point.x <= box.right &&
		point.y >= box.top &&
		point.y <= box.bottom
	);
}

/** How far `point` sits inside `box`. Zero when it is on the edge. */
function insetOf(point: ElementDragPoint, box: ElementDragBox): number {
	return Math.min(
		point.x - box.left,
		box.right - point.x,
		point.y - box.top,
		box.bottom - point.y,
	);
}

/**
 * Block under the pointer-down point.
 * Boxes that share an edge both contain the point; the one the point sits
 * further inside wins, and a tie keeps the earlier block. A boundary graze
 * therefore stays with the paragraph the stroke started in.
 */
export function elementDragAnchorAt(
	targets: readonly ElementDragTarget[],
	point: ElementDragPoint,
): ElementDragHit | null {
	const hits = targets.flatMap((target) =>
		(target.lines ?? [target.box])
			.filter((line) => pointInBox(point, line))
			.map((line) => ({ target, inset: insetOf(point, line) })),
	);
	hits.sort((a, b) => b.inset - a.inset || a.target.order - b.target.order);
	const anchor = hits[0]?.target;
	if (!anchor) return null;
	return { itemId: anchor.itemId, sentenceIndex: anchor.sentenceIndex };
}

/**
 * A flat stroke follows the anchor paragraph's text line. Wider strokes
 * need meaningful overlap with a rendered line on both axes, and vertical
 * strokes are tested along their center.
 */
export function elementDragCoversTarget(
	drag: ElementDragBox,
	target: ElementDragBox,
	anchor: boolean,
): boolean {
	const w =
		Math.min(drag.right, target.right) - Math.max(drag.left, target.left);
	const h =
		Math.min(drag.bottom, target.bottom) - Math.max(drag.top, target.top);
	const minWidth = Math.min(
		ELEMENT_DRAG_GRAZE_PX,
		(target.right - target.left) / 2,
	);
	const minHeight = Math.min(
		ELEMENT_DRAG_GRAZE_PX,
		(target.bottom - target.top) / 2,
	);
	if (drag.bottom - drag.top <= ELEMENT_DRAG_GRAZE_PX) {
		const y = (drag.top + drag.bottom) / 2;
		return anchor && y >= target.top && y <= target.bottom && w > minWidth;
	}
	if (drag.right - drag.left <= ELEMENT_DRAG_GRAZE_PX) {
		const x = (drag.left + drag.right) / 2;
		return x >= target.left && x <= target.right && h > minHeight;
	}
	return w > minWidth && h > minHeight;
}

function sectionShare(drag: ElementDragBox, target: ElementDragBox): number {
	const hit = overlapAmount(drag, target);
	const area = boxArea(target);
	if (!hit || area <= 0) return 0;
	return (hit.w * hit.h) / area;
}

/**
 * Hits the drag rectangle actually covers, in the original hit order.
 * Targets we could not measure are left in place. An uncovered header drops
 * itself and every later block, unless a later block is really covered.
 */
export function clipElementDragHits<T extends ElementDragHit>(
	hits: readonly T[],
	targets: readonly ElementDragTarget[],
	drag: ElementDragBox,
	anchor: ElementDragHit | null,
): T[] {
	if (hits.length === 0 || targets.length === 0) return [...hits];
	const byKey = new Map(
		targets.map((target) => [elementDragHitKey(target), target]),
	);
	const covered = new Set<string>();
	for (const target of targets) {
		const key = elementDragHitKey(target);
		if (
			(target.lines ?? [target.box]).some((line) =>
				elementDragCoversTarget(
					drag,
					line,
					anchor == null || target.itemId === anchor.itemId,
				),
			)
		) {
			covered.add(key);
		}
	}
	const coveredTargets = targets.filter((target) =>
		covered.has(elementDragHitKey(target)),
	);
	const firstOrder = coveredTargets.reduce(
		(min, target) => Math.min(min, target.order),
		Number.POSITIVE_INFINITY,
	);
	const wall = targets.find(
		(target) =>
			target.kind === "header" &&
			target.order > firstOrder &&
			!covered.has(elementDragHitKey(target)),
	);
	if (wall) {
		const laterReallyCovered = targets.some(
			(target) =>
				target.order > wall.order &&
				covered.has(elementDragHitKey(target)) &&
				sectionShare(drag, target.box) >= SECTION_COVER_RATIO,
		);
		if (!laterReallyCovered) {
			for (const target of targets) {
				if (target.order >= wall.order) {
					covered.delete(elementDragHitKey(target));
				}
			}
		}
	}
	return hits.filter((hit) => {
		const key = elementDragHitKey(hit);
		if (!byKey.has(key)) return true;
		return covered.has(key);
	});
}

export type ElementDragBlockSource = {
	id: string;
	kind: PdfLayoutKind;
	pageIndex: number;
	readingOrder: number;
};

/** Measure the rendered text. Reflow sentence spans wrap absolute glyphs. */
export function elementDragTargetsFromDom(
	root: HTMLElement,
	blocks: readonly ElementDragBlockSource[],
	selection: Range,
): ElementDragTarget[] {
	const byId = new Map(blocks.map((block) => [block.id, block]));
	const mounted = Array.from(
		root.querySelectorAll<HTMLElement>("[data-layout-item]"),
	)
		.flatMap((node) => {
			if (!selection.intersectsNode(node)) return [];
			const block = byId.get(node.dataset.layoutItem ?? "");
			return block ? [{ node, block }] : [];
		})
		.sort(
			(a, b) =>
				a.block.pageIndex - b.block.pageIndex ||
				a.block.readingOrder - b.block.readingOrder,
		);
	const targets: ElementDragTarget[] = [];
	const range = document.createRange();
	for (const { node, block } of mounted) {
		for (const { element, hit } of dragNodes(node)) {
			range.selectNodeContents(element);
			const lines = mergeClientRectsIntoLines(
				Array.from(range.getClientRects()),
			).map(({ left, top, width, height }) => ({
				left,
				top,
				right: left + width,
				bottom: top + height,
			}));
			const first = lines[0];
			if (!first) continue;
			const box = lines.reduce(
				(box, line) => ({
					left: Math.min(box.left, line.left),
					top: Math.min(box.top, line.top),
					right: Math.max(box.right, line.right),
					bottom: Math.max(box.bottom, line.bottom),
				}),
				first,
			);
			targets.push({
				...hit,
				kind: block.kind,
				order: targets.length,
				box,
				lines,
			});
		}
	}
	return targets;
}

function dragNodes(
	block: HTMLElement,
): { element: HTMLElement; hit: ElementDragHit }[] {
	const itemId = block.dataset.layoutItem;
	if (!itemId) return [];
	const spans = block.querySelectorAll<HTMLElement>("[data-sentence]");
	return spans.length
		? Array.from(spans, (element) => ({
				element,
				hit: { itemId, sentenceIndex: Number(element.dataset.sentence) },
			}))
		: [{ element: block, hit: { itemId, sentenceIndex: null } }];
}

/** Retain selected characters in covered sentences and group adjacent hits within each block. */
export function elementDragSelectionRanges(
	range: Range,
	root: ParentNode,
	kept: ReadonlySet<string>,
): Range[] {
	const ranges: Range[] = [];
	for (const block of root.querySelectorAll<HTMLElement>(
		"[data-layout-item]",
	)) {
		if (!range.intersectsNode(block)) continue;
		let part: Range | null = null;
		for (const { element, hit } of dragNodes(block)) {
			if (!kept.has(elementDragHitKey(hit))) {
				part = null;
				continue;
			}
			const selected = selectedRangeWithin(range, element);
			if (!selected) continue;
			if (part) {
				part.setEnd(selected.endContainer, selected.endOffset);
			} else {
				part = selected;
				ranges.push(part);
			}
		}
	}
	return ranges;
}

/** A native selection holds one range, so trim its endpoints to the retained text. */
export function trimRangeToParts(
	range: Range,
	parts: readonly Range[],
): boolean {
	const first = parts[0];
	const last = parts.at(-1);
	if (!first || !last) {
		range.collapse(true);
		return true;
	}
	if (
		range.compareBoundaryPoints(Range.START_TO_START, first) === 0 &&
		range.compareBoundaryPoints(Range.END_TO_END, last) === 0
	)
		return false;
	range.setStart(first.startContainer, first.startOffset);
	range.setEnd(last.endContainer, last.endOffset);
	return true;
}
