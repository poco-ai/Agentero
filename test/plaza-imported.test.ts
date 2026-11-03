import { describe, expect, it } from "vitest";
import { matchingImportedIds } from "@/lib/plaza/imported";

describe("ModelScope imported ids", () => {
	it("matches a catalog arXiv id and ignores the version suffix", () => {
		const matched = matchingImportedIds(
			["2501.00001", "2501.00002v3", "not-a-paper"],
			[{ arxiv_id: "2501.00001v1", path: "papers/other" }],
		);
		expect(matched).toEqual(["2501.00001"]);
	});

	it("matches a paper whose folder name is the arXiv id", () => {
		const matched = matchingImportedIds(
			["2503.11111"],
			[{ arxiv_id: null, path: "papers\\2503.11111" }],
		);
		expect(matched).toEqual(["2503.11111"]);
	});
});
