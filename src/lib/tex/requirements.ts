/**
 * Source patterns a default latexmk run does not finish on its own.
 * Notices stay out of the ChkTeX list and show with the build problems.
 */

import { texSourceCode } from "@/lib/tex/source";

export type TexRequirementId =
	| "minted"
	| "glossaries"
	| "pythontex"
	| "shellEscape";

export type TexRequirement = {
	id: TexRequirementId;
	line: number;
};

const PATTERNS: { id: TexRequirementId; pattern: RegExp }[] = [
	{
		id: "minted",
		pattern:
			/\\usepackage(?:\s*\[[^\]]*\])?\s*\{[^}]*\bminted\b[^}]*\}|\\begin\s*\{minted\}/,
	},
	{
		id: "glossaries",
		pattern:
			/\\usepackage(?:\s*\[[^\]]*\])?\s*\{[^}]*\bglossaries\b[^}]*\}|\\makeglossaries\b/,
	},
	{
		id: "pythontex",
		pattern: /\\usepackage(?:\s*\[[^\]]*\])?\s*\{[^}]*\bpythontex\b[^}]*\}/,
	},
	{
		id: "shellEscape",
		pattern: /\\write18\b/,
	},
];

function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset; index += 1)
		if (text.charCodeAt(index) === 10) line += 1;
	return line;
}

/** One notice per requirement, at the first mention in this file. */
export function texRequirements(source: string): TexRequirement[] {
	const text = texSourceCode(source);
	const found: TexRequirement[] = [];
	for (const { id, pattern } of PATTERNS) {
		const match = pattern.exec(text);
		if (!match || match.index === undefined) continue;
		found.push({ id, line: lineAt(source, match.index) });
	}
	return found;
}
