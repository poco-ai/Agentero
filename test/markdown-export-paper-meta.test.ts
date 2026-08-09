import { describe, expect, it } from "vitest";
import {
	exportDefaultName,
	formatPaperAuthorsLine,
	paperShareLink,
	resolveExportPaperHeader,
} from "@/lib/markdown/export/paper-meta";
import type { PaperMetadata } from "@/lib/paper/types";

function paper(
	partial: Partial<PaperMetadata> & Pick<PaperMetadata, "title">,
): PaperMetadata {
	return {
		id: partial.id ?? "p1",
		type: partial.type ?? "arxiv",
		title: partial.title,
		authors: partial.authors ?? [],
		tags: partial.tags ?? [],
		status: partial.status ?? "completed",
		added_at: partial.added_at ?? "2026-01-01",
		updated_at: partial.updated_at ?? "2026-01-01",
		...partial,
	};
}

describe("paperShareLink", () => {
	it("prefers arXiv abs URL", () => {
		const link = paperShareLink(
			paper({ title: "Attention", arxiv_id: "1706.03762", doi: "10.1/x" }),
		);
		expect(link).toEqual({
			url: "https://arxiv.org/abs/1706.03762",
			label: "arXiv:1706.03762",
		});
	});

	it("falls back to DOI", () => {
		const link = paperShareLink(paper({ title: "X", doi: "10.1000/xyz" }));
		expect(link).toEqual({
			url: "https://doi.org/10.1000/xyz",
			label: "doi:10.1000/xyz",
		});
	});
});

describe("formatPaperAuthorsLine", () => {
	it("joins small lists and truncates long ones", () => {
		expect(formatPaperAuthorsLine(["A", "B"])).toBe("A, B");
		expect(formatPaperAuthorsLine(["1", "2", "3", "4", "5", "6", "7"], 6)).toBe(
			"1, 2, 3, 4, 5, 6 et al.",
		);
	});
});

describe("resolveExportPaperHeader", () => {
	const vault = "/vault";
	const notes = "/vault/papers/1706.03762/NOTES.md";
	const meta = paper({
		title: "Attention Is All You Need",
		authors: ["Vaswani", "Shazeer"],
		year: 2017,
		arxiv_id: "1706.03762",
		path: "papers/1706.03762",
	});

	it("returns header for paper NOTES.md", () => {
		const map = new Map([["papers/1706.03762", meta]]);
		const header = resolveExportPaperHeader({
			filePath: notes,
			vaultPath: vault,
			paperMetaByRelPath: map,
		});
		expect(header?.title).toBe("Attention Is All You Need");
		expect(header?.authorsLine).toBe("Vaswani, Shazeer");
		expect(header?.year).toBe(2017);
		expect(header?.link).toBe("https://arxiv.org/abs/1706.03762");
	});

	it("returns null for ordinary notes", () => {
		const map = new Map([["papers/1706.03762", meta]]);
		expect(
			resolveExportPaperHeader({
				filePath: "/vault/notes/daily.md",
				vaultPath: vault,
				paperMetaByRelPath: map,
			}),
		).toBeNull();
	});
});

describe("exportDefaultName", () => {
	it("prefers paper title", () => {
		expect(
			exportDefaultName("/vault/papers/x/NOTES.md", {
				title: "Hello: World?",
				authorsLine: null,
				year: null,
				link: null,
				linkLabel: null,
			}),
		).toBe("Hello- World");
	});

	it("falls back to basename", () => {
		expect(exportDefaultName("/vault/notes/weekly.md", null)).toBe("weekly");
	});
});
