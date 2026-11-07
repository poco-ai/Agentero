import { describe, expect, it } from "vitest";
import {
	scrollTopForViewportAnchor,
	visibleAnchorTop,
} from "@/lib/markdown/source-mode-alignment";

describe("Markdown source mode alignment", () => {
	it("accepts only anchors that are inside the visible height", () => {
		expect(visibleAnchorTop(320, 800)).toBe(320);
		expect(visibleAnchorTop(0, 800)).toBe(0);
		expect(visibleAnchorTop(-1, 800)).toBeNull();
		expect(visibleAnchorTop(801, 800)).toBeNull();
		expect(visibleAnchorTop(null, 800)).toBeNull();
		expect(visibleAnchorTop(120, 0)).toBeNull();
	});

	it("keeps an anchor at the same visual height across mode switches", () => {
		expect(
			scrollTopForViewportAnchor({
				anchorTop: 1200,
				anchorViewportTop: 320,
				scrollHeight: 4000,
				clientHeight: 800,
			}),
		).toBe(880);
	});

	it("clamps at the start and end so the viewport never over-scrolls", () => {
		expect(
			scrollTopForViewportAnchor({
				anchorTop: 120,
				anchorViewportTop: 300,
				scrollHeight: 4000,
				clientHeight: 800,
			}),
		).toBe(0);
		expect(
			scrollTopForViewportAnchor({
				anchorTop: 3900,
				anchorViewportTop: 100,
				scrollHeight: 4000,
				clientHeight: 800,
			}),
		).toBe(3200);
	});

	it("does not scroll a document shorter than the viewport", () => {
		expect(
			scrollTopForViewportAnchor({
				anchorTop: 320,
				anchorViewportTop: 100,
				scrollHeight: 600,
				clientHeight: 800,
			}),
		).toBe(0);
	});
});
