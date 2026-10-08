import { describe, expect, it } from "vitest";
import {
	ccfDeadlineInstant,
	ccfNextYearDeadline,
	ccfTimezoneOffsetHours,
	parseCcfDeadlines,
	predictCcfDeadlines,
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

describe("ccfNextYearDeadline", () => {
	it("shifts a year forward keeping the weekday", () => {
		// 2026-01-29 is a Thursday; the next Thursday in Jan 2027 is the 28th.
		expect(ccfNextYearDeadline("2026-01-29 23:59:59")).toBe(
			"2027-01-28 23:59:59",
		);
	});

	it("handles Feb 29 spilling into a non-leap year", () => {
		expect(ccfNextYearDeadline("2024-02-29 23:59:59")).toBe(
			"2025-02-27 23:59:59",
		);
	});

	it("returns null on malformed input", () => {
		expect(ccfNextYearDeadline("TBD")).toBeNull();
		expect(ccfNextYearDeadline("2026-01-29")).toBeNull();
	});
});

describe("predictCcfDeadlines", () => {
	const now = Date.UTC(2026, 9, 8); // 2026-10-08

	const conference = (over: Record<string, unknown> = {}) => ({
		title: "ICML",
		conference_key: "AI/icml",
		rank: { ccf: "A" },
		confs: [
			{
				id: "icml26",
				year: 2026,
				link: "https://icml.example/2026",
				timezone: "UTC-12",
				timeline: [{ deadline: "2026-01-29 23:59:59" }],
			},
		],
		...over,
	});

	it("estimates the next cycle from the latest past edition", () => {
		const [item] = predictCcfDeadlines([{ conferences: [conference()] }], now);
		expect(item).toMatchObject({
			title: "ICML",
			rank: "A",
			year: 2027,
			deadline: "2027-01-28 23:59:59",
			estimated: true,
			link: "https://icml.example/2026",
		});
	});

	it("skips conferences that still have a future official deadline", () => {
		const future = conference({
			confs: [
				{
					id: "icml27",
					year: 2027,
					timezone: "UTC-12",
					timeline: [{ deadline: "2027-01-28 23:59:59" }],
				},
			],
		});
		expect(predictCcfDeadlines([{ conferences: [future] }], now)).toEqual([]);
	});

	it("skips non A/B/C venues and stale cycles", () => {
		const n = conference({ rank: { ccf: "N" } });
		const stale = conference({
			confs: [
				{
					id: "icml20",
					year: 2020,
					timezone: "UTC-12",
					timeline: [{ deadline: "2020-01-30 23:59:59" }],
				},
			],
		});
		expect(predictCcfDeadlines([{ conferences: [n, stale] }], now)).toEqual([]);
	});

	it("merges the history array with the initial payload", () => {
		const history = [
			conference({
				confs: [
					{
						id: "icml25",
						year: 2025,
						timezone: "UTC-12",
						timeline: [{ deadline: "2025-01-30 23:59:59" }],
					},
				],
			}),
		];
		const initial = conference({
			confs: [
				{
					id: "icml26",
					year: 2026,
					timezone: "UTC-12",
					timeline: [{ deadline: "2026-01-29 23:59:59" }],
				},
			],
		});
		const [item] = predictCcfDeadlines(
			[{ conferences: [initial] }, history],
			now,
		);
		expect(item?.year).toBe(2027);
	});
});
