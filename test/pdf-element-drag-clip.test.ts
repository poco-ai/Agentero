// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
	clipElementDragHits,
	type ElementDragBox,
	type ElementDragTarget,
	elementDragAnchorAt,
	elementDragBoxFromPoints,
	elementDragHitKey,
	elementDragSelectionRanges,
	trimRangeToParts,
} from "@/lib/pdf/layout/element-drag-clip";

function box(
	left: number,
	top: number,
	right: number,
	bottom: number,
): ElementDragBox {
	return { left, top, right, bottom };
}

function target(
	order: number,
	itemId: string,
	sentenceIndex: number | null,
	kind: ElementDragTarget["kind"],
	rect: ElementDragBox,
): ElementDragTarget {
	return { order, itemId, sentenceIndex, kind, box: rect };
}

const bodyA = target(0, "a", 0, "text", box(10, 100, 210, 140));
const header = target(1, "h", 0, "header", box(10, 140, 210, 156));
const bodyB = target(2, "b", 0, "text", box(10, 156, 210, 196));

describe("clipElementDragHits", () => {
	it("does not expand a stroke that only nips the next sentence", () => {
		const first = target(0, "a", 0, "text", box(10, 100, 210, 120));
		const second = target(1, "a", 1, "text", box(10, 120, 210, 140));
		const drag = elementDragBoxFromPoints(
			{ x: 16, y: 109 },
			{ x: 190, y: 122 },
		);
		const hits = clipElementDragHits(
			[
				{ itemId: "a", sentenceIndex: 0 },
				{ itemId: "a", sentenceIndex: 1 },
			],
			[first, second],
			drag,
			elementDragAnchorAt([first, second], { x: 16, y: 109 }),
		);
		expect(hits).toEqual([{ itemId: "a", sentenceIndex: 0 }]);
	});

	it("keeps the next sentence when the stroke covers it", () => {
		const first = target(0, "a", 0, "text", box(10, 100, 210, 120));
		const second = target(1, "a", 1, "text", box(10, 120, 210, 140));
		const drag = elementDragBoxFromPoints(
			{ x: 16, y: 109 },
			{ x: 190, y: 135 },
		);
		const hits = clipElementDragHits(
			[
				{ itemId: "a", sentenceIndex: 0 },
				{ itemId: "a", sentenceIndex: 1 },
			],
			[first, second],
			drag,
			{ itemId: "a", sentenceIndex: 0 },
		);
		expect(hits.map((hit) => hit.sentenceIndex)).toEqual([0, 1]);
	});

	it("keeps the line under a flat stroke and drops the next sentence", () => {
		const drag = elementDragBoxFromPoints(
			{ x: 20, y: 118 },
			{ x: 180, y: 119 },
		);
		const anchor = elementDragAnchorAt([bodyA, bodyB], { x: 20, y: 118 });
		expect(anchor).toEqual({ itemId: "a", sentenceIndex: 0 });
		const hits = clipElementDragHits(
			[
				{ itemId: "a", sentenceIndex: 0 },
				{ itemId: "b", sentenceIndex: 0 },
			],
			[bodyA, bodyB],
			drag,
			anchor,
		);
		expect(hits).toEqual([{ itemId: "a", sentenceIndex: 0 }]);
	});

	it("does not pull in a sentence the stroke only grazes", () => {
		const drag = elementDragBoxFromPoints(
			{ x: 20, y: 110 },
			{ x: 180, y: 143 },
		);
		const hits = clipElementDragHits(
			[
				{ itemId: "a", sentenceIndex: 0 },
				{ itemId: "h", sentenceIndex: 0 },
				{ itemId: "b", sentenceIndex: 0 },
			],
			[bodyA, header, bodyB],
			drag,
			{ itemId: "a", sentenceIndex: 0 },
		);
		expect(hits.map((hit) => hit.itemId)).toEqual(["a"]);
	});

	it("keeps both sections when the rectangle covers them", () => {
		const drag = elementDragBoxFromPoints(
			{ x: 20, y: 110 },
			{ x: 180, y: 190 },
		);
		const hits = clipElementDragHits(
			[
				{ itemId: "a", sentenceIndex: 0 },
				{ itemId: "h", sentenceIndex: 0 },
				{ itemId: "b", sentenceIndex: 0 },
			],
			[bodyA, header, bodyB],
			drag,
			{ itemId: "a", sentenceIndex: 0 },
		);
		expect(hits.map((hit) => hit.itemId)).toEqual(["a", "h", "b"]);
	});

	it("drops an uncovered header and a following body the rectangle only nips", () => {
		const thinHeader = target(1, "h", 0, "header", box(175, 140, 210, 148));
		const next = target(2, "b", 0, "text", box(10, 148, 210, 188));
		const drag = elementDragBoxFromPoints(
			{ x: 20, y: 110 },
			{ x: 180, y: 158 },
		);
		const hits = clipElementDragHits(
			[
				{ itemId: "a", sentenceIndex: 0 },
				{ itemId: "h", sentenceIndex: 0 },
				{ itemId: "b", sentenceIndex: 0 },
			],
			[bodyA, thinHeader, next],
			drag,
			{ itemId: "a", sentenceIndex: 0 },
		);
		expect(hits.map((hit) => hit.itemId)).toEqual(["a"]);
	});

	it("keeps a later section the rectangle really covers even if the header is missed", () => {
		const sideHeader = target(1, "h", 0, "header", box(220, 140, 280, 156));
		const drag = elementDragBoxFromPoints(
			{ x: 20, y: 110 },
			{ x: 180, y: 190 },
		);
		const hits = clipElementDragHits(
			[
				{ itemId: "a", sentenceIndex: 0 },
				{ itemId: "h", sentenceIndex: 0 },
				{ itemId: "b", sentenceIndex: 0 },
			],
			[bodyA, sideHeader, bodyB],
			drag,
			{ itemId: "a", sentenceIndex: 0 },
		);
		expect(hits.map((hit) => hit.itemId)).toEqual(["a", "b"]);
	});

	it("drops a title marked as text when the stroke only reaches its edge", () => {
		const title = target(1, "t", 0, "text", box(10, 140, 210, 156));
		const drag = elementDragBoxFromPoints(
			{ x: 20, y: 110 },
			{ x: 180, y: 143 },
		);
		const hits = clipElementDragHits(
			[
				{ itemId: "a", sentenceIndex: 0 },
				{ itemId: "t", sentenceIndex: 0 },
			],
			[bodyA, title],
			drag,
			{ itemId: "a", sentenceIndex: 0 },
		);
		expect(hits.map((hit) => hit.itemId)).toEqual(["a"]);
	});

	it("prefers the earlier block when the pointer is on a shared edge", () => {
		const nextSentence = target(1, "b", 0, "text", box(10, 140, 210, 180));
		const anchor = elementDragAnchorAt([bodyA, nextSentence], {
			x: 40,
			y: 140,
		});
		expect(anchor).toEqual({ itemId: "a", sentenceIndex: 0 });
	});
});

describe("elementDragSelectionRanges", () => {
	it("stops the native range before the next paragraph", () => {
		document.body.innerHTML =
			'<div id="root"><div data-layout-item="a"><span data-sentence="0">减轻这种工程负担。</span></div><div data-layout-item="b"><span data-sentence="0">我们将这两个要求整合到 RSIGym 中。</span></div></div>';
		const root = document.getElementById("root");
		const first = root?.querySelector('[data-layout-item="a"] [data-sentence]');
		const second = root?.querySelector(
			'[data-layout-item="b"] [data-sentence]',
		);
		if (!root || !first?.firstChild || !second?.firstChild) {
			throw new Error("missing spans");
		}
		const range = document.createRange();
		range.setStart(first.firstChild, 0);
		range.setEnd(second.firstChild, second.textContent?.length ?? 0);
		const parts = elementDragSelectionRanges(
			range,
			root,
			new Set([elementDragHitKey({ itemId: "a", sentenceIndex: 0 })]),
		);
		expect(trimRangeToParts(range, parts)).toBe(true);
		expect(range.toString()).toBe("减轻这种工程负担。");
	});
});
