// Placeholder lengths preserve the positions of numbers within each text run.
import { describe, expect, it } from "vitest";
import {
	authorYearCitationGroup,
	authorYearLinkText,
	bracketCitationTokens,
	groupLineSegments,
	linkLabelText,
	type PageTextRect,
	pageTextRectsFromGlyphs,
	parseBracketCitation,
	parseSuperscriptCitation,
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

it("retains every author-year citation inside the same parentheses across lines", () => {
	const first = "Evidence (Alpha 2020; Beta and",
		second = "Gamma 2021; Delta 2022) differs from Epsilon (2023).";
	const rects = [
		text(50, 100, first.length * 5, first),
		text(50, 113, second.length * 5, second),
	];
	const links = [
		{ key: "a", rect: link(50 + first.indexOf("2020") * 5, 100, 20) },
		{ key: "b", rect: link(50 + second.indexOf("2021") * 5, 113, 20) },
		{ key: "c", rect: link(50 + second.indexOf("2022") * 5, 113, 20) },
		{ key: "d", rect: link(50 + second.indexOf("2023") * 5, 113, 20) },
	];
	for (const target of links.slice(0, 3))
		expect(authorYearCitationGroup(rects, target.rect, links)).toEqual([
			{ key: "a", citationText: "Alpha (2020)" },
			{ key: "b", citationText: "Beta and Gamma (2021)" },
			{ key: "c", citationText: "Delta (2022)" },
		]);
	expect(authorYearCitationGroup(rects, links[3].rect, links)).toEqual([
		{ key: "d", citationText: "Epsilon (2023)" },
	]);
});

it("keeps repeated years with the shared author while excluding the next prose citation", () => {
	const source = "Alpha (2020, 2021) and Beta (2022) report.";
	const rects = [text(50, 100, source.length * 5, source)];
	const links = ["2020", "2021", "2022"].map((year) => ({
		key: year,
		rect: link(50 + source.indexOf(year) * 5, 100, 20),
	}));
	expect(authorYearCitationGroup(rects, links[0].rect, links)).toEqual([
		{ key: "2020", citationText: "Alpha (2020)" },
		{ key: "2021", citationText: "Alpha (2021)" },
	]);
});

it("does not borrow a year from the previous line touched by a tall annotation", () => {
	const rects = [
		text(50, 100, 160, "Evidence (Alpha 2020;"),
		text(50, 111, 160, "Beta 2021; Gamma 2022)"),
	];
	const links = [
		{ key: "a", rect: link(170, 98, 40, 13) },
		{ key: "b", rect: link(50 + (5 * 160) / 21, 108, (4 * 160) / 21, 13) },
		{ key: "c", rect: link(50 + (16 * 160) / 21, 108, (4 * 160) / 21, 13) },
	];
	expect(authorYearCitationGroup(rects, links[1].rect, links)).toEqual([
		{ key: "a", citationText: "Alpha (2020)" },
		{ key: "b", citationText: "Beta (2021)" },
		{ key: "c", citationText: "Gamma (2022)" },
	]);
});

it.each([
	["See (Alpha&Beta,2021, 140–143).", "2021", "Alpha & Beta (2021)"],
	["Evidence (Alpha,Beta, etal. 2022).", "2022", "Alpha, Beta, et al. (2022)"],
	["Evidence (Alpha andAlpha 2024).", "2024", "Alpha and Alpha (2024)"],
	["Cf. Alpha et al., 2026)", "2026", "Alpha et al. (2026)"],
	["Further, Alpha et al. (2017)", "2017", "Alpha et al. (2017)"],
	["As Alpha (2011) explains", "2011", "Alpha (2011)"],
	["Similarly, Alpha (2019) argues", "2019", "Alpha (2019)"],
	["According to Alpha’s (1957) theory", "1957", "Alpha (1957)"],
	["Similarly, Alpha & Beta’s (1979) theory", "1979", "Alpha & Beta (1979)"],
	["Other evidence (e.g., Alpha et al., 2025).", "2025", "Alpha et al. (2025)"],
	[
		"A report by the U.S. Department ofCommerce (2025) explains.",
		"2025",
		"U.S. Department of Commerce (2025)",
	],
])("reads grammatical citation authors in %s", (source, year, expected) => {
	expect(
		authorYearLinkText(
			[text(50, 100, source.length * 5, source)],
			link(50 + source.indexOf(year) * 5, 100, 20),
		),
	).toBe(expected);
});

it("reads the year even when its link contains a semicolon", () => {
	const source = "Evidence (Alpha, 2006; Beta, 2019).";
	expect(
		authorYearLinkText(
			[text(50, 100, source.length * 5, source)],
			link(50 + source.indexOf("2006") * 5, 100, 25),
		),
	).toBe("Alpha (2006)");
});

it("retains both native keys when an author abbreviation omits its internal space", () => {
	const first = "Evidence (Alpha etal., 2026; Alphaet al.,";
	const second = "2026). More discussion.";
	const rects = [
		text(50, 100, first.length * 5, first),
		text(50, 113, second.length * 5, second),
	];
	const links = [
		{ key: "first", rect: link(50 + first.indexOf("2026") * 5, 100, 20) },
		{ key: "second", rect: link(50, 113, 20) },
	];
	for (const target of links)
		expect(authorYearCitationGroup(rects, target.rect, links)).toEqual([
			{ key: "first", citationText: "Alpha et al. (2026)" },
			{ key: "second", citationText: "Alpha et al. (2026)" },
		]);
});

it("uses the preceding page's final body line for a page-broken author", () => {
	const source = "et al. 2020; Beta et al. 2021).";
	expect(
		authorYearLinkText(
			[text(50, 34, source.length * 5, source)],
			link(85, 34, 20),
			[
				text(50, 710, 230, "Unrelated preceding column."),
				text(310, 700, 230, "Earlier discussion in this column."),
				text(
					310,
					713,
					230,
					"observations (Ordiz et al. 2014; Morales-González",
				),
				text(50, 770, 30, "8 of 11"),
			],
		),
	).toBe("Morales-González et al. (2020)");
});

it("restores a font-omitted line-end surname hyphen before the linked year", () => {
	const first = "As Alpha",
		second = "ton (2020) explains.";
	expect(
		authorYearLinkText(
			[
				text(50, 100, first.length * 5, first),
				text(50, 113, second.length * 5, second),
			],
			link(75, 113, 20),
		),
	).toBe("Alphaton (2020)");
});

it("retains a compound surname with a capitalized second part after a soft hyphen", () => {
	const first = "Evidence (Alpha & Beta\u00ad",
		second = "Gamma, 2020).";
	expect(
		authorYearLinkText(
			[
				text(50, 100, first.length * 5, first),
				text(50, 113, second.length * 5, second),
			],
			link(85, 113, 20),
		),
	).toBe("Alpha & Beta-Gamma (2020)");
});

it("separates a missing space before an author conjunction", () => {
	const source = "Evidence (Alphaand Beta 2020).";
	expect(
		authorYearLinkText(
			[text(50, 100, source.length * 5, source)],
			link(50 + source.indexOf("2020") * 5, 100, 20),
		),
	).toBe("Alpha and Beta (2020)");
});

it("keeps parenthetical acronyms inside an institutional author", () => {
	const source = "Evidence (Annual Education Report (AER), 2023).";
	expect(
		authorYearLinkText(
			[text(50, 100, source.length * 5, source)],
			link(50 + source.indexOf("2023") * 5, 100, 20),
		),
	).toBe("Annual Education Report (AER) (2023)");
});

it("preserves a three-line institutional author and its dotted location", () => {
	const lines = [
		"capacity (Institute of",
		"Research in Washington, D.C.,",
		"2025) establishes.",
	];
	expect(
		authorYearLinkText(
			lines.map((line, i) => text(300, 100 + i * 13, line.length * 5, line)),
			link(300, 126, 20),
		),
	).toBe("Institute of Research in Washington, D.C. (2025)");
});

it("restores an author list continued from the bottom of the preceding column", () => {
	const left = "Evidence (Alpha, Beta, and";
	const right = "Gamma 2024; Delta 2023).";
	const rects = [
		text(50, 600, 240, "The preceding column begins here."),
		text(50, 700, 240, left),
		text(310, 600, right.length * 5, right),
		text(310, 613, 240, "The next line of the right column."),
	];
	expect(authorYearLinkText(rects, link(340, 600, 20))).toBe(
		"Alpha, Beta, and Gamma (2024)",
	);
});

it("keeps all members of a citation group continued in the next column", () => {
	const left = "Earlier (Alpha 2020; Beta and",
		right = "Gamma 2021; Delta 2022).";
	const rects = [
		text(50, 600, 230, "The first column begins."),
		text(500, 575, 45, "JOURNAL", 6),
		text(
			50,
			745,
			480,
			"This article is distributed under an open access licence.",
			7,
		),
		text(50, 755, 160, "provided that it is cited.", 7),
		text(50, 700, left.length * 5, left),
		text(310, 600, right.length * 5, right),
		text(310, 613, 230, "The second column continues."),
	];
	const links = [
		{ key: "a", rect: link(50 + left.indexOf("2020") * 5, 700, 20) },
		{ key: "b", rect: link(310 + right.indexOf("2021") * 5, 600, 20) },
		{ key: "c", rect: link(310 + right.indexOf("2022") * 5, 600, 20) },
	];
	for (const target of links)
		expect(authorYearCitationGroup(rects, target.rect, links)).toEqual([
			{ key: "a", citationText: "Alpha (2020)" },
			{ key: "b", citationText: "Beta and Gamma (2021)" },
			{ key: "c", citationText: "Delta (2022)" },
		]);
});

it("reads a wrapped comma-separated author list before a year-only link", () => {
	const first = "Introduced by Alpha, Beta, and";
	const second = "Gamma (2025) to explain.";
	expect(
		authorYearLinkText(
			[
				text(300, 100, first.length * 5, first),
				text(300, 113, second.length * 5, second),
			],
			link(335, 113, 20),
		),
	).toBe("Alpha, Beta, and Gamma (2025)");
});
it("does not include a sentence article in the author identity on the previous line", () => {
	const first = "properties. The Alpha et al.";
	const second = "(2024) framework.";
	expect(
		authorYearLinkText(
			[
				text(300, 100, first.length * 5, first),
				text(300, 113, second.length * 5, second),
			],
			link(305, 113, 20),
		),
	).toBe("Alpha et al. (2024)");
});
it("excludes a transition followed by an article from the cited author", () => {
	const source = "publication. Similarly, the Alpha et al. (2020)";
	expect(
		authorYearLinkText(
			[text(50, 100, source.length * 5, source)],
			link(50 + source.indexOf("2020") * 5, 100, 20),
		),
	).toBe("Alpha et al. (2020)");
});
it("does not read an uppercase suffix of a dataset identifier as an author", () => {
	const first = "Use the dataset laion/relaion2B-multi-";
	const second = "research Hugging Face 2025).";
	expect(
		authorYearLinkText(
			[
				text(50, 100, first.length * 5, first),
				text(50, 112, second.length * 5, second),
			],
			link(50 + second.indexOf("2025") * 5, 112, 20),
		),
	).toBe("Hugging Face (2025)");
});

it("restores an attached surname particle without losing a grouped reference", () => {
	const source = "Evidence (Alpha 2026;vanDiggelen etal., 2009).";
	const rects = [text(50, 100, source.length * 5, source)];
	const links = [
		{ key: "a", rect: link(50 + source.indexOf("2026") * 5, 100, 20) },
		{ key: "b", rect: link(50 + source.indexOf("2009") * 5, 100, 20) },
	];
	expect(authorYearCitationGroup(rects, links[1].rect, links)).toEqual([
		{ key: "a", citationText: "Alpha (2026)" },
		{ key: "b", citationText: "Diggelen et al. (2009)" },
	]);
});

it("restores a wrapped hyphenated surname before a year-only link", () => {
	const first = "Data Report and the Alpha, Beta, and Van\u00ad",
		second = "schoren (2020) ABC.";
	expect(
		authorYearLinkText(
			[
				text(300, 100, first.length * 5, first),
				text(300, 113, second.length * 5, second),
			],
			link(345, 113, 20),
		),
	).toBe("Alpha, Beta, and Vanschoren (2020)");
});

describe("parseSuperscriptCitation", () => {
	it("does not interpret a leading affiliation number as a bibliography citation", () => {
		expect(
			parseSuperscriptCitation(
				[
					text(53, 262, 3, "1", 5),
					text(56, 265, 220, "Key Laboratory of Physical Electronics", 8),
				],
				link(53, 262, 3, 8),
			),
		).toBeNull();
	});
	it("does not borrow a staggered neighbouring column to raise a baseline figure number", () => {
		const rects = [
			text(269, 371, 18, "Fig.", 10),
			text(289, 371, 5, "1", 10),
			text(315, 380, 5, "p", 9),
		];
		expect(
			parseSuperscriptCitation(rects, link(289, 370.5, 5.3, 10.5)),
		).toBeNull();
	});
	it("does not treat a descender on the same line as a raised figure number", () => {
		const rects = [
			text(315, 174, 9, "Fi", 7),
			text(324, 176, 5, "g", 8),
			text(329, 174, 3, ".", 7),
			text(335, 174, 5, "4", 7),
			text(344, 174, 20, "shows", 7),
		];
		expect(
			parseSuperscriptCitation(rects, link(335, 173.4, 5.3, 10.5)),
		).toBeNull();
	});
	it("keeps adjacent prose glyphs out of a raised citation group", () => {
		const rects = [
			text(191, 636, 7, "N", 9),
			text(198, 636, 2, ".", 9),
			text(200, 630, 4, "3", 10),
			text(204, 630, 1, ",", 10),
			text(205, 630, 4, "4", 10),
			text(212, 636, 5, "E", 9),
			text(217, 636, 6, "f", 6),
		];
		expect(
			parseSuperscriptCitation(rects, link(200.3, 630.65, 3.57, 9.98)),
		).toMatchObject({ entry: 3, range: null });
	});
	it("separates a raised reference from a preceding numeric exponent", () => {
		const rects = [
			text(373, 605, 8, "10", 8),
			text(381, 605, 3, "6", 3),
			text(386, 605, 5, "41", 3),
			text(395, 605, 6, "C", 8),
		];
		expect(
			parseSuperscriptCitation(rects, link(385.8, 605.25, 4.82, 4.93)),
		).toMatchObject({ entry: 41, range: null });
	});
	it("reads a raised native number even when its ink band is as tall as prose", () => {
		const rects = [
			text(160, 636, 40, "GaN.", 9),
			text(200, 630, 4, "3", 10),
			text(204, 630, 1, ",", 10),
			text(205, 630, 4, "4", 10),
			text(212, 636, 45, "Effective", 9),
		];
		expect(
			parseSuperscriptCitation(rects, link(200, 630, 4, 10)),
		).toMatchObject({
			entry: 3,
			range: null,
		});
		expect(
			parseSuperscriptCitation(rects, link(205, 630, 4, 10)),
		).toMatchObject({
			entry: 4,
			range: null,
		});
	});
	it("selects the hovered raised range without absorbing a nearby baseline measurement", () => {
		const rects = [
			text(30, 100, 60, "737 nm.", 10),
			text(90, 96, 50, "8–11,15–18", 6),
		];
		expect(
			parseSuperscriptCitation(rects, link(90, 96, 50, 6), { x: 125, y: 99 }),
		).toMatchObject({
			entry: 15,
			range: { start: 15, end: 18 },
		});
	});
	it("rejects baseline figure numbers and isolated digits", () => {
		expect(
			parseSuperscriptCitation(
				[text(40, 100, 50, "Figure", 10), text(90, 100, 5, "3", 10)],
				link(90, 100, 5, 10),
			),
		).toBeNull();
		expect(
			parseSuperscriptCitation([text(90, 96, 5, "3", 6)], link(90, 96, 5, 6)),
		).toBeNull();
	});
});

describe("parseBracketCitation", () => {
	it("ignores a whitespace advance entirely covered by a visible citation digit", () => {
		const rects = [
			text(341, 555, 3, "["),
			text(344, 562, 3, " ", 1),
			text(344, 555, 5, "2"),
			text(349, 555, 5, "8"),
			text(354, 562, 4, " ", 1),
			text(354, 555, 3, "]"),
			text(357, 555, 3, "."),
		];
		expect(parseBracketCitation(rects, link(343, 553, 12, 12))).toMatchObject({
			entry: 28,
			range: null,
		});
	});
	it("recovers the shared prefix on the second linked panel in a figure list", () => {
		const content = "See Figs. 4(a) and 4(b).";
		expect(
			linkLabelText(
				[text(0, 0, content.length * 5, content)],
				link(content.indexOf("4(b)") * 5, 0, 20),
			),
		).toBe("Figs. 4(b)");
	});
	it("recovers a shared figure prefix across a wrapped panel list", () => {
		const a = "See Figs. 6(b) and",
			b = "6(d) for details.";
		expect(
			linkLabelText(
				[text(0, 0, a.length * 5, a), text(0, 11, b.length * 5, b)],
				link(0, 11, 20),
			),
		).toBe("Figs. 6(d)");
	});
	it("uses the pointer within a publisher link covering two separate ranges", () => {
		const line = [text(50, 100, 110, "[8–11,15–18]", 10)];
		const annotation = link(50, 100, 110, 10);
		expect(
			parseBracketCitation(line, annotation, { x: 70, y: 105 }),
		).toMatchObject({
			entry: 8,
			range: { start: 8, end: 11 },
		});
		expect(
			parseBracketCitation(line, annotation, { x: 125, y: 105 }),
		).toMatchObject({
			entry: 15,
			range: { start: 15, end: 18 },
		});
	});
	it("exposes separate citation tokens for reflowed multi-entry links", () => {
		expect(bracketCitationTokens("[1,12,17]")).toEqual([
			{
				start: 1,
				end: 2,
				citation: { entry: 1, range: null, entries: [1, 12, 17] },
			},
			{
				start: 3,
				end: 5,
				citation: { entry: 12, range: null, entries: [1, 12, 17] },
			},
			{
				start: 6,
				end: 8,
				citation: { entry: 17, range: null, entries: [1, 12, 17] },
			},
		]);
		expect(
			bracketCitationTokens("[8–11,15–18]").map((t) => t.citation.range),
		).toEqual([
			{ start: 8, end: 11 },
			{ start: 15, end: 18 },
		]);
		expect(bracketCitationTokens("Table 2")).toEqual([]);
	});
	it("disambiguates numbers inside one bracket by link position", () => {
		const line = [text(50, 100, 25, "[1,2],", 10)];
		expect(parseBracketCitation(line, link(52, 100, 8, 10))).toMatchObject({
			entry: 1,
			range: null,
		});
		expect(parseBracketCitation(line, link(63, 100, 8, 10))).toMatchObject({
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
		expect(parseBracketCitation(line, link(118, 628, 8, 8))).toMatchObject({
			entry: 10,
			range: { start: 10, end: 12 },
		});
		expect(parseBracketCitation(line, link(133, 628, 8, 8))).toMatchObject({
			entry: 12,
			range: { start: 10, end: 12 },
		});
		expect(parseBracketCitation(line, link(161, 628, 9, 8))).toMatchObject({
			entry: 45,
			range: null,
		});
	});

	it("follows a bracket group wrapped onto the next line", () => {
		const lines = [
			text(50, 100, 200, "as cloud in orchard blue [3, 6–", 10),
			text(50, 112, 200, "8] cloud waterfall sky garden.", 10),
		];
		expect(parseBracketCitation(lines, link(235, 100, 6, 10))).toMatchObject({
			entry: 6,
			range: { start: 6, end: 8 },
		});
		expect(parseBracketCitation(lines, link(50, 112, 6, 10))).toMatchObject({
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
	it("uses the annotation boundary when a text layer omits a space before a label", () => {
		const lines = [text(40, 100, 45, "inFig. 7.", 9)];
		expect(linkLabelText(lines, link(50, 100, 30, 9))).toBe("in Fig. 7");
	});
	it("keeps the linked label when an earlier wrapped reference shares the line", () => {
		const lines = [
			text(40, 100, 155, "The temperature is shown in Fig.", 9),
			text(40, 111, 155, "5(a).From Fig. 4 another value.", 9),
		];
		expect(linkLabelText(lines, link(40 + 10 * 5, 111, 6 * 5, 9))).toBe(
			"5(a).From Fig. 4",
		);
	});
	it("recognizes both annotations of a figure label wrapped at the column edge", () => {
		const lines = [
			text(40, 100, 200, "The temperature is shown in Fig.", 9),
			text(40, 111, 200, "5(a). The next statement follows.", 9),
		];
		expect(linkLabelText(lines, link(215, 100, 25, 9))).toContain("Fig. 5");
		expect(linkLabelText(lines, link(40, 111, 6, 9))).toContain("Fig. 5");
	});
	it("recovers a figure label split by a PDF soft hyphen on the preceding line", () => {
		const lines = [
			text(50, 100, 110, "The caption uses Fig\u00ad", 10),
			text(50, 112, 60, "ure 10g next", 10),
		];
		expect(linkLabelText(lines, link(50 + 4 * 5, 112, 10, 10))).toBe(
			"Figure 10",
		);
	});
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

describe("pageTextRectsFromGlyphs", () => {
	it("does not let a rotated chart label merge neighbouring prose lines", () => {
		const lines = ["See Fig. 2", "Another row"];
		const glyphs = lines.flatMap((value, row) =>
			[...value].map((_, i) => ({
				origin: { x: 40 + i * 5, y: 100 + row * 12 },
				size: { width: 5, height: 10 },
				tightOrigin: { x: 40 + i * 5, y: 102 + row * 12 },
				tightSize: { width: 4, height: 7 },
				textMatrix: [10, 0, 0, 10, 40, 690],
				textAngle: 0,
			})),
		);
		glyphs.push({
			origin: { x: 320, y: 80 },
			size: { width: 10, height: 60 },
			tightOrigin: { x: 322, y: 80 },
			tightSize: { width: 7, height: 60 },
			textMatrix: [0, 10, -10, 0, 320, 690],
			textAngle: Math.PI / 2,
		});
		const rects = pageTextRectsFromGlyphs(glyphs, [...lines.join(""), "T"]);
		expect(linkLabelText(rects, link(60, 100, 30, 10))).toBe("See Fig. 2");
		expect(rects.every((r) => r.rect.size.height < 12)).toBe(true);
	});
	it("keeps word spaces and digit advances while separating overlapping font boxes by baseline", () => {
		// PDF font boxes are 15 pt high on 12.5 pt leading. Their actual ink
		// bands do not overlap. The word space and comma must share that band.
		const chars = "Fig. 4 [51,52]";
		const glyphs = [...chars].map((ch, index) => ({
			origin: { x: 50 + index * 5, y: 100 },
			size: { width: 5, height: 15 },
			tightOrigin: {
				x: 50 + index * 5 + (ch === "1" ? 2 : 0),
				y: /[,. ]/.test(ch) ? 110 : 103,
			},
			tightSize: {
				width: ch === "1" ? 3 : 5,
				height: /[,. ]/.test(ch) ? 1 : 8,
			},
			textMatrix: [10, 0, 0, 10, 50, 690],
		}));
		const next = glyphs.map((g) => ({
			...g,
			origin: { ...g.origin, y: 112.5 },
			tightOrigin: { ...g.tightOrigin, y: g.tightOrigin.y + 12.5 },
			textMatrix: [10, 0, 0, 10, 50, 677.5],
		}));
		const rects = pageTextRectsFromGlyphs(
			[...glyphs, ...next],
			[...chars, ..."next line here"],
		);
		expect(linkLabelText(rects, link(75, 100, 5, 15))).toBe("Fig. 4");
		expect(parseBracketCitation(rects, link(90, 100, 10, 15))).toMatchObject({
			entry: 51,
			range: null,
		});
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

it("preserves character indices when PDFium returns null glyph slots", () => {
	const glyph = { origin: { x: 50, y: 100 }, size: { width: 5, height: 10 } };
	const result = pageTextRectsFromGlyphs(
		[null, glyph, undefined, { ...glyph, origin: { x: 55, y: 100 } }],
		["", "1", "", "8"],
	);
	expect(result.map((r) => r.content).join("")).toBe("18");
});

it("reads the equation noun past the opening parenthesis of a digit-only annotation", () => {
	const source = "See Equation ( 2 ) for details.";
	const rects = [text(50, 100, source.length * 5, source, 10)];
	expect(
		linkLabelText(rects, link(50 + source.indexOf("2") * 5, 100, 5, 10)),
	).toMatch(/Equation\s*\(\s*2/);
});

it("does not let a tall synthetic word space merge bibliography lines", () => {
	const rects = [
		text(314, 221, 100, "4. Author. Title", 7),
		text(314, 231, 100, "continuation", 8),
		text(314, 241, 100, "Journal. DOI", 7),
		text(340, 226, 4, " ", 22),
	];
	const segments = groupLineSegments(rects).filter((s) =>
		s.glyphs.some((g) => g.ch.trim()),
	);
	expect(segments).toHaveLength(3);
	expect(segments[0].glyphs.map((g) => g.ch).join("")).toBe("4. Author. Title");
});
