/**
 * `==…==` inline highlight scanning shared by the note editor parser and the
 * Streamdown render surfaces.
 *
 * Markdown has no native underline/highlight syntax, but models and external
 * editors write `==文字==` all the time; the editor accepts it on open and
 * saves the canonical `<mark>`. Matching follows markdown-it-mark: the
 * delimiter is exactly two `=` that are not part of a longer run, and the
 * content may not start or end with whitespace. Any non-whitespace character
 * may precede/follow a delimiter, so CJK prose without a space
 * (`前面==高亮==后面`) highlights. This intentionally differs from
 * `@platejs/basic-nodes`' `HighlightRules`, whose input rule only fires after
 * an empty/whitespace character (#1170).
 *
 * Runs are scoped to a single text node/leaf, which covers inline prose. A
 * highlight that spans an emphasis/code node (`==a *b* c==`) is left as literal
 * text; `<mark>` remains the way to mark up mixed inline content.
 */

export type HighlightTextRun = {
	text: string;
	highlight: boolean;
};

const DELIMITER = "==";

function isSpace(character: string | undefined): boolean {
	return character === undefined || /\s/.test(character);
}

/** First valid opening delimiter at or after `from`; -1 when there is none. */
function findOpen(value: string, from: number): number {
	for (let i = from; i + 1 < value.length; i += 1) {
		if (value[i] !== "=" || value[i + 1] !== "=") continue;
		// A third `=` before/after means a longer run, not a highlight fence.
		if (i > 0 && value[i - 1] === "=") continue;
		const content = value[i + 2];
		if (content === "=" || isSpace(content)) continue;
		return i;
	}
	return -1;
}

/** First valid closing delimiter at or after `from`; -1 when there is none. */
function findClose(value: string, from: number): number {
	for (let i = from; i + 1 < value.length; i += 1) {
		if (value[i] === "\n") return -1;
		if (value[i] !== "=" || value[i + 1] !== "=") continue;
		// A `=` on either side means this pair belongs to a longer run, not a
		// highlight fence (`==a===` must stay literal, not close on `===`).
		if (i > 0 && value[i - 1] === "=") continue;
		if (i + 2 < value.length && value[i + 2] === "=") continue;
		if (isSpace(value[i - 1])) continue;
		return i;
	}
	return -1;
}

/**
 * Split plain text into highlight / non-highlight runs. `text` on a highlight
 * run excludes the `==` delimiters. Returns a single plain run when the value
 * contains no highlight; an empty array for empty input.
 */
export function splitHighlightText(value: string): HighlightTextRun[] {
	if (!value) return [];
	if (!value.includes(DELIMITER)) return [{ text: value, highlight: false }];

	const runs: HighlightTextRun[] = [];
	let index = 0;
	while (index < value.length) {
		const open = findOpen(value, index);
		if (open < 0) break;
		const close = findClose(value, open + DELIMITER.length);
		if (close < 0) break;
		if (open > index) {
			runs.push({ text: value.slice(index, open), highlight: false });
		}
		runs.push({
			text: value.slice(open + DELIMITER.length, close),
			highlight: true,
		});
		index = close + DELIMITER.length;
	}
	if (index < value.length) {
		runs.push({ text: value.slice(index), highlight: false });
	}
	return runs;
}
