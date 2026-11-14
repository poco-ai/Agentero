// Placeholder lengths preserve the positions of numbers within each text run.
import { describe, expect, it } from "vitest";
import {
	linkLabelText,
	type PageTextRect,
	parseBracketCitation,
} from "@/lib/pdf/link-text";

function text(
	x: number,
	y: number,
	width: number,
	content: string,
	height = 9,
): PageTextRect {
	return { rect: { origin: { x, y }, size: { width, height } }, content };
}

function link(x: number, y: number, width: number, height = 9) {
	return { origin: { x, y }, size: { width, height } };
}

describe("parseBracketCitation", () => {
	it("disambiguates numbers inside one bracket by link position", () => {
		const line = [text(50, 100, 25, "[1,2],", 10)];
		expect(parseBracketCitation(line, link(52, 100, 8, 10))).toEqual({
			entry: 1,
			range: null,
		});
		expect(parseBracketCitation(line, link(63, 100, 8, 10))).toEqual({
			entry: 2,
			range: null,
		});
	});

	it("reads fragmented runs where only the numbers are linked", () => {
		const line = [
			text(46, 627, 72, "cloud playground [", 10),
			text(118, 628, 8, "10", 8),
			text(127, 631, 5, "–", 3),
			text(133, 628, 8, "12", 8),
			text(142, 633, 2, ", ", 3),
			text(147, 628, 9, "31", 8),
			text(156, 633, 2, ", ", 3),
			text(161, 628, 9, "45", 8),
			text(170, 627, 3, "]", 10),
		];
		expect(parseBracketCitation(line, link(118, 628, 8, 8))).toEqual({
			entry: 10,
			range: { start: 10, end: 12 },
		});
		expect(parseBracketCitation(line, link(133, 628, 8, 8))).toEqual({
			entry: 12,
			range: { start: 10, end: 12 },
		});
		expect(parseBracketCitation(line, link(161, 628, 9, 8))).toEqual({
			entry: 45,
			range: null,
		});
	});

	it("follows a bracket group wrapped onto the next line", () => {
		const lines = [
			text(50, 100, 200, "as cloud in orchard blue [3, 6–", 10),
			text(50, 112, 200, "8] cloud waterfall sky garden.", 10),
		];
		expect(parseBracketCitation(lines, link(235, 100, 6, 10))).toEqual({
			entry: 6,
			range: { start: 6, end: 8 },
		});
		expect(parseBracketCitation(lines, link(50, 112, 6, 10))).toEqual({
			entry: 8,
			range: { start: 6, end: 8 },
		});
	});

	it("rejects numbers that are not inside a numeric bracket group", () => {
		const cases: [PageTextRect[], ReturnType<typeof link>][] = [
			[[text(50, 100, 44, "Theorem"), text(97, 100, 6, "2")], link(96, 100, 8)],
			[[text(50, 100, 34, "Listing"), text(87, 100, 6, "5")], link(86, 100, 8)],
			[
				[text(50, 100, 34, "Lemma"), text(87, 100, 16, "4.1")],
				link(86, 100, 18),
			],
			[[text(50, 100, 40, "Figure"), text(93, 100, 6, "3")], link(92, 100, 8)],
			[[text(50, 100, 70, "an Cloud 16 sky 19")], link(97, 100, 8)],
			[[text(50, 100, 60, "in Section 6.6.")], link(98, 100, 14)],

			[[text(50, 100, 5, "7", 6)], link(50, 100, 5, 6)],

			[[text(50, 100, 60, "(a3, a4, [a21])")], link(92, 100, 8)],

			[[text(50, 100, 40, "[Sky84]")], link(52, 100, 36)],

			[[text(50, 100, 40, "[3, 4 sky")], link(52, 100, 5)],
		];
		for (const [rects, hover] of cases) {
			expect(parseBracketCitation(rects, hover)).toBeNull();
		}
	});

	it("does not bridge into the other column", () => {
		const line = [
			text(50, 100, 200, "orchard cloud [3"),
			text(320, 100, 200, "4] sky blue"),
		];
		expect(parseBracketCitation(line, link(244, 100, 6))).toBeNull();
	});

	it("never fuses separate numeric runs into one number", () => {
		const line = [
			text(50, 100, 5, "["),
			text(55, 100, 5, "5"),
			text(64, 100, 5, "8"),
			text(69, 100, 5, "]"),
		];
		expect(parseBracketCitation(line, link(55, 100, 5))).toBeNull();
	});
});

