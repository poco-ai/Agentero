/**
 * Markdown → Plate deserialize prep.
 *
 * 1. Preserve extra blank lines that CommonMark would otherwise collapse.
 * 2. Prevent an unclosed block-math fence from consuming the rest of a document.
 * 3. Escape a `<` that MDX would treat as a tag, except the HTML the editor
 *    actually supports. `remarkMdx` tokenizes every `<name>`, and Plate's
 *    recovery then drops the rest of the document (#533 and the same failure
 *    on placeholder tags such as `<input>` / `<Constraints>`).
 */

const BLOCK_MATH_FENCE = /^ {0,3}\$\$[ \t]*\r?$/;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** Matches Plate's empty-paragraph serialize placeholder. */
const BLANK_PARAGRAPH_PLACEHOLDER = "\u200B";

/**
 * `remark` / CommonMark collapse 2+ blank lines between blocks into one break.
 * Plate keeps extra empty paragraphs on disk as ZWSP-only lines; rewrite raw
 * extra blanks into that shape before deserialize so external edits and
 * Agent writes round-trip with the same spacing.
 *
 * Skips fenced code and `$$` math blocks. Already-placeholder lines are left
 * alone so Agentero-saved files are not double-wrapped.
 */
export function preserveExtraBlankLines(source: string): string {
	const lines = source.split("\n");
	const out: string[] = [];
	let codeFence: { character: string; length: number } | null = null;
	let inMath = false;
	let i = 0;

	while (i < lines.length) {
		const line = lines[i] ?? "";
		const codeMatch = line.match(CODE_FENCE);

		if (!inMath && codeMatch) {
			const marker = codeMatch[1];
			if (!codeFence) {
				codeFence = { character: marker[0], length: marker.length };
			} else if (
				marker[0] === codeFence.character &&
				marker.length >= codeFence.length
			) {
				codeFence = null;
			}
			out.push(line);
			i += 1;
			continue;
		}

		if (!codeFence && BLOCK_MATH_FENCE.test(line)) {
			inMath = !inMath;
			out.push(line);
			i += 1;
			continue;
		}

		if (codeFence || inMath || !isCollapsibleBlankLine(line)) {
			out.push(line);
			i += 1;
			continue;
		}

		let j = i;
		while (j < lines.length && isCollapsibleBlankLine(lines[j] ?? "")) {
			j += 1;
		}
		const blankCount = j - i;
		if (blankCount <= 1) {
			for (let k = i; k < j; k += 1) out.push(lines[k] ?? "");
		} else {
			// One blank separates blocks; each extra blank → empty paragraph.
			out.push("");
			for (let extra = 0; extra < blankCount - 1; extra += 1) {
				out.push(BLANK_PARAGRAPH_PLACEHOLDER);
				out.push("");
			}
		}
		i = j;
	}

	return out.join("\n");
}

/** Empty / whitespace-only; ZWSP placeholders count as content. */
function isCollapsibleBlankLine(line: string): boolean {
	return line.replace(/\r$/, "").trim() === "";
}

/**
 * `remark-math` treats a standalone `$$` as a block fence. When its closing
 * fence is missing, the parser legitimately puts all following Markdown into
 * the equation node, which makes unrelated content appear broken in Plate.
 */
function escapeUnclosedBlockMath(source: string): string {
	const fences: number[] = [];
	let codeFence: { character: string; length: number } | null = null;
	let offset = 0;

	for (const line of source.split("\n")) {
		const codeMatch = line.match(CODE_FENCE);
		if (codeMatch) {
			const marker = codeMatch[1];
			if (!codeFence) {
				codeFence = { character: marker[0], length: marker.length };
			} else if (
				marker[0] === codeFence.character &&
				marker.length >= codeFence.length
			) {
				codeFence = null;
			}
		} else if (!codeFence && BLOCK_MATH_FENCE.test(line)) {
			fences.push(offset + line.search(/\$\$/));
		}
		offset += line.length + 1;
	}

	if (fences.length % 2 === 0) return source;

	const dollarOffset = fences.at(-1);
	if (dollarOffset === undefined) return source;
	return `${source.slice(0, dollarOffset)}\\${source.slice(dollarOffset)}`;
}

export function prepareMarkdownForDeserialize(source: string): string {
	// Cheap applicability guards so a document that cannot contain the pattern
	// skips the full line scan entirely (the common plain-note case).
	let out = source;
	if (COLLAPSIBLE_BLANK_SEQUENCE.test(out)) {
		out = preserveExtraBlankLines(out);
	}
	if (out.includes("$$")) {
		out = escapeUnclosedBlockMath(out);
	}
	// After the block-math pass so an already-repaired `\$` fence cannot
	// desync the math tracking below.
	out = escapeStrayLessThan(out);
	return escapeStrayMdxBraces(out);
}

