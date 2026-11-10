import { EditorState } from "@codemirror/state";
import { latexLanguage } from "codemirror-lang-latex";
import { describe, expect, it } from "vitest";
import {
	activeOutlineSectionId,
	resolveTexInputPath,
	texOutlineFromTree,
} from "@/lib/tex/outline";

function outline(source: string) {
	const doc = EditorState.create({ doc: source }).doc;
	const tree = latexLanguage.parser.parse(source);
	return texOutlineFromTree(tree.topNode, doc);
}

describe("tex outline", () => {
	it("lists sections, nested subsections, and included files in order", () => {
		const items = outline(
			[
				"\\section{\\faGraduationCap\\ 教育背景}",
				"\\subsection{Hello}",
				"\\input{chapters/intro}",
				"\\include{chapters/methods}",
				"\\subfile{extra}",
				"\\section*{Starred}",
				"\\section[short]{Long title}",
				"% \\section{commented}",
				"\\paragraph{skip me}",
			].join("\n"),
		);

		expect(items.map((item) => [item.kind, item.indent, item.title])).toEqual([
			["section", 0, "\\faGraduationCap\\ 教育背景"],
			["section", 1, "Hello"],
			["file", 2, "chapters/intro"],
			["file", 2, "chapters/methods"],
			["file", 2, "extra"],
			["section", 0, "Starred"],
			["section", 0, "Long title"],
		]);
		expect(items[0]?.line).toBe(1);
		expect(items[2]?.fileArg).toBe("chapters/intro");
	});

	it("keeps an input inside a title in the heading, not as a file row", () => {
		const items = outline("\\section{\\input{foo} title}\n\\input{bar}");
		expect(items.map((item) => [item.kind, item.title])).toEqual([
			["section", "\\input{foo} title"],
			["file", "bar"],
		]);
	});

	it("records the heading rank independently of include nesting", () => {
		const items = outline(
			"\\chapter{A}\n\\section{B}\n\\subsection{C}\n\\subsubsection{D}",
		);
		expect(items.map((item) => item.level)).toEqual([0, 1, 2, 3]);
	});

	it("highlights the section that contains the cursor", () => {
		const items = outline("\\section{A}\n\\subsection{B}\n\\chapter{C}");
		expect(activeOutlineSectionId(items, 1)).toBe(items[0]?.id);
		expect(activeOutlineSectionId(items, 2)).toBe(items[1]?.id);
		expect(activeOutlineSectionId(items, 3)).toBe(items[2]?.id);
		expect(activeOutlineSectionId(items, 0)).toBeNull();
	});

	it("unwraps formatting and accents, and lists wrapped section commands", () => {
		const items = outline(
			[
				"\\newcommand{\\mysec}[1]{\\section{#1}}",
				"\\section{\\textbf{R\\'esum\\'e}}",
				"\\mysec{引言}",
			].join("\n"),
		);
		expect(
			items.filter((item) => item.kind === "section").map((item) => item.title),
		).toEqual(["Résumé".normalize("NFC"), "引言"]);
	});

	it("resolves include paths next to the source file", () => {
		expect(
			resolveTexInputPath("/vault/thesis/main.tex", "chapters/intro"),
		).toBe("/vault/thesis/chapters/intro.tex");
		expect(resolveTexInputPath("/vault/thesis/main.tex", "a.tex")).toBe(
			"/vault/thesis/a.tex",
		);
		expect(resolveTexInputPath("C:\\vault\\main.tex", "chapters/intro")).toBe(
			"C:\\vault\\chapters\\intro.tex",
		);
		expect(resolveTexInputPath("/vault/main.tex", "/abs/root")).toBe(
			"/abs/root.tex",
		);
		expect(resolveTexInputPath("/main.tex", "chap")).toBe("/chap.tex");
	});
});
