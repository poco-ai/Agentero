import { describe, expect, it } from "vitest";
import {
	citationHrefFromWikiParts,
	citationLabelFromHref,
	isAgentCitationHref,
	isCitationStatusLabel,
	isVaultPdfHref,
	paperDirFromCitationPath,
	rewriteCitationHrefToPdf,
	stripCitationStatusTags,
} from "@/lib/agent/citation-href";

describe("paperDirFromCitationPath", () => {
	it("strips source/ and marks/ suffixes", () => {
		expect(
			paperDirFromCitationPath(
				"papers/2303.17760/source/sections/introduction.tex",
			),
		).toBe("papers/2303.17760");
		expect(paperDirFromCitationPath("papers/a/marks/x.json")).toBe("papers/a");
	});
});

describe("rewriteCitationHrefToPdf", () => {
	it("rewrites tex paths under source/ to the paper PDF", () => {
		expect(
			rewriteCitationHrefToPdf(
				"papers/2303.17760/source/sections/introduction.tex",
			),
		).toBe("papers/2303.17760/2303.17760.pdf");
	});

	it("preserves fragments when rewriting", () => {
		expect(
			rewriteCitationHrefToPdf(
				"papers/2303.17760/source/sections/intro.tex#section=2.3",
			),
		).toBe("papers/2303.17760/2303.17760.pdf#section=2.3");
	});

	it("leaves pdf and notes hrefs unchanged", () => {
		expect(
			rewriteCitationHrefToPdf("papers/2303.17760/2303.17760.pdf#page=11"),
		).toBe("papers/2303.17760/2303.17760.pdf#page=11");
		expect(rewriteCitationHrefToPdf("papers/2303.17760/NOTES.md")).toBe(
			"papers/2303.17760/NOTES.md",
		);
	});
});

describe("isAgentCitationHref", () => {
	it("accepts pdf fragment citations", () => {
		expect(
			isAgentCitationHref("papers/vla/2504.16054/2504.16054.pdf#page=1"),
		).toBe(true);
		expect(
			isAgentCitationHref("papers/vla/2504.16054/2504.16054.pdf#section=4"),
		).toBe(true);
		expect(
			isAgentCitationHref("papers/vla/2504.16054/2504.16054.pdf#figure=3"),
		).toBe(true);
		expect(
			isAgentCitationHref("papers/vla/2504.16054/2504.16054.pdf#formula=3"),
		).toBe(true);
		expect(
			isAgentCitationHref("papers/vla/2504.16054/2504.16054.pdf#equation=3"),
		).toBe(false);
	});

	it("rejects plain paths and http urls", () => {
		expect(isAgentCitationHref("papers/vla/2504.16054/2504.16054.pdf")).toBe(
			false,
		);
		expect(isAgentCitationHref("https://example.com/a.pdf#page=1")).toBe(false);
		expect(isAgentCitationHref("papers/vla/2504.16054/NOTES.md#Intro")).toBe(
			false,
		);
	});

	it("tolerates zero-width spaces around the href", () => {
		expect(
			isAgentCitationHref(
				"\u200bpapers/vla/2504.16054/2504.16054.pdf#page=1\u200b",
			),
		).toBe(true);
	});

	it("accepts percent-encoded paths with spaces", () => {
		expect(
			isAgentCitationHref(
				"/papers/Quantum%20Error%20Correcting/parallel%20window/2209.08552/2209.08552.pdf#page=4",
			),
		).toBe(true);
	});
});

describe("isVaultPdfHref", () => {
	it("accepts a PDF path with or without a fragment", () => {
		expect(
			isVaultPdfHref(
				"./papers/Quantum%20Error%20Correcting/parallel%20window/2209.08552/2209.08552.pdf",
			),
		).toBe(true);
		expect(
			isVaultPdfHref(
				"papers/Quantum Error Correcting/parallel window/2209.08552/2209.08552.pdf#page=4",
			),
		).toBe(true);
	});

	it("rejects notes and http pdf urls", () => {
		expect(isVaultPdfHref("papers/a/NOTES.md")).toBe(false);
		expect(isVaultPdfHref("https://example.com/a.pdf")).toBe(false);
	});
});

describe("stripCitationStatusTags", () => {
	it("removes trailing status tags from source lines", () => {
		expect(
			stripCitationStatusTags(
				"papers/Dflash/2608.02438/NOTES.md [blocked]\npapers/a/a.pdf#page=11 [read]",
			),
		).toBe("papers/Dflash/2608.02438/NOTES.md\npapers/a/a.pdf#page=11");
	});
});

describe("citation status labels", () => {
	it("detects status-only link labels", () => {
		expect(isCitationStatusLabel("blocked")).toBe(true);
		expect(isCitationStatusLabel("Failed")).toBe(true);
		expect(isCitationStatusLabel("Section 2")).toBe(false);
	});

	it("derives a pill label from the href when the label is a status word", () => {
		expect(
			citationLabelFromHref("papers/vla/2504.16054/2504.16054.pdf#page=11"),
		).toBe("2504.16054.pdf · p.11");
		expect(citationLabelFromHref("papers/a/NOTES.md")).toBe("NOTES.md");
	});
});

describe("citationHrefFromWikiParts", () => {
	it("maps wiki heading page=/section= onto a citation href", () => {
		expect(
			citationHrefFromWikiParts("papers/a/a.pdf", {
				kind: "heading",
				path: ["page=1"],
			}),
		).toBe("papers/a/a.pdf#page=1");
		expect(
			citationHrefFromWikiParts("papers/a/a.pdf", {
				kind: "heading",
				path: ["Intro"],
			}),
		).toBeNull();
	});
});

describe("PDF document anchors", () => {
	it("routes section and paragraph shorthand only for PDF targets", () => {
		for (const fragment of ["2", "2.1", "2#p3", "2.1#p3"]) {
			expect(isAgentCitationHref(`papers/a/a.pdf#${fragment}`)).toBe(true);
			expect(isAgentCitationHref(`papers/a/NOTES.md#${fragment}`)).toBe(false);
			expect(
				citationHrefFromWikiParts("papers/a/a.pdf", {
					kind: "heading",
					path: fragment.split("#"),
				}),
			).toBe(`papers/a/a.pdf#${fragment}`);
			expect(
				citationHrefFromWikiParts("papers/a/NOTES.md", {
					kind: "heading",
					path: fragment.split("#"),
				}),
			).toBeNull();
		}
		expect(isAgentCitationHref("https://example.com/a.pdf#2#p3")).toBe(false);
		expect(isAgentCitationHref("papers/a/a.pdf#2%23p3")).toBe(true);
	});
});
