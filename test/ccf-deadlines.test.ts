import { describe, expect, it } from "vitest";
import {
	ccfDeadlineInstant,
	ccfTimezoneOffsetHours,
	parseCcfDeadlines,
} from "@/lib/plaza/ccf-deadlines";

describe("ccfTimezoneOffsetHours", () => {
	it.each([
		["AoE", -12],
		["PT", -8],
		["UTC", 0],
		["UTC+0", 0],
		["UTC+8", 8],
		["UTC-5", -5],
		["UTC-12", -12],
		["UTC+5.5", 5.5],
	])("maps %s to %d hours", (label, expected) => {
		expect(ccfTimezoneOffsetHours(label)).toBe(expected);
	});

	it("returns null for an unknown label", () => {
		expect(ccfTimezoneOffsetHours("CEST")).toBeNull();
	});
});

describe("ccfDeadlineInstant", () => {
	it("shifts a venue-local AoE deadline into UTC", () => {
		const local = Date.UTC(2026, 4, 1, 23, 59, 59);
		expect(ccfDeadlineInstant("2026-05-01 23:59:59", "AoE")).toBe(
			local + 12 * 3_600_000,
		);
	});

	it("returns null on an unknown timezone or malformed date", () => {
		expect(ccfDeadlineInstant("2026-05-01 23:59:59", "CEST")).toBeNull();
		expect(ccfDeadlineInstant("not-a-date", "UTC")).toBeNull();
	});
});

describe("parseCcfDeadlines", () => {
	const now = Date.UTC(2026, 0, 1);
	const payload = {
		conferences: [
			{
				title: "AAA",
				conference_key: "AI/aaa",
				rank: { ccf: "A" },
				confs: [
					{
						id: "aaa27",
						year: 2027,
						link: "https://aaa.example",
						timezone: "AoE",
						timeline: [
							{ deadline: "2027-05-01 23:59:59", comment: "Round 1" },
							{ deadline: "TBD" },
							{ deadline: "2020-01-01 00:00:00" },
						],
					},
				],
			},
			{
				title: "BBB",
				conference_key: "DB/bbb",
				rank: { ccf: "B" },
				confs: [
					{
						id: "bbb27",
						year: 2027,
						link: "https://bbb.example",
						timezone: "UTC+8",
						timeline: [{ deadline: "2027-03-01 23:59:59" }],
					},
				],
			},
			{ title: "NoRank", conference_key: "AI/norank", rank: {}, confs: [] },
		],
	};

	it("keeps only future, ranked deadlines sorted ascending", () => {
		const items = parseCcfDeadlines(payload, now);
		expect(items.map((item) => item.title)).toEqual(["BBB", "AAA"]);
	});

	it("carries rank, year, link, timezone and comment through", () => {
		const [bbb, aaa] = parseCcfDeadlines(payload, now);
		expect(bbb).toMatchObject({
			rank: "B",
			year: 2027,
			editionId: "bbb27",
			link: "https://bbb.example",
			timezone: "UTC+8",
			at: ccfDeadlineInstant("2027-03-01 23:59:59", "UTC+8"),
		});
		expect(aaa).toMatchObject({ rank: "A", comment: "Round 1" });
	});

	it("tolerates a malformed payload", () => {
		expect(parseCcfDeadlines(null, now)).toEqual([]);
		expect(parseCcfDeadlines({ conferences: "nope" }, now)).toEqual([]);
	});
});
