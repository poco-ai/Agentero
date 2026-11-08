import { describe, expect, it } from "vitest";
import { formatEasyScholarMetric, venueInfo } from "@/lib/paper/venue-info";

describe("venueInfo", () => {
	it("prefers a real publication and exposes metrics below it", () => {
		const info = venueInfo({
			publication:
				"IEEE/CVF Conference on Computer Vision and Pattern Recognition",
			tags: [
				"#easyscholar:if=25.6",
				"#easyscholar:rank=CCF=A",
				"#easyscholar:journal=CVPR",
				"nlp",
			],
		});
		expect(info.status).toBe("published");
		expect(info.name).toContain("Computer Vision");
		expect(info.metrics).toEqual(["CCF-A", "IF 25.6"]);
	});

	it("shows a template submission target when no real venue exists", () => {
		const info = venueInfo({
			publication: "arXiv (Cornell University)",
			tags: ["#submitted:AAAI 2027", "#easyscholar:if=9.9"],
		});
		expect(info.status).toBe("submitted");
		expect(info.name).toBe("AAAI 2027");
		expect(info.inferred).toBe(true);
		// Metrics are only valid for a published venue.
		expect(info.metrics).toEqual([]);
	});

	it("labels a repository-only paper as a preprint", () => {
		const info = venueInfo({ publication: "bioRxiv", tags: [] });
		expect(info.status).toBe("preprint");
		expect(info.name).toBe("bioRxiv");
	});

	it("returns an empty venue when nothing is known", () => {
		expect(venueInfo({ publication: "", tags: ["nlp"] }).status).toBe("none");
	});
});

describe("formatEasyScholarMetric", () => {
	it.each([
		["#easyscholar:if=25.6", "IF 25.6"],
		["#easyscholar:if5=30", "IF5 30"],
		["#easyscholar:jci=1.2", "JCI 1.2"],
		["#easyscholar:rank=CCF=A", "CCF-A"],
		["#easyscholar:rank=SCI=Q1", "SCI Q1"],
		["#easyscholar:rank=FMS=A(T1)", "FMS A(T1)"],
		["#easyscholar:rank=UTD24", "UTD24"],
		["#easyscholar:journal=CVPR", null],
	])("formats %s", (name, expected) => {
		expect(formatEasyScholarMetric(name)).toBe(expected);
	});
});
