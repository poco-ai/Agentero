import { afterEach, expect, it, vi } from "vitest";
import {
	annotationPdfAnchors,
	annotationRanges,
	releaseAnnotationAnchor,
} from "@/lib/agent/selection-annotations";

afterEach(() => {
	vi.unstubAllGlobals();
	annotationRanges.clear();
	annotationPdfAnchors.clear();
});

it("clears a removed annotation's native selection, cloned highlights and anchors", () => {
	const node = {} as Node;
	const anchor = {
		startContainer: node,
		endContainer: node,
		startOffset: 2,
		endOffset: 8,
	} as Range;
	const unrelated = { ...anchor, startOffset: 12, endOffset: 18 } as Range;
	const clear = vi.fn();
	vi.stubGlobal("window", {
		getSelection: () => ({
			rangeCount: 1,
			getRangeAt: () => ({ ...anchor }),
			removeAllRanges: clear,
		}),
	});
	const highlights = new Map([
		["agentero-annotation-selection", new Set([anchor])],
		["agentero-context-selection", new Set([{ ...anchor }, unrelated])],
	]);
	vi.stubGlobal("CSS", { highlights });
	annotationRanges.set("removed", anchor);
	annotationRanges.set("other", unrelated);
	annotationPdfAnchors.set("removed", {
		documentId: "pdf",
		page: 1,
		rect: { x: 0, y: 0, w: 1, h: 1 },
	});
	releaseAnnotationAnchor("removed");
	expect(clear).toHaveBeenCalledOnce();
	expect(highlights.has("agentero-annotation-selection")).toBe(false);
	expect([...(highlights.get("agentero-context-selection") ?? [])]).toEqual([
		unrelated,
	]);
	expect(annotationRanges.has("removed")).toBe(false);
	expect(annotationPdfAnchors.has("removed")).toBe(false);
	expect(annotationRanges.get("other")).toBe(unrelated);
});

it("does not clear text selected elsewhere when an older annotation is deleted", () => {
	const node = {} as Node;
	const anchor = {
		startContainer: node,
		endContainer: node,
		startOffset: 0,
		endOffset: 5,
	} as Range;
	const clear = vi.fn();
	vi.stubGlobal("window", {
		getSelection: () => ({
			rangeCount: 1,
			getRangeAt: () => ({ ...anchor, startOffset: 10, endOffset: 15 }),
			removeAllRanges: clear,
		}),
	});
	vi.stubGlobal("CSS", { highlights: new Map() });
	annotationRanges.set("old", anchor);
	releaseAnnotationAnchor("old");
	expect(clear).not.toHaveBeenCalled();
});
