/**
 * Readable text for an outline title. Formatting commands unwrap, accents
 * become characters, and every other command stays so icon macros in a
 * heading are not eaten.
 */

const FORMATTING = new Set([
	"emph",
	"textbf",
	"textit",
	"texttt",
	"textrm",
	"textsf",
	"textsc",
	"textsl",
	"textmd",
	"textup",
	"textnormal",
	"textlf",
	"underline",
	"mbox",
	"hbox",
	"bm",
	"boldsymbol",
	"mathbf",
	"mathit",
	"mathrm",
	"mathsf",
	"mathtt",
	"text",
	"lowercase",
	"uppercase",
	"MakeUppercase",
	"MakeLowercase",
	"MakeTextUppercase",
	"MakeTextLowercase",
	"small",
	"footnotesize",
	"scriptsize",
	"tiny",
	"large",
	"Large",
	"LARGE",
	"huge",
	"Huge",
]);

const ACCENT: Record<string, string> = {
	"`": "\u0300",
	"'": "\u0301",
	"^": "\u0302",
	"~": "\u0303",
	"=": "\u0304",
	u: "\u0306",
	".": "\u0307",
	'"': "\u0308",
	r: "\u030a",
	H: "\u030b",
	v: "\u030c",
	d: "\u0323",
	c: "\u0327",
	k: "\u0328",
	b: "\u0331",
};

const LETTER: Record<string, string> = {
	ae: "æ",
	AE: "Æ",
	oe: "œ",
	OE: "Œ",
	aa: "å",
	AA: "Å",
	ss: "ß",
	SS: "SS",
	o: "ø",
	O: "Ø",
	l: "ł",
	L: "Ł",
	dh: "ð",
	DH: "Ð",
	th: "þ",
	TH: "Þ",
	dj: "đ",
	DJ: "Đ",
	ng: "ŋ",
	NG: "Ŋ",
	i: "ı",
	j: "ȷ",
};

function skipSpace(text: string, index: number): number {
	let cursor = index;
	while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
	return cursor;
}

function readGroup(
	text: string,
	open: number,
): { inner: string; end: number } | null {
	if (text[open] !== "{") return null;
	let depth = 0;
	for (let index = open; index < text.length; index += 1) {
		const character = text[index];
		if (character === "\\") {
			index += 1;
			continue;
		}
		if (character === "{") depth += 1;
		else if (character === "}") {
			depth -= 1;
			if (depth === 0)
				return { inner: text.slice(open + 1, index), end: index + 1 };
		}
	}
	return null;
}

function readBrackets(text: string, index: number): number {
	let cursor = skipSpace(text, index);
	while (text[cursor] === "[") {
		const close = text.indexOf("]", cursor);
		if (close < 0) return cursor;
		cursor = skipSpace(text, close + 1);
	}
	return cursor;
}

function commandName(
	text: string,
	index: number,
): { name: string; end: number } | null {
	const character = text[index];
	if (!character) return null;
	if (/[A-Za-z]/.test(character)) {
		let end = index + 1;
		while (end < text.length && /[A-Za-z]/.test(text[end] ?? "")) end += 1;
		return { name: text.slice(index, end), end };
	}
	return { name: character, end: index + 1 };
}

function compose(mark: string, base: string): string {
	const trimmed = base.trim();
	if (!trimmed) return "";
	return `${trimmed[0]}${mark}${trimmed.slice(1)}`;
}

function readPlain(text: string, stop: number): { value: string; end: number } {
	let value = "";
	let index = 0;
	const limit = Math.min(stop, text.length);
	while (index < limit) {
		const character = text[index];
		if (character !== "\\") {
			value += character;
			index += 1;
			continue;
		}
		if (text[index + 1] === "\\") {
			value += "\\\\";
			index += 2;
			continue;
		}
		const command = commandName(text, index + 1);
		if (!command) {
			value += "\\";
			index += 1;
			continue;
		}
		const accent = ACCENT[command.name];
		if (accent) {
			const cursor = skipSpace(text, command.end);
			if (text[cursor] === "{") {
				const group = readGroup(text, cursor);
				if (group) {
					value += compose(
						accent,
						readPlain(group.inner, group.inner.length).value,
					);
					index = group.end;
					continue;
				}
			}
			const base = text[cursor];
			if (base && !/\s/.test(base)) {
				value += compose(accent, base);
				index = cursor + 1;
				continue;
			}
		}
		const letter = LETTER[command.name];
		if (letter && !/[A-Za-z]/.test(text[command.end] ?? "")) {
			value += letter;
			index = command.end;
			continue;
		}
		if (FORMATTING.has(command.name)) {
			const cursor = readBrackets(text, command.end);
			const group = text[cursor] === "{" ? readGroup(text, cursor) : null;
			if (group) {
				value += readPlain(group.inner, group.inner.length).value;
				index = group.end;
				continue;
			}
		}
		value += `\\${command.name}`;
		index = command.end;
	}
	return { value, end: index };
}

/** One display line. Unknown commands are left in place. */
export function plainTexTitle(text: string): string {
	return readPlain(text, text.length)
		.value.replace(/\s+/g, " ")
		.trim()
		.normalize("NFC");
}
