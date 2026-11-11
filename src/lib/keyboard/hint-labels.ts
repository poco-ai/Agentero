// F is reserved for entering/leaving hint mode, so it must never be assigned
// to a target label. This keeps the second F press unambiguous.
export const HINT_ALPHABET = "asdghjklqwertyuiopzxcvbnm";

/**
 * Keys that are only held to type a label character. Their own keydown (for
 * example the Shift event that precedes Shift+A) must never cancel a session,
 * otherwise users who type the badge in the case it is displayed close hint
 * mode before the letter lands.
 */
export const HINT_MODIFIER_KEYS: ReadonlySet<string> = new Set([
	"Shift",
	"Control",
	"Alt",
	"AltGraph",
	"Meta",
	"OS",
	"Super",
	"Hyper",
	"CapsLock",
	"Fn",
	"FnLock",
	"Symbol",
	"SymbolLock",
	"Dead",
	"Unidentified",
]);

/**
 * Resolve the label character a keydown represents. Matching is
 * case-insensitive; layouts that compose the letter (Shift / Option, non-Latin
 * keyboards, IME `Process` events) fall back to the physical `KeyA`–`KeyZ`
 * code so hint typing keeps working.
 */
export function hintKeyFromEvent(event: {
	key: string;
	code?: string;
}): string | null {
	if (event.key.length === 1) {
		const key = event.key.toLowerCase();
		if (key >= "a" && key <= "z") return key;
	}
	const physical = /^Key([A-Z])$/.exec(event.code ?? "");
	return physical ? physical[1].toLowerCase() : null;
}

/** Generate stable, prefix-friendly labels for a hint session. */
export function assignHintLabels(
	count: number,
	alphabet = HINT_ALPHABET,
): string[] {
	if (count <= 0 || !alphabet) return [];
	const labels: string[] = [];
	if (count <= alphabet.length) return alphabet.slice(0, count).split("");
	// A session uses one width, so A can never shadow AA.
	for (const first of alphabet) {
		for (const second of alphabet) {
			if (labels.length >= count) return labels;
			labels.push(first + second);
		}
	}
	return labels;
}

export type HintLabelMatch =
	| { kind: "none" }
	| { kind: "partial"; remaining: number }
	| { kind: "unique"; index: number };

export function matchHintLabel(
	query: string,
	labels: readonly string[],
): HintLabelMatch {
	const normalized = query.toLowerCase();
	const matches = labels
		.map((label, index) => ({ label, index }))
		.filter(({ label }) => label.startsWith(normalized));
	if (matches.length === 0) return { kind: "none" };
	if (matches.length === 1 && matches[0].label === normalized) {
		return { kind: "unique", index: matches[0].index };
	}
	return { kind: "partial", remaining: matches.length };
}
