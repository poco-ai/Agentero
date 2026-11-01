import { describe, expect, it } from "vitest";
import { parseLatexLog, resolveLogProblemPath } from "@/lib/tex/log-problems";

describe("latex log problems", () => {
	it("reads file warnings and bang errors as the same list the log shows", () => {
		const problems = parseLatexLog(
			[
				"(./main.tex",
				"LaTeX Warning: Citation `smith' on page 1 undefined on input line 12.",
				"! Undefined control sequence.",
				"l.20 \\foo",
				"./sections/a.tex:4: Package error.",
			].join("\n"),
		);
		expect(problems.map((problem) => problem.severity)).toEqual([
			"warning",
			"error",
			"error",
		]);
		expect(problems[0]).toMatchObject({
			file: "main.tex",
			line: 12,
			logLine: 1,
		});
		expect(problems[1]).toMatchObject({
			line: 20,
			message: "Undefined control sequence.",
		});
		expect(problems[2]).toMatchObject({
			file: "sections/a.tex",
			line: 4,
		});
	});

	it("reads file:line errors named by an absolute path", () => {
		// latexmk passes the root file as an absolute path, and TeX Live prints
		// the drive letter in lower case.
		const problems = parseLatexLog(
			[
				"d:/Users/me/My Papers/thesis/main.tex:14: Undefined control sequence.",
				"C:\\Users\\me\\thesis\\intro.tex:3: LaTeX Error: File `x.sty' not found.",
				"/Users/me/Mobile Documents/thesis/main.tex:7: Package foo Warning: Odd.",
				"\\\\server\\share\\thesis\\main.tex:2: Missing $ inserted.",
				"./my sections/a.tex:4: Extra }, or forgotten $.",
			].join("\n"),
		);
		expect(problems).toMatchObject([
			{
				severity: "error",
				message: "Undefined control sequence.",
				file: "d:/Users/me/My Papers/thesis/main.tex",
				line: 14,
				logLine: 0,
			},
			{
				severity: "error",
				message: "LaTeX Error: File `x.sty' not found.",
				file: "C:\\Users\\me\\thesis\\intro.tex",
				line: 3,
			},
			{
				severity: "warning",
				file: "/Users/me/Mobile Documents/thesis/main.tex",
				line: 7,
			},
			{ file: "\\\\server\\share\\thesis\\main.tex", line: 2 },
			{ file: "my sections/a.tex", line: 4 },
		]);
	});

	it("does not read source text on context lines as a file name", () => {
		expect(
			parseLatexLog(
				[
					"l.12 see main.tex:3: in the log",
					"<argument> ./main.tex:3: is how it reads",
					"[]\\OT1/cmr/m/n/10 compare /tmp/main.tex:3: with",
				].join("\n"),
			),
		).toEqual([]);
	});
});

describe("latex log problem paths", () => {
	const root = "D:\\Vault\\thesis\\note\\main.tex";

	it("maps the absolute names TeX prints back onto the root file's folder", () => {
		expect(resolveLogProblemPath(root, "d:/Vault/thesis/note/main.tex")).toBe(
			root,
		);
		expect(
			resolveLogProblemPath(root, "d:/Vault/thesis/note/sections/intro.tex"),
		).toBe("D:\\Vault\\thesis\\note\\sections\\intro.tex");
		expect(resolveLogProblemPath(root, "sections/intro.tex")).toBe(
			"D:\\Vault\\thesis\\note\\sections\\intro.tex",
		);
		const unix = "/Users/me/Vault/thesis/main.tex";
		expect(resolveLogProblemPath(unix, unix)).toBe(unix);
		expect(
			resolveLogProblemPath(unix, "/Users/me/Vault/thesis/sections/a.tex"),
		).toBe("/Users/me/Vault/thesis/sections/a.tex");
	});

	it("falls back to the root file outside its folder", () => {
		for (const file of [
			undefined,
			"../shared/macros.tex",
			"d:/texlive/2026/texmf-dist/tex/latex/base/article.cls",
			"d:/Vault/thesis/note-old/main.tex",
		]) {
			expect(resolveLogProblemPath(root, file)).toBe(root);
		}
	});
});
