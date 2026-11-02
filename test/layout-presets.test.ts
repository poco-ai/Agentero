import { describe, expect, it } from "vitest";
import {
	LAYOUT_MODE_RIGHT_RATIOS,
	layoutModeRightCollapsed,
	layoutModeRightRatio,
} from "@/lib/shell/layout-presets";

describe("layout presets", () => {
	it("allocates Agent one third of the reading area in Agent mode", () => {
		expect(layoutModeRightRatio("agent")).toBeCloseTo(1 / 3);
	});

	it("collapses Agent in Notes mode", () => {
		expect(layoutModeRightCollapsed("notes")).toBe(true);
		expect(LAYOUT_MODE_RIGHT_RATIOS.notes).toBe(0);
	});

	it("collapses Agent in Reading mode", () => {
		expect(layoutModeRightCollapsed("reading")).toBe(true);
	});
});
