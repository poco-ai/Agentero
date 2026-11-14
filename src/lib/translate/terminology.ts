import terms from "./data/ai-terms.json";
import { glossaryConstraint, parseGlossary } from "./glossary";

export const TERMINOLOGY_REVISION = "ai-abc74818-ecdict-bc015ed-v2";
export const isKnownDictionaryTerm = (text: string) =>
	terms.some((term) =>
		term.aliases.some(
			(alias) => alias.toLowerCase() === text.trim().toLowerCase(),
		),
	);
export function excludesAiSense(text: string): boolean {
	return /master of laws|law degree|law school|voltage|electrical transformer|power transformer/i.test(
		text,
	);
}
export function hasAiContext(text: string): boolean {
	return (
		!excludesAiSense(text) &&
		/model|neural|attention|token|inference|learning|embedding|gpu|transformer|llm|kv cache|rag|lora/i.test(
			text,
		)
	);
}
export function defaultGlossaryConstraint(
	input: string,
	text: string,
	targetLang: string,
): string {
	const user = parseGlossary(input);
	const defaults =
		targetLang === "zh-CN" && hasAiContext(text)
			? terms.flatMap((term) =>
					term.aliases.map(
						(alias) => [alias, term.translation] as [string, string],
					),
				)
			: [];
	const overridden = new Set(user.map(([key]) => key.toLowerCase()));
	const builtin = defaults.filter(
		([key]) => !overridden.has(key.toLowerCase()),
	);
	const constraints = [builtin, user]
		.map((entries) =>
			entries.length
				? glossaryConstraint(JSON.stringify(Object.fromEntries(entries)), text)
				: "",
		)
		.filter(Boolean);
	return constraints.join("\n\n");
}
