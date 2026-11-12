import { describe, expect, it } from "vitest";
import { railPeekKeepsOpen, railPeekScrollDelta } from "@/lib/pdf/rail-peek";

const railWidth = 212;
const viewport = { left: 0, right: 900, top: 0, bottom: 800 };

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

describe("railPeekKeepsOpen", () => {
	const base = {
		viewport,
		edge: 28,
		railColumn: railWidth,
		halo: 12,
	};

	it("arms on the right-edge strip before the reveal", () => {
		expect(
			railPeekKeepsOpen({
				...base,
				x: 880,
				y: 700,
				revealed: false,
				cards: null,
			}),
		).toBe(true);
	});

	it("ignores the middle of the page before the reveal", () => {
		expect(
			railPeekKeepsOpen({
				...base,
				x: 500,
				y: 400,
				revealed: false,
				cards: null,
			}),
		).toBe(false);
	});

	it("keeps the revealed column open while the pointer is on the cards", () => {
		expect(
			railPeekKeepsOpen({
				...base,
				x: 800,
				y: 300,
				revealed: true,
				cards: { top: 250, bottom: 420 },
			}),
		).toBe(true);
	});

	it("retracts once the pointer leaves the card's vertical span", () => {
		// Same x inside the revealed column, but far below the only card.
		expect(
			railPeekKeepsOpen({
				...base,
				x: 800,
				y: 650,
				revealed: true,
				cards: { top: 250, bottom: 420 },
			}),
		).toBe(false);
	});

	it("allows the halo between stacked cards", () => {
		expect(
			railPeekKeepsOpen({
				...base,
				x: 800,
				y: 430,
				revealed: true,
				cards: { top: 250, bottom: 420 },
			}),
		).toBe(true);
	});

	it("retracts when the pointer leaves the column horizontally", () => {
		expect(
			railPeekKeepsOpen({
				...base,
				x: 600,
				y: 300,
				revealed: true,
				cards: { top: 250, bottom: 420 },
			}),
		).toBe(false);
	});

	it("still keeps the edge strip open away from the cards", () => {
		expect(
			railPeekKeepsOpen({
				...base,
				x: 890,
				y: 650,
				revealed: true,
				cards: { top: 250, bottom: 420 },
			}),
		).toBe(true);
	});

	it("ignores points outside the viewport", () => {
		expect(
			railPeekKeepsOpen({
				...base,
				x: 890,
				y: 900,
				revealed: true,
				cards: { top: 250, bottom: 420 },
			}),
		).toBe(false);
	});
});
