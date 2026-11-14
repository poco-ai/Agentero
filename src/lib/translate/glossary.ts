/** User-authored, directional terminology; no bundled dictionary data. */
export const MAX_GLOSSARY_CHARS = 16000;
export function parseGlossary(input: string): [string, string][] {
	if (input.length > MAX_GLOSSARY_CHARS) throw new Error("limit");
	const value = input.trim();
	if (!value) return [];
	let entries: [string, unknown][];
	if (value.startsWith("{")) {
		const data: unknown = JSON.parse(value);
		if (!data || typeof data !== "object" || Array.isArray(data))
			throw new Error("format");
		entries = Object.entries(data);
	} else {
		entries = value
			.split(/[\r\n,，]+/u)
			.filter((line) => line.trim())
			.map((line) => {
				const match = line.match(/^(.+?)(?:->|→|:|：)(.*)$/u);
				if (!match) throw new Error("format");
				return [match[1], match[2]];
			});
	}
	if (entries.length > 200) throw new Error("limit");
	const terms = new Map<string, string>();
	for (const [source, target] of entries) {
		if (typeof target !== "string") throw new Error("format");
		const key = source.trim();
		const translation = target.trim();
		if (
			!key ||
			!translation ||
			key.length > 120 ||
			translation.length > 240 ||
			/[\r\n\t]/u.test(key + translation)
		)
			throw new Error("format");
		terms.set(key, translation);
	}
	return [...terms].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
export function glossaryConstraint(input: string, text: string): string {
	const wordCharacter = (char: string | undefined) =>
		char !== undefined &&
		/[\p{L}\p{N}_]/u.test(char) &&
		!/[\u4e00-\u9fff]/u.test(char);
	const terms = parseGlossary(input).filter(([source]) => {
		const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const chars = Array.from(source);
		return Array.from(text.matchAll(new RegExp(escaped, "giu"))).some(
			(match) => {
				const start = match.index;
				const end = start + match[0].length;
				return (
					(!wordCharacter(chars[0]) ||
						!wordCharacter(Array.from(text.slice(0, start)).at(-1))) &&
					(!wordCharacter(chars.at(-1)) ||
						!wordCharacter(Array.from(text.slice(end))[0]))
				);
			},
		);
	});
	return terms.length
		? `Required terminology (source → target; apply only to the selected text):\n${JSON.stringify(Object.fromEntries(terms))}`
		: "";
}
