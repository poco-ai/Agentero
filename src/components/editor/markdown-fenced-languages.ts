import {
	LanguageDescription,
	LanguageSupport,
	StreamLanguage,
} from "@codemirror/language";

/** Load a grammar only when the Markdown parser encounters its fence. */
export const markdownFencedLanguages = [
	LanguageDescription.of({
		name: "JavaScript",
		alias: ["js", "jsx", "mjs", "cjs"],
		load: async () =>
			(await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
	}),
	LanguageDescription.of({
		name: "TypeScript",
		alias: ["ts", "tsx", "mts", "cts"],
		load: async () =>
			(await import("@codemirror/lang-javascript")).javascript({
				typescript: true,
				jsx: true,
			}),
	}),
	LanguageDescription.of({
		name: "Python",
		alias: ["py"],
		load: async () => (await import("@codemirror/lang-python")).python(),
	}),
	LanguageDescription.of({
		name: "JSON",
		load: async () => (await import("@codemirror/lang-json")).json(),
	}),
	LanguageDescription.of({
		name: "YAML",
		alias: ["yml"],
		load: async () => (await import("@codemirror/lang-yaml")).yaml(),
	}),
	LanguageDescription.of({
		name: "HTML",
		load: async () => (await import("@codemirror/lang-html")).html(),
	}),
	LanguageDescription.of({
		name: "CSS",
		load: async () => (await import("@codemirror/lang-css")).css(),
	}),
	LanguageDescription.of({
		name: "Shell",
		alias: ["sh", "bash", "zsh"],
		load: async () =>
			new LanguageSupport(
				StreamLanguage.define(
					(await import("@codemirror/legacy-modes/mode/shell")).shell,
				),
			),
	}),
	LanguageDescription.of({
		name: "LaTeX",
		alias: ["tex"],
		load: async () =>
			new LanguageSupport(
				(await import("codemirror-lang-latex")).latexLanguage,
			),
	}),
];
