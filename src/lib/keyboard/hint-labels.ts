// F is reserved for entering/leaving hint mode, so it must never be assigned
// to a target label. This keeps the second F press unambiguous.
export const HINT_ALPHABET = "asdghjklqwertyuiopzxcvbnm";

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
