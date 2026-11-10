import { describe, expect, it } from "vitest";
import { latexFromClipboard } from "@/lib/tex/html-to-latex";
import { plainTexTitle } from "@/lib/tex/plain-title";
import { texRequirements } from "@/lib/tex/requirements";
import {
	bibliographyFilePath,
	bibliographyKind,
	declaredTexBibliographies,
} from "@/lib/tex/source";

describe("plain tex titles", () => {
	it("keeps unknown commands and decodes accents", () => {
		expect(plainTexTitle("\\faGraduationCap\\ 教育背景")).toBe(
			"\\faGraduationCap\\ 教育背景",
		);
		expect(plainTexTitle("R\\'esum\\'e").normalize("NFC")).toBe("Résumé");
		expect(plainTexTitle("\\textbf{\\emph{Hello}}")).toBe("Hello");
		expect(plainTexTitle(String.raw`Schr\"{o}dinger`).normalize("NFC")).toBe(
			"Schrödinger",
		);
	});
});

describe("bibliography paths", () => {
	it("keeps project-relative bib files and drops urls and parent escapes", () => {
		expect(bibliographyFilePath("refs")).toBe("refs.bib");
		expect(bibliographyFilePath("chapters/refs.bib")).toBe("chapters/refs.bib");
		expect(bibliographyFilePath("../shared.bib")).toBeNull();
		expect(bibliographyFilePath("https://example.com/a.bib")).toBeNull();
		expect(bibliographyFilePath("/tmp/a.bib")).toBeNull();
		expect(
			declaredTexBibliographies("\\bibliography{refs, ../no, notes.bib}"),
		).toEqual(["refs.bib", "notes.bib"]);
		expect(
			bibliographyKind("\\usepackage{biblatex}\n\\addbibresource{refs.bib}"),
		).toBe("biblatex");
		expect(bibliographyKind("\\bibliography{refs}")).toBe("bibtex");
	});
});

describe("tex requirements", () => {
	it("notices external tools and ignores commented packages", () => {
		expect(texRequirements("% \\usepackage{minted}\nHello")).toEqual([]);
		expect(texRequirements("\\usepackage{minted}\n\\write18{ls}")).toEqual([
			{ id: "minted", line: 1 },
			{ id: "shellEscape", line: 2 },
		]);
		expect(
			texRequirements("\\usepackage{glossaries}\n\\usepackage{pythontex}"),
		).toEqual([
			{ id: "glossaries", line: 1 },
			{ id: "pythontex", line: 2 },
		]);
	});
});

describe("html clipboard", () => {
	it("returns null without a DOM parser", () => {
		expect(latexFromClipboard("<p>Hello</p>", "Hello")).toBeNull();
	});
});
