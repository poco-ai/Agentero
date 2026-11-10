import { describe, expect, it } from "vitest";
import { latexColorHex } from "@/lib/tex/color";
import { latexFromClipboard } from "@/lib/tex/html-to-latex";
import { plainTexTitle } from "@/lib/tex/plain-title";
import { texRequirements } from "@/lib/tex/requirements";
import {
	bibliographyFilePath,
	bibliographyKind,
	declaredTexBibliographies,
} from "@/lib/tex/source";
import { parseTikz, serializeTikz, tikzPictureAround } from "@/lib/tex/tikz";

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

describe("tikz pictures", () => {
	it("round-trips nodes and edges and keeps unknown statements", () => {
		const source = [
			"\\begin{tikzpicture}",
			"\\node[circle, fill=red] (a) at (1, 2) {Start};",
			"\\node (b) at (3, 2) {End};",
			"\\draw[->] (a) -- (b);",
			"\\fill (0,0) circle (2pt);",
			"\\end{tikzpicture}",
		].join("\n");
		const picture = parseTikz(source);
		expect(
			picture?.nodes.map((node) => [
				node.id,
				node.label,
				node.shape,
				node.fill,
			]),
		).toEqual([
			["a", "Start", "circle", "red"],
			["b", "End", "rectangle", undefined],
		]);
		expect(picture?.edges).toMatchObject([
			{ source: "a", target: "b", arrow: true },
		]);
		expect(picture?.rest).toEqual(["\\fill (0,0) circle (2pt);"]);
		if (!picture) throw new Error("picture");
		const written = serializeTikz(picture);
		const again = parseTikz(written);
		expect(again?.nodes.map((node) => node.label)).toEqual(["Start", "End"]);
		expect(again?.rest).toEqual(["\\fill (0,0) circle (2pt);"]);
		expect(tikzPictureAround(`before\n${source}\nafter`, 10)).toEqual({
			from: 7,
			to: 7 + source.length,
		});
		expect(latexColorHex("red!50")).toMatch(/^#[0-9a-f]{6}$/);
		expect(latexColorHex("not-a-color")).toBeNull();
	});
});

describe("html clipboard", () => {
	it("returns null without a DOM parser", () => {
		expect(latexFromClipboard("<p>Hello</p>", "Hello")).toBeNull();
	});
});