describe("linkLabelText", () => {
	it("adds the word before a linked number", () => {
		const line = [
			text(50, 100, 60, "cloud in"),
			text(114, 100, 30, "Figure"),
			text(147, 100, 5, "3"),
		];
		expect(linkLabelText(line, link(147, 100, 5))).toBe("Figure 3");
	});

	it("keeps a fully linked label", () => {
		const line = [text(50, 100, 110, "as garden in Table 2 cloud")];

		expect(linkLabelText(line, link(50 + 13 * 4.2, 100, 7 * 4.2))).toBe(
			"in Table 2",
		);
	});

	it("does not pick labels elsewhere in a long run", () => {
		const line = [
			text(
				50,
				100,
				250,
				"waterfall cloud of Table 4 sky sky playground blue Section 5.3.",
			),
		];

		const step = 250 / 63;
		const out = linkLabelText(line, link(50 + 59 * step, 100, 3 * step));
		expect(out).toBe("Section 5.3");
	});
});

describe("parseBracketCitation ranges", () => {
	it("resolves cross-line ranges across tight two-column gutters", () => {
		const textRects = [
			{
				rect: { origin: { x: 49, y: 614 }, size: { width: 237, height: 9 } },
				content: "sunlight sky orchard. Sunlight waterfall [",
			},
			{
				rect: { origin: { x: 288, y: 614 }, size: { width: 9, height: 7 } },
				content: "10",
			},
			{
				rect: { origin: { x: 296, y: 619 }, size: { width: 6, height: 1 } },
				content: "–",
			},

			{
				rect: { origin: { x: 312, y: 614 }, size: { width: 251, height: 9 } },
				content: "of blue cloud), an sky sunlight cloud",
			},

			{
				rect: { origin: { x: 49, y: 626 }, size: { width: 9, height: 7 } },
				content: "15",
			},
			{
				rect: { origin: { x: 58, y: 631 }, size: { width: 2, height: 3 } },
				content: ", ",
			},
			{
				rect: { origin: { x: 66, y: 626 }, size: { width: 9, height: 7 } },
				content: "19",
			},
			{
				rect: { origin: { x: 75, y: 626 }, size: { width: 80, height: 9 } },
				content: "], an sky cloud blue",
			},

			{
				rect: { origin: { x: 312, y: 626 }, size: { width: 118, height: 9 } },
				content: "sunlight cloud an sunlight [",
			},
		];

		const link10 = {
			origin: { x: 285.5, y: 613.2 },
			size: { width: 12.0, height: 8.8 },
		};
		const res10 = parseBracketCitation(textRects, link10);
		expect(res10?.entry).toBe(10);
		expect(res10?.range).toEqual({ start: 10, end: 15 });

		const link15 = {
			origin: { x: 47.2, y: 625.2 },
			size: { width: 12.0, height: 8.8 },
		};
		const res15 = parseBracketCitation(textRects, link15);
		expect(res15?.entry).toBe(15);
		expect(res15?.range).toEqual({ start: 10, end: 15 });

		const link19 = {
			origin: { x: 66.0, y: 625.2 },
			size: { width: 12.0, height: 8.8 },
		};
		const res19 = parseBracketCitation(textRects, link19);
		expect(res19?.entry).toBe(19);
		expect(res19?.range ?? null).toBeNull();
		expect(res19?.entry).toBe(19);
	});

	it("resolves cross-line ranges across word-citation gaps and trailing-dash runs", () => {
		const textRects = [
			{
				rect: { origin: { x: 50, y: 207 }, size: { width: 230, height: 9 } },
				content: "blue blue sunlight an orchard sky playground of orchard [",
			},
			{
				rect: { origin: { x: 288, y: 207 }, size: { width: 7, height: 9 } },
				content: "6",
			},
			{
				rect: { origin: { x: 295, y: 207 }, size: { width: 7, height: 9 } },
				content: "–",
			},
			{
				rect: { origin: { x: 49, y: 219 }, size: { width: 8, height: 9 } },
				content: "8",
			},
			{
				rect: { origin: { x: 57, y: 219 }, size: { width: 20, height: 9 } },
				content: ", 28].",
			},
		];

		const link6 = {
			origin: { x: 288, y: 207 },
			size: { width: 7, height: 9 },
		};
		const res6 = parseBracketCitation(textRects, link6);
		expect(res6?.entry).toBe(6);
		expect(res6?.range).toEqual({ start: 6, end: 8 });

		const link8 = {
			origin: { x: 49, y: 219 },
			size: { width: 8, height: 9 },
		};
		const res8 = parseBracketCitation(textRects, link8);
		expect(res8?.entry).toBe(8);
		expect(res8?.range).toEqual({ start: 6, end: 8 });

		const textRectsCombined = [
			{
				rect: { origin: { x: 50, y: 207 }, size: { width: 230, height: 9 } },
				content: "blue blue sunlight an orchard sky playground of orchard ",
			},
			{
				rect: { origin: { x: 288, y: 207 }, size: { width: 14, height: 9 } },
				content: "[6–",
			},
			{
				rect: { origin: { x: 49, y: 219 }, size: { width: 8, height: 9 } },
				content: "8",
			},
			{
				rect: { origin: { x: 57, y: 219 }, size: { width: 6, height: 9 } },
				content: "].",
			},
		];

		const resCombined6 = parseBracketCitation(textRectsCombined, link6);
		expect(resCombined6?.entry).toBe(6);
		expect(resCombined6?.range).toEqual({ start: 6, end: 8 });

		const resCombined8 = parseBracketCitation(textRectsCombined, link8);
		expect(resCombined8?.entry).toBe(8);
		expect(resCombined8?.range).toEqual({ start: 6, end: 8 });

		const wrappedFragments = [
			{
				rect: { origin: { x: 131, y: 201 }, size: { width: 2, height: 3 } },
				content: ", ",
			},

			{
				rect: { origin: { x: 49, y: 208 }, size: { width: 243, height: 9 } },
				content: "blue blue sunlight an orchard sky playground of orchard [",
			},
			{
				rect: { origin: { x: 292, y: 208 }, size: { width: 5, height: 7 } },
				content: "6",
			},
			{
				rect: { origin: { x: 296, y: 212 }, size: { width: 6, height: 1 } },
				content: "–",
			},

			{
				rect: { origin: { x: 322, y: 209 }, size: { width: 210, height: 9 } },
				content: "Sky garden blue an an blue sky garden playground",
			},

			{
				rect: { origin: { x: 50, y: 219 }, size: { width: 106, height: 9 } },
				content: "8, 28, 43, 60, 70, 71, 76].",
			},
			{
				rect: { origin: { x: 312, y: 221 }, size: { width: 251, height: 9 } },
				content:
					"garden of blue garden sky waterfall sky blue blue) an sky blue",
			},
		];

		const realLink8 = {
			origin: { x: 47.968, y: 218.532 },
			size: { width: 6.973, height: 8.847 },
		};
		const realRes8 = parseBracketCitation(wrappedFragments, realLink8);
		expect(realRes8?.entry).toBe(8);
		expect(realRes8?.range).toEqual({ start: 6, end: 8 });

		const realLink6 = {
			origin: { x: 290.458, y: 206.577 },
			size: { width: 6.974, height: 8.846 },
		};
		const realRes6 = parseBracketCitation(wrappedFragments, realLink6);
		expect(realRes6?.entry).toBe(6);
		expect(realRes6?.range).toEqual({ start: 6, end: 8 });
	});

	it("resolves citation range despite interleaved brackets from tight preceding lines", () => {
		const textRects = [
			{
				rect: { origin: { x: 312, y: 585 }, size: { width: 65, height: 10 } },
				content: "cloud waterfall [",
			},
			{
				rect: { origin: { x: 395, y: 585 }, size: { width: 5, height: 9 } },
				content: "].",
			},

			{
				rect: { origin: { x: 321, y: 597 }, size: { width: 69, height: 10 } },
				content: "Cloud sunlight [",
			},
			{
				rect: { origin: { x: 390, y: 597 }, size: { width: 8, height: 7 } },
				content: "11",
			},
			{
				rect: { origin: { x: 399, y: 601 }, size: { width: 6, height: 1 } },
				content: "–",
			},
			{
				rect: { origin: { x: 405, y: 597 }, size: { width: 8, height: 7 } },
				content: "13",
			},
			{
				rect: { origin: { x: 415, y: 597 }, size: { width: 148, height: 10 } },
				content: "] an blue waterfall an garden sky",
			},
		];

		const link11 = {
			origin: { x: 389.44, y: 592.18 },
			size: { width: 9.96, height: 9.96 },
		};
		const res11 = parseBracketCitation(textRects, link11);
		expect(res11?.entry).toBe(11);
		expect(res11?.range).toEqual({ start: 11, end: 13 });

		const link13 = {
			origin: { x: 404.38, y: 592.18 },
			size: { width: 9.96, height: 9.96 },
		};
		const res13 = parseBracketCitation(textRects, link13);
		expect(res13?.entry).toBe(13);
		expect(res13?.range).toEqual({ start: 11, end: 13 });
	});

	it("resolves adjacent singleton citations on the same line independently", () => {
		const textRects = [
			{
				rect: { origin: { x: 49, y: 650 }, size: { width: 251, height: 10 } },
				content:
					"sky sunlight sunlight blue sky playground playground [44], [45]",
			},
		];
		const link44 = {
			origin: { x: 262.966, y: 648.878 },
			size: { width: 11.955, height: 8.787 },
		};
		const link45 = {
			origin: { x: 285.746, y: 648.878 },
			size: { width: 11.955, height: 8.926 },
		};
		const res44 = parseBracketCitation(textRects, link44);
		const res45 = parseBracketCitation(textRects, link45);

		expect(res44?.entry).toBe(44);
		expect(res44?.range ?? null).toBeNull();
		expect(res45?.entry).toBe(45);
		expect(res45?.range ?? null).toBeNull();
	});

	it("does not match distant citation ranges on the same line to unrelated citations", () => {
		const textRects = [
			{
				rect: { origin: { x: 50, y: 300 }, size: { width: 300, height: 10 } },
				content:
					"cloud blue [1-3] sky waterfall blue playground cloud [44], [45]",
			},
		];
		const link44 = {
			origin: { x: 300, y: 299 },
			size: { width: 15, height: 10 },
		};
		const res44 = parseBracketCitation(textRects, link44);
		expect(res44?.entry).toBe(44);
		expect(res44?.range ?? null).toBeNull();
	});

	it("resolves [4-6, 10] correctly: 4-6 as range and 10 as singleton", () => {
		const textRects = [
			{
				rect: { origin: { x: 50, y: 100 }, size: { width: 200, height: 10 } },
				content: "playground waterfall [4-6, 10] in garden",
			},
		];

		const link4_6 = {
			origin: { x: 158, y: 100 },
			size: { width: 16, height: 10 },
		};

		const link10 = {
			origin: { x: 185, y: 100 },
			size: { width: 12, height: 10 },
		};

		const res4_6 = parseBracketCitation(textRects, link4_6);
		expect(res4_6?.entry).toBe(4);
		expect(res4_6?.range).toEqual({ start: 4, end: 6 });

		const res10 = parseBracketCitation(textRects, link10);
		expect(res10?.entry).toBe(10);
		expect(res10?.range ?? null).toBeNull();
	});
});
