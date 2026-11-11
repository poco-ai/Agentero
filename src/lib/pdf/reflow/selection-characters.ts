import type { Character, Paragraph } from "./types";

/** A protected formula retains its exact PDF character indexes and ink box.
 * Older caches can contain replacement characters from separately serialized
 * UTF-16 halves. Recover only that known island, without guessing prose text. */
export function paragraphSelectionCharacters(
	paragraph: Paragraph,
): readonly Character[] {
	const owners = new Map<number, (typeof paragraph.formulas)[number]>();
	const byIndex = new Map(paragraph.characters.map((c) => [c.index, c]));
	for (const formula of paragraph.formulas) {
		const own = formula.characterIndexes.flatMap((index) => {
			const c = byIndex.get(index);
			return c ? [c] : [];
		});
		if (
			!formula.text ||
			formula.text.includes("�") ||
			!own.some((c) => /[\uFFFD\uD800-\uDFFF]/u.test(c.text))
		)
			continue;
		for (const c of own) owners.set(c.index, formula);
	}
	if (!owners.size) return paragraph.characters;
	const used = new Set<string>();
	return paragraph.characters.flatMap((character) => {
		const formula = owners.get(character.index);
		if (!formula) return [character];
		if (used.has(formula.id)) return [];
		used.add(formula.id);
		return [
			{
				...character,
				text: formula.text,
				box: formula.box,
				visualBox: formula.box,
			},
		];
	});
}
