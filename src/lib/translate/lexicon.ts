import i18n from "@/i18n";
import { commands, type DictionaryEntry } from "@/lib/core/bindings";
import { isTauri } from "@/lib/core/tauri";
import { normalizeTermKey } from "./glossary";
import { excludesAiSense, hasAiContext } from "./terminology";

const cache = new Map<string, DictionaryEntry[]>();
const MAX_ENTRIES = 256;
const escapeMarkdown = (value: string) =>
	value.replace(/[\\`*_{}[\]<>]/g, "\\$&");

/** No credentials or network. Missing/damaged resources fall back to the provider. */
export async function lookupDictionary(
	text: string,
	targetLang: string,
): Promise<DictionaryEntry[]> {
	if (!isTauri()) return [];
	const key = JSON.stringify([
		normalizeTermKey(text),
		targetLang,
	]);
	const hit = cache.get(key);
	if (hit) {
		cache.delete(key);
		cache.set(key, hit);
		return hit;
	}
	try {
		const result = await commands.dictionaryLookup(text, targetLang);
		if (!result.ok || !result.data) return [];
		cache.set(key, result.data);
		while (cache.size > MAX_ENTRIES)
			cache.delete(cache.keys().next().value as string);
		return result.data;
	} catch {
		return [];
	}
}

export function renderDictionaryEntries(
	entries: DictionaryEntry[],
	targetLang: string,
): string {
	return entries
		.map((entry) => {
			const source = entry.source === "ecdict" ? "ECDICT" : "AI/LLM Glossary";
			const url =
				entry.source === "ecdict"
					? "https://github.com/skywind3000/ECDICT"
					: entry.sourceUrl;
			const meaning =
				targetLang === "en" ? entry.definition : entry.translation;
			return [
				entry.phonetic ? `/${escapeMarkdown(entry.phonetic)}/` : "",
				...meaning
					.split("\n")
					.filter(Boolean)
					.map((line) => {
						const pos = line.match(
							/^(n|v|vt|vi|a|adj|ad|adv|abbr|prep|conj|pron|interj)\.\s*(.*)$/,
						);
						return pos
							? `**${pos[1]}.** ${escapeMarkdown(pos[2])}`
							: escapeMarkdown(line);
					}),
				`[${source}](${url}) · MIT`,
			]
				.filter(Boolean)
				.join("\n\n");
		})
		.join("\n\n---\n\n");
}

/** Specialist entries win in AI prose; explicit legal/electrical contexts retain general senses. */
export function dictionaryEntriesForContext(
	entries: DictionaryEntry[],
	query: string,
	surrounding = "",
): DictionaryEntry[] {
	const specialist = entries.filter((entry) => entry.source === "ai-glossary");
	const general = entries.filter((entry) => entry.source !== "ai-glossary");
	if (!specialist.length) return entries;
	if (excludesAiSense(surrounding)) return general;
	const standaloneTechnical =
		!surrounding &&
		(/^[A-Z][A-Z0-9-]{1,}$/.test(query) ||
			/^(transformer|kv cache)$/i.test(query));
	if (hasAiContext(surrounding) || standaloneTechnical)
		return specialist.map((entry) => ({
			...entry,
			phonetic: entry.phonetic || general[0]?.phonetic || "",
		}));
	return [...general, ...specialist];
}

export function contextualDictionaryResult(
	base: string,
	context: string,
): string {
	return `${base}\n\n---\n\n**${i18n.t("selection.dictionaryContext", { ns: "viewer" })}**\n\n${context.trim()}`;
}
