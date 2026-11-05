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
});

describe("layoutTranslateDisplayRatio", () => {
	it("holds the last stretch until the preview is on screen", () => {
		expect(layoutTranslateDisplayRatio(1, true)).toBeLessThan(1);
		expect(layoutTranslateDisplayRatio(0.5, true)).toBe(0.5);
	});

	it("fills the rest once the preview is ready", () => {
		expect(layoutTranslateDisplayRatio(1, false)).toBe(1);
		expect(layoutTranslateDisplayRatio(null, true)).toBeNull();
	});
});
