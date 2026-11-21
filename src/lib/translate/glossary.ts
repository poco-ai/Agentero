/** User-authored, directional terminology; no bundled dictionary data. */
export const MAX_GLOSSARY_CHARS = 16000;

/** Shared lookup policy mirrored by core glossary.rs and dictionary staging. */
export function normalizeTermKey(value: string): string {
	return value
		.replace(/[\p{White_Space}\u2010-\u2015\u2212-]+/gu, " ")
		.trim()
		.toLowerCase();
}

function foldTermText(text: string) {
	let value = "";
	let start = 0;
	const offsets: [number, number][] = [];
	for (const char of text) {
		const end = start + char.length;
		if (/[\p{White_Space}\u2010-\u2015\u2212-]/u.test(char)) {
			if (value.endsWith(" ")) offsets[offsets.length - 1][1] = end;
			else {
				value += " ";
				offsets.push([start, end]);
			}
		} else {
			const lower = char.toLowerCase();
			value += lower;
			for (let i = 0; i < lower.length; i++) offsets.push([start, end]);
		}
		start = end;
	}
	return { value, offsets };
}
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
	const folded = foldTermText(text);
	const spans: {
		start: number;
		end: number;
		source: string;
		target: string;
	}[] = [];
	const asciiLower = (value: string) =>
		value.replace(/[A-Z]/g, (c) => c.toLowerCase());
	for (const [source, target] of parseGlossary(input)) {
		const key = normalizeTermKey(source);
		if (!key) continue;
		const chars = Array.from(source);
		let index = folded.value.indexOf(key);
		while (index >= 0) {
			const start = folded.offsets[index][0];
			const end = folded.offsets[index + key.length - 1][1];
			if (
				(!wordCharacter(chars[0]) ||
					!wordCharacter(Array.from(text.slice(0, start)).at(-1))) &&
				(!wordCharacter(chars.at(-1)) ||
					!wordCharacter(Array.from(text.slice(end))[0]))
			) {
				const actual = text.slice(start, end);
				spans.push({
					start,
					end,
					source: asciiLower(source) === asciiLower(actual) ? source : actual,
					target,
				});
			}
			index = folded.value.indexOf(key, index + 1);
		}
	}
	spans.sort((a, b) => a.start - b.start || b.end - a.end);
	const terms = new Map<string, string>();
	let end = 0;
	for (const span of spans) {
		if (span.start < end) continue;
		terms.set(span.source, span.target);
		end = span.end;
	}
	return terms.size
		? `Required terminology (source → target; apply only to the selected text):\n${JSON.stringify(Object.fromEntries([...terms].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))}`
		: "";
}
