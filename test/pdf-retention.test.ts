import { describe, expect, it } from "vitest";
import { evictPdfBuffers, nextPdfLru } from "@/lib/workspace/pdf-retention";
import { createPlaceholderTab, type DocTab } from "@/lib/workspace/tabs";

function pdfTab(id: string, bytes: ArrayBuffer | null): DocTab {
	return {
		...createPlaceholderTab(id, "pdf", id),
		loaded: true,
		pdfBytes: bytes,
	};
}

describe("PDF workspace retention", () => {
	it("promotes visible PDFs without loading every available restored tab", () => {
		expect(nextPdfLru([], ["a", "b", "c", "d"], ["c"], 2)).toEqual(["c"]);
		expect(nextPdfLru(["c"], ["a", "b", "c", "d"], ["a"], 2)).toEqual([
			"a",
			"c",
		]);
	});

	it("drops closed entries, deduplicates promotions, and preserves equal state", () => {
		const previous = ["a", "b"];
		expect(nextPdfLru(previous, ["a", "b"], ["a", "a"], 2)).toBe(previous);
		expect(nextPdfLru(previous, ["b", "c"], ["c"], 2)).toEqual(["c", "b"]);
		expect(nextPdfLru(previous, [], [], 2)).toEqual([]);
	});

	it("releases local buffers outside the visible/recent set", () => {
		const retained = pdfTab("retained", new ArrayBuffer(8));
		const evicted = pdfTab("evicted", new ArrayBuffer(16));
		const markdown = {
			...createPlaceholderTab("notes.md", "markdown"),
			loaded: true,
		};
		const next = evictPdfBuffers(
			[retained, evicted, markdown],
			new Set([retained.id]),
		);

		expect(next[0]).toBe(retained);
		expect(next[1]).toMatchObject({
			id: "evicted",
			pdfBytes: null,
			loaded: false,
		});
		expect(next[2]).toBe(markdown);
	});
});
