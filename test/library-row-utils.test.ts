import { describe, expect, it } from "vitest";
import {
	addedDate,
	buildPaperRow,
	comparePaperRows,
	isMissingLocalPdf,
} from "@/components/library/library-row-utils";
import type { PaperLibraryRow } from "@/lib/paper";

function row(has_pdf: boolean | undefined): PaperLibraryRow {
	return {
		path: "papers/x",
		id: "x",
		type: "arxiv",
		title: "X",
		authors: [],
		tags: [],
		status: "completed",
		is_read: false,
		added_at: "",
		updated_at: "",
		has_pdf,
	};
}

describe("isMissingLocalPdf", () => {
	it("reports a probed-absent PDF as missing", () => {
		expect(isMissingLocalPdf(row(false))).toBe(true);
	});

	it("reports a probed-present PDF as there", () => {
		expect(isMissingLocalPdf(row(true))).toBe(false);
	});

	// remote_paper_list returns bare records, so nothing ever probed the vault
	// for a local PDF; treating that as "missing" would badge every remote paper.
	it("does not report an unprobed row as missing", () => {
		expect(isMissingLocalPdf(row(undefined))).toBe(false);
	});
});

describe("added-date sorting", () => {
	const paper = (id: string, added_at: string) =>
		buildPaperRow({ ...row(true), id, title: id, added_at });

	it("compares instants across timezone offsets and within the same day", () => {
		const rows = [
			paper("oldest", "2026-09-26T08:00:00+08:00"),
			paper("newest", "2026-09-26T01:01:00Z"),
			paper("middle", "2026-09-25T20:00:00-05:00"),
		];
		expect(
			rows
				.sort((a, b) => comparePaperRows(a, b, "addedAt", "desc"))
				.map((r) => r.paper.id),
		).toEqual(["newest", "middle", "oldest"]);
		expect(
			rows
				.sort((a, b) => comparePaperRows(a, b, "addedAt", "asc"))
				.map((r) => r.paper.id),
		).toEqual(["oldest", "middle", "newest"]);
	});

	it("handles missing/invalid timestamps and uses title/id to break ties", () => {
		const rows = [
			paper("a", ""),
			paper("b", "invalid"),
			paper("c", "2026-09-26T00:00:00Z"),
		];
		expect(
			rows
				.sort((a, b) => comparePaperRows(a, b, "addedAt", "desc"))
				.map((r) => r.paper.id),
		).toEqual(["c", "b", "a"]);
		expect(addedDate(undefined)).toBeNull();
		expect(addedDate("invalid")).toBeNull();
		const a = paper("a", "2026-09-26T00:00:00Z");
		const b = paper("b", "2026-09-26T08:00:00+08:00");
		a.paper.title = b.paper.title = "Same title";
		expect(comparePaperRows(a, b, "addedAt", "asc")).toBeLessThan(0);
	});
});
