import { describe, expect, it } from "vitest";
import {
	clampPageScroll,
	createPageTurnGesture,
	pageTurnTarget,
} from "@/lib/pdf/page-turn";
import { isPdfScrollStrategy } from "@/lib/settings/types";

describe("paginated PDF navigation", () => {
	it("reads an enlarged page to its edge before turning, without carrying overshoot", () => {
		const bounds = { top: 820, bottom: 2020 };
		expect(pageTurnTarget(bounds, 820, 600, 900)).toEqual({ top: 1420 });
		expect(pageTurnTarget(bounds, 1420, 600, 80)).toEqual({ turn: 1 });
		expect(pageTurnTarget(bounds, 1000, 600, -900)).toEqual({ top: 820 });
		expect(pageTurnTarget(bounds, 820, 600, -80)).toEqual({ turn: -1 });
	});

	it("turns short pages immediately and keeps coordinate jumps inside the current page", () => {
		const bounds = { top: 820, bottom: 1120 };
		expect(pageTurnTarget(bounds, 820, 600, 80)).toEqual({ turn: 1 });
		expect(clampPageScroll(bounds, 600, 1100)).toBe(820);
		expect(clampPageScroll({ top: 820, bottom: 2020 }, 600, 1600)).toBe(1420);
	});

	it("absorbs the entire momentum tail after a turn and accepts the next gesture", () => {
		const gesture = createPageTurnGesture();
		expect(gesture.accept(0)).toBe(true);
		gesture.markTurned();
		for (let time = 16; time < 1000; time += 16) {
			expect(gesture.accept(time)).toBe(false);
		}
		expect(gesture.accept(1300)).toBe(true);
	});

	it("accepts the new persisted mode while rejecting unknown settings", () => {
		expect(isPdfScrollStrategy("paginated")).toBe(true);
		expect(isPdfScrollStrategy("diagonal")).toBe(false);
	});
});
