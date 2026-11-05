import { describe, expect, it } from "vitest";
import {
	layoutTranslateDisplayRatio,
	layoutTranslateSettledRatio,
} from "@/lib/pdf/layout/layout-translate-progress";

describe("layoutTranslateSettledRatio", () => {
	it("stays unknown until the job has blocks", () => {
		expect(layoutTranslateSettledRatio([])).toBeNull();
	});

	it("counts finished blocks and leaves the ones still translating empty", () => {
		expect(
			layoutTranslateSettledRatio([
				{ status: "done" },
				{ status: "running" },
				{ status: "pending" },
				{ status: "error" },
				{ status: "skipped" },
			]),
		).toBe(0.6);
	});

	it("reaches full when every block has settled", () => {
		expect(
			layoutTranslateSettledRatio([{ status: "done" }, { status: "error" }]),
		).toBe(1);
	});
	it("includes completed sentences in an unfinished paragraph", () => {
		expect(
			layoutTranslateSettledRatio([
				{ status: "running", progress: 0.5 },
				{ status: "done" },
			]),
		).toBe(0.75);
	});
});

describe("layoutTranslateDisplayRatio", () => {
	it("holds the last stretch until the preview is on screen", () => {
		expect(layoutTranslateDisplayRatio(1, true)).toBeLessThan(1);
		expect(layoutTranslateDisplayRatio(0.5, true)).toBe(0.35);
	});

	it("fills the rest once the preview is ready", () => {
		expect(layoutTranslateDisplayRatio(1, false)).toBe(1);
		expect(layoutTranslateDisplayRatio(null, true)).toBeNull();
	});
	it("advances through actual page generation instead of holding a fixed percentage", () => {
		const values = [0, 0.2, 0.5, 0.8, 1].map((built) =>
			layoutTranslateDisplayRatio(1, true, built),
		);
		expect(values).toEqual([0.7, 0.76, 0.85, 0.94, 0.99]);
	});
	it("uses page work alone when all translation results came from cache", () => {
		expect(layoutTranslateDisplayRatio(1, true, 0, true)).toBe(0);
		expect(layoutTranslateDisplayRatio(1, true, 0.5, true)).toBe(0.5);
		expect(layoutTranslateDisplayRatio(1, true, 1, true)).toBe(0.99);
	});
});
