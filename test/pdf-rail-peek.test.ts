import { describe, expect, it } from "vitest";
import { railPeekBandWidth, railPeekScrollDelta } from "@/lib/pdf/rail-peek";

const railWidth = 212;

describe("railPeekScrollDelta", () => {
	it("pans by the rail width when fit-width fills the viewport", () => {
		// Fit-width page ends 10px inside the viewport; the 212px column is off-screen.
		expect(
			railPeekScrollDelta({
				pageRight: 890,
				viewportRight: 900,
				railWidth,
				margin: 8,
				maxPan: 240,
			}),
		).toBe(210);
	});

	it("does not pan when the rail column is already visible", () => {
		expect(
			railPeekScrollDelta({
				pageRight: 600,
				viewportRight: 900,
				railWidth,
				margin: 8,
				maxPan: 240,
			}),
		).toBeNull();
	});

	it("refuses to jump across a page wider than the peek cap", () => {
		// Zoomed in: the page's right edge is far outside the viewport.
		expect(
			railPeekScrollDelta({
				pageRight: 1400,
				viewportRight: 900,
				railWidth,
				margin: 8,
				maxPan: 240,
			}),
		).toBeNull();
	});

	it("ignores a missing page measurement", () => {
		expect(
			railPeekScrollDelta({
				pageRight: Number.NaN,
				viewportRight: 900,
				railWidth,
				margin: 8,
				maxPan: 240,
			}),
		).toBeNull();
	});
});

describe("railPeekBandWidth", () => {
	it("arms only the edge strip before the reveal", () => {
		expect(
			railPeekBandWidth({
				revealed: false,
				edge: 28,
				railWidth,
				margin: 8,
			}),
		).toBe(28);
	});

	it("covers the revealed card column so moving onto a card keeps it open", () => {
		expect(
			railPeekBandWidth({
				revealed: true,
				edge: 28,
				railWidth,
				margin: 8,
			}),
		).toBe(28 + railWidth + 8);
	});
});
