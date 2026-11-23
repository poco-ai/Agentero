import { describe, expect, it } from "vitest";

import { reflowHighlightLineBands } from "@/components/viewer/pdf/layers/reflow-page-overlay";

describe("reflowHighlightLineBands", () => {
	it("joins glyphs on one line into a single band", () => {
		const bands = reflowHighlightLineBands([
			{ left: 10, top: 20, width: 8, height: 12 },
			{ left: 18, top: 20, width: 8, height: 12 },
		]);
		expect(bands).toEqual([{ left: 10, top: 20, width: 16, height: 12 }]);
	});

	it("keeps the next line as its own band", () => {
		const bands = reflowHighlightLineBands([
			{ left: 10, top: 20, width: 40, height: 12 },
			{ left: 10, top: 40, width: 40, height: 12 },
		]);
		expect(bands).toHaveLength(2);
		expect(bands[0]?.top).toBe(20);
		expect(bands[1]?.top).toBe(40);
	});
});
