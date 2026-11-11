import { describe, expect, it } from "vitest";

import {
	tintedTranslateRecords,
	translateHighlightsByPage,
	translateHighlightsFingerprint,
} from "@/lib/pdf/translate/highlights";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";

function record(id: string, page: number, result = ""): PdfTranslateRecord {
	return {
		version: 1,
		kind: "translate",
		id,
		paperPath: "papers/test",
		createdAt: "2026-09-02T00:00:00Z",
		page,
		rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
		quote: "source",
		result,
	};
}

describe("translateHighlightsByPage", () => {
	it("groups spans by page and ignores streamed result text", () => {
		const first = record("a", 2, "");
		const streamed = record("a", 2, "译文");
		expect(translateHighlightsFingerprint([first])).toBe(
			translateHighlightsFingerprint([streamed]),
		);
		const byPage = translateHighlightsByPage([
			first,
			record("b", 2),
			record("c", 3),
		]);
		expect(byPage.get(2)?.map((item) => item.id)).toEqual(["a", "b"]);
		expect(byPage.get(3)?.map((item) => item.id)).toEqual(["c"]);
	});
});

describe("tintedTranslateRecords", () => {
	it("keeps only pinned results after their card is closed", () => {
		const pinned = { ...record("a", 2), pinned: true };
		const discarded = record("b", 2);
		expect(
			tintedTranslateRecords([pinned, discarded]).map((r) => r.id),
		).toEqual(["a"]);
	});
});
