import { describe, expect, it } from "vitest";

import { createHighlight } from "@/lib/pdf/highlight/io";
import { parsePdfHighlight } from "@/lib/pdf/highlight/schema";

const base = {
	version: 1,
	kind: "highlight",
	id: "h1",
	paperPath: "papers/1706.03762",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	page: 2,
	rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.05 }],
	quote: "attention is all you need",
};

describe("pdf-highlight schema", () => {
	it("parses a highlight without comment (backward compatible)", () => {
		const h = parsePdfHighlight(base);
		expect(h).not.toBeNull();
		expect(h?.comment).toBeUndefined();
	});

	it("keeps a string comment", () => {
		const h = parsePdfHighlight({ ...base, comment: "这是动机" });
		expect(h?.comment).toBe("这是动机");
	});

	it("drops a non-string comment", () => {
		const h = parsePdfHighlight({ ...base, comment: 42 });
		expect(h).not.toBeNull();
		expect(h?.comment).toBeUndefined();
	});

	it("drops or trims whitespace comments", () => {
		expect(
			parsePdfHighlight({ ...base, comment: "   " })?.comment,
		).toBeUndefined();
		expect(parsePdfHighlight({ ...base, comment: "  hi  " })?.comment).toBe(
			"hi",
		);
	});

	it("createHighlight carries an optional comment", () => {
		const h = createHighlight({
			paperPath: "papers/x",
			page: 1,
			rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }],
			quote: "q",
			comment: "note",
		});
		expect(h.comment).toBe("note");
		const plain = createHighlight({
			paperPath: "papers/x",
			page: 1,
			rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }],
			quote: "q",
		});
		expect(plain.comment).toBeUndefined();
	});

	it("parses underlines and degrades unknown shapes to highlights", () => {
		expect(parsePdfHighlight({ ...base, kind: "underline" })?.kind).toBe(
			"underline",
		);
		expect(parsePdfHighlight({ ...base, kind: "squiggly" })?.kind).toBe(
			"highlight",
		);
		expect(parsePdfHighlight({ ...base, kind: undefined })?.kind).toBe(
			"highlight",
		);
	});

	it("createHighlight carries the shape", () => {
		const h = createHighlight({
			paperPath: "papers/x",
			page: 1,
			rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }],
			quote: "q",
			kind: "underline",
		});
		expect(h.kind).toBe("underline");
	});
});
