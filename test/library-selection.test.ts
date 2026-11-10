import { describe, expect, it } from "vitest";
import {
	keysIntersectingBand,
	paperSelectionKey,
	pruneKeys,
	rangeKeys,
	sameKeys,
	toggleKey,
} from "@/components/library/library-selection";

const bands = [
	{ key: "a", top: 0, bottom: 50 },
	{ key: "b", top: 50, bottom: 100 },
	{ key: "c", top: 100, bottom: 150 },
];

describe("keysIntersectingBand", () => {
	it("selects every row the box touches, in row order", () => {
		expect(keysIntersectingBand(bands, { top: 40, bottom: 60 })).toEqual([
			"a",
			"b",
		]);
		expect(keysIntersectingBand(bands, { top: 20, bottom: 140 })).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	it("normalizes an upward drag", () => {
		expect(keysIntersectingBand(bands, { top: 90, bottom: 60 })).toEqual(["b"]);
	});

	it("ignores a box that only touches a row edge", () => {
		expect(keysIntersectingBand(bands, { top: 150, bottom: 200 })).toEqual([]);
	});

	it("returns nothing when the box misses the rows", () => {
		expect(keysIntersectingBand(bands, { top: 500, bottom: 600 })).toEqual([]);
	});
});

describe("rangeKeys", () => {
	const order = ["a", "b", "c", "d"];

	it("takes the inclusive slice downwards", () => {
		expect(rangeKeys(order, "b", "d")).toEqual(["b", "c", "d"]);
	});

	it("takes the inclusive slice upwards", () => {
		expect(rangeKeys(order, "d", "b")).toEqual(["b", "c", "d"]);
	});

	it("selects only the clicked row without an anchor", () => {
		expect(rangeKeys(order, null, "c")).toEqual(["c"]);
	});

	it("falls back to the key when it is not in the visible order", () => {
		expect(rangeKeys(order, "a", "zzz")).toEqual(["zzz"]);
	});
});

describe("toggleKey", () => {
	it("adds then removes the key", () => {
		const once = toggleKey(new Set<string>(), "a");
		expect([...once]).toEqual(["a"]);
		expect([...toggleKey(once, "a")]).toEqual([]);
	});

	it("does not mutate the previous set", () => {
		const prev = new Set(["a"]);
		toggleKey(prev, "b");
		expect([...prev]).toEqual(["a"]);
	});
});

describe("pruneKeys", () => {
	it("drops keys that a filter or scope change hid", () => {
		const prev = new Set(["a", "b", "c"]);
		expect([...pruneKeys(prev, ["a", "c"])]).toEqual(["a", "c"]);
	});

	it("keeps the same set instance when nothing was dropped", () => {
		const prev = new Set(["a", "c"]);
		expect(pruneKeys(prev, ["a", "b", "c"])).toBe(prev);
	});
});

describe("sameKeys", () => {
	it("compares by membership, not insertion order", () => {
		expect(sameKeys(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
		expect(sameKeys(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
	});

	it("short-circuits on identity", () => {
		const keys = new Set(["a"]);
		expect(sameKeys(keys, keys)).toBe(true);
	});
});

describe("paperSelectionKey", () => {
	it("prefers the vault-relative path", () => {
		expect(paperSelectionKey({ path: "papers/a", id: "x" })).toBe("papers/a");
	});

	it("falls back to the catalog id", () => {
		expect(paperSelectionKey({ path: "", id: "x" })).toBe("x");
	});
});
