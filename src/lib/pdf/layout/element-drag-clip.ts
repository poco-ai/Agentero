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

import type { PdfLayoutKind } from "@/lib/pdf/layout/types";

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
	const hits = targets.filter((target) => pointInBox(point, target.box));
	hits.sort((a, b) => {
		const inset = insetOf(point, b.box) - insetOf(point, a.box);
		if (Math.abs(inset) > 1e-6) return inset;
		return a.order - b.order;
	});
	const anchor = hits[0];
	if (!anchor) return null;
	return { itemId: anchor.itemId, sentenceIndex: anchor.sentenceIndex };
}

/**
 * The stroke covers `target`.
 * A flat stroke (a drag along one line) covers only its anchor line. The next
 * line can share that edge and still stay out. A taller stroke has to enter
 * the block by more than a graze on both axes; a narrow vertical stroke has
 * to enter it vertically.
 */
export function elementDragCoversTarget(
	drag: ElementDragBox,
	target: ElementDragBox,
	anchor: boolean,
): boolean {
	const hit = overlapAmount(drag, target);
	if (!hit) return false;
	const dragW = drag.right - drag.left;
	const dragH = drag.bottom - drag.top;
	const flat = dragH <= ELEMENT_DRAG_GRAZE_PX;
	const narrow = dragW <= ELEMENT_DRAG_GRAZE_PX;
	if (flat) {
		if (!anchor) return false;
		const centerY = (drag.top + drag.bottom) / 2;
		const onAnchorLine = centerY >= target.top && centerY <= target.bottom;
		return onAnchorLine && hit.w > ELEMENT_DRAG_GRAZE_PX;
	}
	if (narrow) return hit.h > ELEMENT_DRAG_GRAZE_PX && hit.w > 0;
	return hit.w > ELEMENT_DRAG_GRAZE_PX && hit.h > ELEMENT_DRAG_GRAZE_PX;
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
	const anchorKey = anchor ? elementDragHitKey(anchor) : null;
	const covered = new Set<string>();
	for (const target of targets) {
		const key = elementDragHitKey(target);
		if (elementDragCoversTarget(drag, target.box, key === anchorKey)) {
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

function unionClientRects(
	rects: Iterable<{
		left: number;
		top: number;
		right: number;
		bottom: number;
		width: number;
		height: number;
	}>,
): ElementDragBox | null {
	let box: ElementDragBox | null = null;
	for (const rect of rects) {
		if (rect.width <= 0 || rect.height <= 0) continue;
		const next = {
			left: rect.left,
			top: rect.top,
			right: rect.right,
			bottom: rect.bottom,
		};
		if (!box) {
			box = next;
			continue;
		}
		box = {
			left: Math.min(box.left, next.left),
			top: Math.min(box.top, next.top),
			right: Math.max(box.right, next.right),
			bottom: Math.max(box.bottom, next.bottom),
		};
	}
	return box;
}

/** Sentence boxes in reading order, measured from the painted translation. */
export function elementDragTargetsFromDom(
	root: ParentNode,
	blocks: readonly ElementDragBlockSource[],
): ElementDragTarget[] {
	const sorted = [...blocks].sort(
		(a, b) => a.pageIndex - b.pageIndex || a.readingOrder - b.readingOrder,
	);
	const targets: ElementDragTarget[] = [];
	let order = 0;
	for (const block of sorted) {
		const node = root.querySelector<HTMLElement>(
			`[data-layout-item="${CSS.escape(block.id)}"]`,
		);
		if (!node) continue;
		const spans = node.querySelectorAll<HTMLElement>("[data-sentence]");
		if (spans.length === 0) {
			const box = unionClientRects([node.getBoundingClientRect()]);
			if (!box) continue;
			targets.push({
				itemId: block.id,
				sentenceIndex: null,
				kind: block.kind,
				order: order++,
				box,
			});
			continue;
		}
		for (const span of spans) {
			const sentenceIndex = Number(span.getAttribute("data-sentence"));
			if (!Number.isInteger(sentenceIndex)) continue;
			const box = unionClientRects(span.getClientRects());
			if (!box) continue;
			targets.push({
				itemId: block.id,
				sentenceIndex,
				kind: block.kind,
				order: order++,
				box,
			});
		}
	}
	return targets;
}

function spanHitKey(span: Element): string | null {
	const itemId = span
		.closest("[data-layout-item]")
		?.getAttribute("data-layout-item");
	const raw = span.getAttribute("data-sentence");
	if (!itemId || raw == null || raw === "") return null;
	const sentenceIndex = Number(raw);
	if (!Number.isInteger(sentenceIndex)) return null;
	return elementDragHitKey({ itemId, sentenceIndex });
}

/**
 * Drop leading and trailing sentence spans the clip rejected.
 * One DOM range cannot punch a hole through a header left between two
 * covered sections; the hit list already excludes that header.
 * Returns true when `range` changed. All-rejected collapses the range.
 */
export function trimRangeToKeptHits(
	range: Range,
	root: ParentNode,
	kept: ReadonlySet<string>,
): boolean {
	const spans = Array.from(root.querySelectorAll("[data-sentence]")).filter(
		(span) => range.intersectsNode(span),
	);
	if (spans.length === 0) return false;
	let start = 0;
	while (start < spans.length) {
		const key = spanHitKey(spans[start]);
		if (key == null || kept.has(key)) break;
		start += 1;
	}
	let end = spans.length;
	while (end > start) {
		const key = spanHitKey(spans[end - 1]);
		if (key == null || kept.has(key)) break;
		end -= 1;
	}
	try {
		if (start >= end) {
			range.collapse(true);
			return true;
		}
		let changed = false;
		if (start > 0) {
			range.setStartBefore(spans[start]);
			changed = true;
		}
		if (end < spans.length) {
			range.setEndBefore(spans[end]);
			changed = true;
		}
		return changed;
	} catch {
		return false;
	}
}