/** Two blank-ish lines in a row: the only shape `preserveExtraBlankLines` rewrites. */
const COLLAPSIBLE_BLANK_SEQUENCE = /\n[ \t\r]*\n/;

/** `{` / `}` outside code and math, i.e. MDX expression-looking text. */
const MDX_BRACE = /[{}]/;

/**
 * Escape `{` / `}` that `remarkMdx` would parse as a JS expression.
 *
 * LaTeX conventions in prose (`\(...\{x\}...\)`, `\max\{a,b\}`) make acorn
 * throw on the first `{`. Plate then falls back to `splitIncompleteMdx`, which
 * mistakes inline math such as `$\rho<1$` for an unclosed JSX tag and drops
 * every following block — silent truncation of most of the note. Entities keep
 * the braces literal (remark decodes them back) while MDX never sees them.
 *
 * The backslash of a LaTeX `\{` / `\}` is dropped: otherwise markdown escapes
 * the `&` and the entity would show up verbatim. Code fences, `$$` math,
 * inline code and inline math are left untouched.
 */
export function escapeStrayMdxBraces(source: string): string {
	if (!MDX_BRACE.test(source)) return source;
	const mask = buildLiteralMask(source);
	// Quoted table attributes are directive syntax rather than prose MDX.
	for (const match of source.matchAll(
		/^ {0,3}::research-table\{path=(?:"[^"\r\n]*"|'[^'\r\n]*')\}[ \t]*\r?$/gm,
	)) {
		mask.fill(1, match.index, match.index + match[0].length);
	}
	let out = "";
	let last = 0;
	for (let i = 0; i < source.length; i += 1) {
		const char = source[i];
		if ((char !== "{" && char !== "}") || mask[i]) continue;
		const start = isEscaped(source, i) ? i - 1 : i;
		out += source.slice(last, start);
		out += char === "{" ? "&#123;" : "&#125;";
		last = i + 1;
	}
	return last === 0 ? source : out + source.slice(last);
}

/** Characters allowed to start a JSX name (`remarkMdx` tag). */
const JSX_NAME_START = /[\p{ID_Start}$_]/u;
/** Continuation of a JSX / HTML tag name. */
const TAG_NAME_CONTINUE = /[\p{ID_Continue}$_\-.:]/u;
/** A `<` before whitespace is plain text, not a tag. */
const MARKDOWN_SPACE = /[ \t\n\v\f\r]/;
/** Inline regions where `<` is already literal: math spans and code spans. */
const INLINE_LITERAL = /\$\$[^$\n]*\$\$|\$(?:\\\$|[^$\n])+\$|`+[^`\n]*?`+/g;

/**
 * Tags the editor actually keeps. Anything else is prose (`<Constraints>`,
 * `<id>`, `<AI Paper Analyst>`) and must not reach `remarkMdx`.
 *
 * `div` / `center` / `iframe` / `<p align>` are raw HTML blocks. `p` without
 * `align` unwraps to a paragraph. `br` is a hard break. The inline names are
 * Plate marks. `callout` is the MDX form of an attribute-bearing callout.
 */
const SUPPORTED_TAGS = new Set([
	"div",
	"center",
	"iframe",
	"p",
	"br",
	"u",
	"sub",
	"sup",
	"mark",
	"kbd",
	"callout",
]);

/** Opening these (when `p` has `align`) preserves the inner source slice. */
const RAW_BLOCK_TAGS = new Set(["div", "center", "iframe"]);

/**
 * Void elements Plate's `htmlToJsx` rewrites in place. Inside a raw HTML
 * block they are part of the preserved slice, so an unclosed `<img>` must
 * not be escaped into `&lt;img>`.
 */
const VOID_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

type TagHit = {
	name: string;
	kind: "open" | "close";
	/** Void or `/>`. No matching close is required. */
	selfClosing: boolean;
	/** Balanced open keeps its inner markup verbatim. */
	raw: boolean;
	/** Index of `<`. */
	pos: number;
	/** Index just after the closing `>`. */
	end: number;
};

type RawRange = {
	name: string;
	start: number;
	end: number;
	contentStart: number;
	contentEnd: number;
};

/**
 * Rewrite `<` that `remarkMdx` would treat as JSX, except supported tags.
 *
 * Plate only enters `splitIncompleteMdx` after the MDX parse throws. That
 * recovery cuts at the first `<name` in the raw string — including inside
 * code — and then keeps a single inline block of the tail. Escaping to
 * `&lt;` avoids the throw: the tokenizer cannot see a tag, and remark
 * decodes the entity back to a visible `<`.
 *
 * Skips code fences, block math, inline code, and inline math. Balanced
 * raw HTML (`<div>…</div>` and the other preserved blocks) is left intact,
 * including nested tags such as `<img>` / `<b>`, because that slice is
 * saved verbatim. An unclosed tag inside that slice is still escaped; it
 * would throw and take the rest of the note with it.
 */
export function escapeStrayLessThan(source: string): string {
	if (!source.includes("<")) return source;
	const mask = buildLiteralMask(source);
	const { ranges: rawRanges, unclosed } = findBalancedRawRanges(source, mask);
	const escapeAt = new Set<number>(unclosed);
	collectProseEscapes(source, mask, rawRanges, escapeAt);
	for (const range of rawRanges) {
		collectUnclosedInsideRaw(source, mask, rawRanges, range, escapeAt);
	}
	return applyEscapes(source, escapeAt);
}

function buildLiteralMask(source: string): Uint8Array {
	const mask = new Uint8Array(source.length);
	const lines = source.split("\n");
	let offset = 0;
	let codeFence: { character: string; length: number } | null = null;
	let inMath = false;

	for (const line of lines) {
		const lineEnd = offset + line.length;
		const codeMatch = !inMath ? line.match(CODE_FENCE) : null;
		if (codeMatch) {
			const marker = codeMatch[1];
			if (!codeFence) {
				codeFence = { character: marker[0], length: marker.length };
			} else if (
				marker[0] === codeFence.character &&
				marker.length >= codeFence.length
			) {
				codeFence = null;
			}
			mask.fill(1, offset, lineEnd);
		} else if (!codeFence && BLOCK_MATH_FENCE.test(line)) {
			inMath = !inMath;
			mask.fill(1, offset, lineEnd);
		} else if (codeFence || inMath) {
			mask.fill(1, offset, lineEnd);
		} else {
			for (const match of line.matchAll(INLINE_LITERAL)) {
				const start = match.index ?? 0;
				mask.fill(1, offset + start, offset + start + match[0].length);
			}
		}
		offset = lineEnd + 1;
	}
	return mask;
}

function findBalancedRawRanges(
	source: string,
	mask: Uint8Array,
): { ranges: RawRange[]; unclosed: number[] } {
	const ranges: RawRange[] = [];
	const stack: RawRange[] = [];
	for (let i = 0; i < source.length; i += 1) {
		const tag = readTagAt(source, i, mask);
		if (!tag) continue;
		i = tag.end - 1;
		if (tag.kind === "open") {
			if (tag.raw && !tag.selfClosing) {
				stack.push({
					name: tag.name,
					start: tag.pos,
					end: tag.end,
					contentStart: tag.end,
					contentEnd: tag.end,
				});
			}
			continue;
		}
		const idx = findLastName(stack, tag.name);
		if (idx < 0) continue;
		const frame = stack[idx];
		if (!frame) continue;
		frame.end = tag.end;
		frame.contentEnd = tag.pos;
		ranges.push(frame);
		stack.splice(idx);
	}
	return { ranges, unclosed: stack.map((frame) => frame.start) };
}

function collectProseEscapes(
	source: string,
	mask: Uint8Array,
	rawRanges: RawRange[],
	escapeAt: Set<number>,
): void {
	const stack: { name: string; pos: number }[] = [];
	for (let i = 0; i < source.length; i += 1) {
		if (source[i] !== "<" || mask[i] || isEscaped(source, i)) continue;
		if (insideRaw(i, rawRanges)) continue;
		if (source.startsWith("<!--", i)) {
			const end = source.indexOf("-->", i + 4);
			if (end < 0) escapeAt.add(i);
			else i = end + 2;
			continue;
		}
		const tag = readTagAt(source, i, mask);
		if (!tag) {
			if (!isTextualLessThan(source, i)) escapeAt.add(i);
			continue;
		}
		i = tag.end - 1;
		if (!SUPPORTED_TAGS.has(tag.name)) {
			escapeAt.add(tag.pos);
			continue;
		}
		if (tag.kind === "close") {
			const idx = findLastName(stack, tag.name);
			if (idx < 0) escapeAt.add(tag.pos);
			else stack.splice(idx, 1);
			continue;
		}
		if (!tag.selfClosing && !tag.raw)
			stack.push({ name: tag.name, pos: tag.pos });
	}
	for (const frame of stack) escapeAt.add(frame.pos);
}

/** Unclosed tags inside a preserved HTML slice still crash MDX. */
function collectUnclosedInsideRaw(
	source: string,
	mask: Uint8Array,
	rawRanges: RawRange[],
	range: RawRange,
	escapeAt: Set<number>,
): void {
	const stack: { name: string; pos: number }[] = [];
	for (let i = range.contentStart; i < range.contentEnd; i += 1) {
		if (source[i] !== "<" || mask[i] || isEscaped(source, i)) continue;
		if (insideNestedRaw(i, range, rawRanges)) continue;
		if (source.startsWith("<!--", i)) {
			const end = source.indexOf("-->", i + 4);
			if (end < 0 || end + 3 > range.contentEnd) escapeAt.add(i);
			else i = end + 2;
			continue;
		}
		const tag = readTagAt(source, i, mask);
		if (!tag || tag.end > range.contentEnd) {
			if (!isTextualLessThan(source, i)) escapeAt.add(i);
			continue;
		}
		i = tag.end - 1;
		if (tag.kind === "close") {
			const idx = findLastName(stack, tag.name);
			if (idx < 0) escapeAt.add(tag.pos);
			else stack.splice(idx, 1);
			continue;
		}
		if (!tag.selfClosing) stack.push({ name: tag.name, pos: tag.pos });
	}
	for (const frame of stack) escapeAt.add(frame.pos);
}

function insideRaw(index: number, ranges: RawRange[]): boolean {
	return ranges.some((range) => index >= range.start && index < range.end);
}

function insideNestedRaw(
	index: number,
	parent: RawRange,
	ranges: RawRange[],
): boolean {
	return ranges.some(
		(range) =>
			range !== parent &&
			range.start > parent.start &&
			index >= range.start &&
			index < range.end,
	);
}

function readTagAt(
	source: string,
	i: number,
	mask: Uint8Array,
): (TagHit & { name: string }) | null {
	if (source[i] !== "<" || mask[i] || isEscaped(source, i)) return null;
	let j = i + 1;
	if (j >= source.length || mask[j]) return null;
	let kind: TagHit["kind"] = "open";
	if (source[j] === "/") {
		kind = "close";
		j += 1;
	}
	if (j >= source.length || source[j] === ">" || mask[j]) return null;
	const first = source[j];
	if (first === undefined || !JSX_NAME_START.test(first)) return null;
	j += 1;
	while (
		j < source.length &&
		!mask[j] &&
		TAG_NAME_CONTINUE.test(source[j] ?? "")
	) {
		j += 1;
	}
	const name = source.slice(i + (kind === "close" ? 2 : 1), j).toLowerCase();
	const attrStart = j;
	let quote: '"' | "'" | null = null;
	for (; j < source.length; j += 1) {
		if (mask[j]) return null;
		const ch = source[j];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === ">") {
			const selfClosing = source[j - 1] === "/";
			const attrs = source.slice(attrStart, selfClosing ? j - 1 : j);
			return {
				name,
				kind,
				selfClosing: selfClosing || VOID_TAGS.has(name),
				raw: kind === "open" && isRawBlock(name, attrs),
				pos: i,
				end: j + 1,
			};
		}
	}
	return null;
}

function isRawBlock(name: string, attrs: string): boolean {
	if (RAW_BLOCK_TAGS.has(name)) return true;
	return name === "p" && /\balign\s*=/i.test(attrs);
}

/** `<` followed by whitespace is already legal MDX text (`a < b`). */
function isTextualLessThan(source: string, i: number): boolean {
	const next = source[i + 1];
	return next !== undefined && MARKDOWN_SPACE.test(next);
}

function applyEscapes(source: string, escapeAt: Set<number>): string {
	if (escapeAt.size === 0) return source;
	const positions = [...escapeAt].sort((a, b) => a - b);
	let out = "";
	let last = 0;
	for (const pos of positions) {
		out += source.slice(last, pos);
		out += "&lt;";
		last = pos + 1;
	}
	return out + source.slice(last);
}

function findLastName(
	stack: readonly { name: string }[],
	name: string,
): number {
	for (let i = stack.length - 1; i >= 0; i -= 1) {
		if (stack[i]?.name === name) return i;
	}
	return -1;
}

/** True when the character at `i` is preceded by an odd number of `\`. */
function isEscaped(text: string, i: number): boolean {
	let backslashes = 0;
	for (let j = i - 1; j >= 0 && text[j] === "\\"; j -= 1) backslashes += 1;
	return backslashes % 2 === 1;
}
