import { describe, expect, it } from "vitest";
import { fitToolbarActions } from "@/components/editor/toolbar/fit-actions";

const BUTTON = 34;
const OVERFLOW = 34;

describe("fitToolbarActions", () => {
	it("keeps every action when the row fits", () => {
		const widths = Array.from({ length: 6 }, () => BUTTON);
		expect(fitToolbarActions(widths, 6 * BUTTON, OVERFLOW)).toBe(6);
		expect(fitToolbarActions(widths, 6 * BUTTON + 40, OVERFLOW)).toBe(6);
	});

	it("reserves room for the overflow trigger once something is hidden", () => {
		const widths = Array.from({ length: 6 }, () => BUTTON);
		// 6 actions (204) > 150, so only what fits in 150 - 34 = 116 is shown.
		expect(fitToolbarActions(widths, 150, OVERFLOW)).toBe(3);
	});

	it("collapses to nothing when the trailing cluster leaves no room", () => {
		const widths = Array.from({ length: 6 }, () => BUTTON);
		expect(fitToolbarActions(widths, 0, OVERFLOW)).toBe(0);
		expect(fitToolbarActions(widths, 20, OVERFLOW)).toBe(0);
	});

	it("is stable when the fit is re-measured against the same width", () => {
		// The toolbar used to feed its own count back into the measured width
		// (a separator rendered only while something was visible), so the count
		// flipped forever between 0 and 1. The width passed in must be the
		// bar's, never the collapsed action row's.
		const widths = [32, 32, 32, 32, 32, 32];
		const available = 74;
		const first = fitToolbarActions(widths, available, 32);
		const second = fitToolbarActions(widths, available, 32);
		expect(first).toBe(1);
		expect(second).toBe(first);
	});

	it("never grows when the available width shrinks", () => {
		const widths = [40, 28, 28, 45, 28, 28, 28, 28, 28, 45, 28, 28, 28, 28];
		let previous = widths.length;
		for (let available = 600; available >= 0; available -= 7) {
			const count = fitToolbarActions(widths, available, OVERFLOW);
			expect(count).toBeLessThanOrEqual(previous);
			previous = count;
		}
	});
});
