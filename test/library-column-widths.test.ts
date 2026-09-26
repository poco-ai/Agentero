import { expect, it } from "vitest";
import { resolveColumnWidths } from "@/components/library/library-column-widths";

it("keeps saved widths exact while adaptive columns fill available space", () => {
	expect(
		resolveColumnWidths(
			[
				{ key: "title", visible: true, widthRem: 30 },
				{ key: "authors", visible: true },
			],
			80,
			() => 1,
		),
	).toEqual([30, 50]);
	expect(
		resolveColumnWidths(
			[
				{ key: "title", visible: true, widthRem: 90 },
				{ key: "authors", visible: true },
			],
			40,
			() => 1,
		),
	).toEqual([90, 5]);
	expect(
		resolveColumnWidths(
			[
				{ key: "title", visible: true, widthRem: 20 },
				{ key: "authors", visible: true, widthRem: 10 },
			],
			80,
			() => 1,
		),
	).toEqual([20, 10]);
});
