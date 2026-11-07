/**
 * Character-level caret mapping between a rendered top-level block and its
 * Markdown source slice.
 *
 * The rendered side is projected into plain text with the path of every leaf,
 * the source side into the same plain text with the source offset of every
 * boundary. A mapping is only used when both projections produce identical
 * text, so unsupported constructs fall back to the caller's block anchor
 * instead of placing the caret somewhere arbitrary.
 */

import { ElementApi, KEYS, type TElement, TextApi } from "platejs";

export type BlockTextLeaf = {
	/** Offset in the block's plain text. */
	start: number;
	length: number;
	/** Path relative to the top-level block. */
	path: number[];
};

export type BlockTextMap = {
	text: string;
	leaves: BlockTextLeaf[];
};

export type SourcePosition = {
	/** 0-based line inside the source slice. */
	line: number;
	column: number;
};

export type BlockSourceProjection = {
	text: string;
	/** Source offset for each text boundary; length is `text.length + 1`. */
	offsets: number[];
	positions: SourcePosition[];
	lineStarts: readonly number[];
};

/** Containers whose Markdown children are separated by blank lines. */
const BLOCK_SEPARATORS: Partial<Record<string, string>> = {
	[KEYS.blockquote]: "\n\n",
	[KEYS.footnoteDefinition]: "\n\n",
	[KEYS.codeBlock]: "\n",
};

/**
 * Plain text of a rendered block plus the leaf paths that produced it.
 * Returns null for shapes the projection cannot represent faithfully.
 */
export function readBlockTextMap(block: TElement): BlockTextMap | null {
	const leaves: BlockTextLeaf[] = [];
	let text = "";

	const visit = (node: unknown, path: number[]): void => {
		if (TextApi.isText(node)) {
			leaves.push({ start: text.length, length: node.text.length, path });
			text += node.text;
			return;
		}
		if (!ElementApi.isElement(node)) return;
		const separator = BLOCK_SEPARATORS[node.type as string] ?? "";
		(node.children as unknown[]).forEach((child, index) => {
			if (index > 0) text += separator;
			visit(child, [...path, index]);
		});
	};

	visit(block, []);
	return { text, leaves };
}
function samePath(left: readonly number[], right: readonly number[]): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

/** Plain-text offset of a point inside `block`, or null when it is not a leaf. */
export function blockTextOffsetOfPoint(
	map: BlockTextMap,
	path: readonly number[],
	offset: number,
): number | null {
	for (const leaf of map.leaves) {
		if (!samePath(leaf.path, path)) continue;
		return leaf.start + Math.max(0, Math.min(offset, leaf.length));
	}
	return null;
}

/** Point inside `block` for a plain-text offset. */
export function blockPointAtTextOffset(
	map: BlockTextMap,
	offset: number,
): { path: number[]; offset: number } | null {
	const target = Math.max(0, Math.min(offset, map.text.length));
	for (const leaf of map.leaves) {
		if (target >= leaf.start && target <= leaf.start + leaf.length) {
			return { path: leaf.path, offset: target - leaf.start };
		}
	}
	// The offset falls on a separator between leaves (for example a blank
	// line inside a quote): start the next leaf instead.
	for (const leaf of map.leaves) {
		if (leaf.start >= target) return { path: leaf.path, offset: 0 };
	}
	const last = map.leaves.at(-1);
	return last ? { path: last.path, offset: last.length } : null;
}

class Builder {
	readonly text: string[] = [];
	readonly offsets: number[] = [];
	/** Source end of the last emitted character. */
	private end = 0;
	private hasText = false;

	push(character: string, start: number, end = start + character.length): void {
		this.text.push(character);
		this.offsets.push(start);
		this.end = Math.max(this.end, end);
		this.hasText = true;
	}

	literal(chunk: string, start: number): void {
		for (let index = 0; index < chunk.length; index += 1) {
			this.push(chunk[index], start + index);
		}
	}

	newline(offset: number): void {
		this.push("\n", offset, offset + 1);
	}

	endOffset(emptyStart: number): number {
		return this.hasText ? this.end : emptyStart;
	}
}

function positionAt(
	lineStarts: readonly number[],
	offset: number,
): SourcePosition {
	let low = 0;
	let high = lineStarts.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (lineStarts[mid] <= offset) low = mid + 1;
		else high = mid;
	}
	const line = Math.max(0, low - 1);
	return { line, column: offset - lineStarts[line] };
}

function finish(
	builder: Builder,
	lineStarts: readonly number[],
	emptyStart: number,
): BlockSourceProjection {
	const text = builder.text.join("");
	const offsets = [...builder.offsets, builder.endOffset(emptyStart)];
	const positions = offsets.map((offset) => positionAt(lineStarts, offset));
	return { text, offsets, positions, lineStarts };
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: "\u00A0",
	quot: '"',
};

function decodeEntity(raw: string): string | null {
	if (raw.startsWith("#x") || raw.startsWith("#X")) {
		const value = Number.parseInt(raw.slice(2), 16);
		return Number.isFinite(value) ? String.fromCodePoint(value) : null;
	}
	if (raw.startsWith("#")) {
		const value = Number.parseInt(raw.slice(1), 10);
		return Number.isFinite(value) ? String.fromCodePoint(value) : null;
	}
	return NAMED_ENTITIES[raw] ?? null;
}

/** Strip up to `limit` leading whitespace characters. */
function stripIndent(value: string, limit: number): number {
	let count = 0;
	while (
		count < value.length &&
		count < limit &&
		(value[count] === " " || value[count] === "\t")
	) {
		count += 1;
	}
	return count;
}

/** Consume repeated `> ` quote markers at the start of a line. */
function quotePrefixLength(line: string): number {
	let index = 0;
	for (;;) {
		let cursor = index;
		const spaces = stripIndent(line.slice(cursor), 3);
		cursor += spaces;
		if (line[cursor] !== ">") break;
		cursor += 1;
		if (line[cursor] === " ") cursor += 1;
		index = cursor;
	}
	return index;
}

function findClosingRun(line: string, from: number, marker: string): number {
	let index = from;
	while (index < line.length) {
		if (line[index] === "\\") {
			index += 2;
			continue;
		}
		if (line.startsWith(marker, index)) return index;
		index += 1;
	}
	return -1;
}

function findClosingBracket(line: string, from: number): number {
	let depth = 1;
	for (let index = from; index < line.length; index += 1) {
		const char = line[index];
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === "[") depth += 1;
		else if (char === "]") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function findClosingParen(line: string, from: number): number {
	let depth = 1;
	for (let index = from; index < line.length; index += 1) {
		const char = line[index];
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

/** Skip an inline link destination `(…)`, including a title. */
function linkDestinationEnd(line: string, open: number): number {
	return findClosingParen(line, open + 1);
}

/**
 * Scan one line of Markdown into visible text, recording the source offset of
 * every emitted character. Returns false when the line contains syntax this
 * projection cannot account for.
 */
function scanInline(line: string, base: number, builder: Builder): boolean {
	let index = 0;
	while (index < line.length) {
		const char = line[index];

		if (char === "\\") {
			const next = line[index + 1];
			if (next === undefined) {
				index += 1;
				continue;
			}
			if (next === "\n") {
				builder.newline(base + index);
				index += 2;
				continue;
			}
			builder.push(next, base + index + 1, base + index + 2);
			index += 2;
			continue;
		}

		if (char === "&") {
			const match = /^&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/.exec(
				line.slice(index),
			);
			const decoded = match ? decodeEntity(match[1]) : null;
			if (match && decoded !== null) {
				const end = base + index + match[0].length;
				for (let offset = 0; offset < decoded.length; offset += 1) {
					builder.push(decoded[offset], base + index, end);
				}
				index += match[0].length;
				continue;
			}
			builder.push(char, base + index);
			index += 1;
			continue;
		}

		if (char === "`") {
			let run = 0;
			while (line[index + run] === "`") run += 1;
			const marker = "`".repeat(run);
			const close = line.indexOf(marker, index + run);
			if (close < 0) {
				builder.literal(marker, base + index);
				index += run;
				continue;
			}
			let content = line.slice(index + run, close);
			let contentStart = index + run;
			if (
				content.length > 1 &&
				content.startsWith(" ") &&
				content.endsWith(" ") &&
				content.trim() !== ""
			) {
				content = content.slice(1, -1);
				contentStart += 1;
			}
			builder.literal(content.replace(/\n/g, " "), base + contentStart);
			index = close + run;
			continue;
		}

		if (char === "!" && line.startsWith("![[", index)) {
			const close = line.indexOf("]]", index + 3);
			if (close >= 0) {
				builder.literal(line.slice(index, close + 2), base + index);
				index = close + 2;
				continue;
			}
		}

		if (char === "!" && line[index + 1] === "[") {
			const close = findClosingBracket(line, index + 2);
			if (close >= 0 && line[close + 1] === "(") {
				const end = linkDestinationEnd(line, close + 1);
				if (end >= 0) {
					index = end + 1;
					continue;
				}
			}
			builder.push(char, base + index);
			index += 1;
			continue;
		}

		if (char === "[" && line[index + 1] === "[") {
			const close = line.indexOf("]]", index + 2);
			if (close >= 0) {
				builder.literal(line.slice(index, close + 2), base + index);
				index = close + 2;
				continue;
			}
		}

		if (char === "[" && line[index + 1] === "^") {
			const close = line.indexOf("]", index + 2);
			if (close >= 0) {
				index = close + 1;
				continue;
			}
		}

		if (char === "[") {
			const close = findClosingBracket(line, index + 1);
			if (close >= 0 && line[close + 1] === "(") {
				const end = linkDestinationEnd(line, close + 1);
				if (end >= 0) {
					if (
						!scanInline(line.slice(index + 1, close), base + index + 1, builder)
					)
						return false;
					index = end + 1;
					continue;
				}
			}
			builder.push(char, base + index);
			index += 1;
			continue;
		}

		if (char === "$") {
			const open = line[index + 1];
			if (open !== undefined && !/\s/.test(open)) {
				let close = index + 1;
				while (close < line.length) {
					close = line.indexOf("$", close);
					if (close < 0) break;
					if (line[close - 1] !== "\\" && !/\s/.test(line[close - 1])) break;
					close += 1;
				}
				if (close >= 0 && close < line.length) {
					index = close + 1;
					continue;
				}
			}
			builder.push(char, base + index);
			index += 1;
			continue;
		}

		if (
			char === "*" ||
			char === "_" ||
			(char === "~" && line[index + 1] === "~")
		) {
			let run = 0;
			while (line[index + run] === char) run += 1;
			const marker = char.repeat(run);
			const close = findClosingRun(line, index + run, marker);
			if (close >= 0) {
				if (
					!scanInline(
						line.slice(index + run, close),
						base + index + run,
						builder,
					)
				)
					return false;
				index = close + run;
				continue;
			}
			builder.literal(marker, base + index);
			index += run;
			continue;
		}

		if (char === "<") {
			const match = /^<([^<>\n]+)>/.exec(line.slice(index));
			if (match) {
				const inner = match[1];
				if (
					/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(inner) ||
					/^[^@\s]+@[^@\s]+$/.test(inner)
				) {
					builder.literal(inner, base + index + 1);
					index += match[0].length;
					continue;
				}
			}
		}

		builder.push(char, base + index);
		index += 1;
	}
	return true;
}

function fenceMatch(
	line: string,
): { char: string; length: number; indent: number } | null {
	const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
	if (!match) return null;
	return {
		char: match[2][0],
		length: match[2].length,
		indent: match[1].length,
	};
}

function isClosingFence(
	line: string,
	char: string,
	minLength: number,
): boolean {
	const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
	return Boolean(match && match[1][0] === char && match[1].length >= minLength);
}

/**
 * Project a block's source slice into the rendered plain text.
 * `lines` must already be normalized to `\n` line endings and start at the
 * block's first line.
 */
export function projectBlockSource(
	lines: readonly string[],
): BlockSourceProjection | null {
	const source = lines.map((line) => line.replace(/\r$/, ""));
	while (source.length > 0 && /^[ \t]*$/.test(source[source.length - 1]))
		source.pop();

	const lineStarts: number[] = [];
	let total = 0;
	for (const line of source) {
		lineStarts.push(total);
		total += line.length + 1;
	}

	if (source.length === 0) {
		return {
			text: "",
			offsets: [0],
			positions: [{ line: 0, column: 0 }],
			lineStarts: [0],
		};
	}

	const fence = fenceMatch(source[0]);
	if (fence) {
		let close = -1;
		for (let index = 1; index < source.length; index += 1) {
			if (isClosingFence(source[index], fence.char, fence.length)) {
				close = index;
				break;
			}
		}
		if (close < 0) return null;
		const builder = new Builder();
		for (let index = 1; index < close; index += 1) {
			if (index > 1)
				builder.newline(lineStarts[index - 1] + source[index - 1].length);
			const strip = stripIndent(source[index], fence.indent);
			builder.literal(source[index].slice(strip), lineStarts[index] + strip);
		}
		return finish(builder, lineStarts, lineStarts[0]);
	}

	if (/^ {0,3}\$\$/.test(source[0])) return null;

	const firstQuote = quotePrefixLength(source[0]);
	const firstContent = source[0].slice(firstQuote);
	let firstStart = firstQuote;
	let continuationIndent = 0;
	let footnote = false;

	const heading = /^( {0,3})(#{1,6})(?:[ \t]+|$)/.exec(firstContent);
	if (heading) {
		firstStart = firstQuote + heading[0].length;
	} else {
		const definition = /^( {0,3})\[\^[^\]\n]+\]:[ \t]*/.exec(firstContent);
		if (definition) {
			firstStart = firstQuote + definition[0].length;
			footnote = true;
			continuationIndent = 4;
		} else {
			const list = /^([ \t]{0,8})([-*+]|\d{1,9}[.)])([ \t]+)/.exec(
				firstContent,
			);
			if (list) {
				firstStart = firstQuote + list[0].length;
				const task = /^\[[ xX]\]([ \t]+)/.exec(source[0].slice(firstStart));
				if (task) firstStart += task[0].length;
				continuationIndent = firstStart - firstQuote + 3;
			}
		}
	}

	const builder = new Builder();
	for (let index = 0; index < source.length; index += 1) {
		const line = source[index];
		if (index > 0)
			builder.newline(lineStarts[index - 1] + source[index - 1].length);
		const quote = index === 0 ? firstQuote : quotePrefixLength(line);
		let start = index === 0 ? firstStart : quote;
		if (index > 0) {
			if (footnote) start += stripIndent(line.slice(quote), 4);
			else
				start += stripIndent(
					line.slice(quote),
					Math.max(3, continuationIndent),
				);
		}
		let content = line.slice(start);
		// Trailing spaces before a soft break are not text; a final backslash
		// is a hard break. Both are represented by the newline itself.
		content = content.replace(/[ \t]+$/, "");
		let slashes = 0;
		while (content[content.length - 1 - slashes] === "\\") slashes += 1;
		if (slashes % 2 === 1) content = content.slice(0, -1);
		if (!scanInline(content, lineStarts[index] + start, builder)) return null;
	}

	return finish(builder, lineStarts, lineStarts[0]);
}

/**
 * Text offset for a caret at `line`/`column` inside the projected slice.
 * Carets inside syntax map to the next visible character.
 */
export function sourceCaretToTextOffset(
	projection: BlockSourceProjection,
	line: number,
	column: number,
): number {
	if (line < 0) return 0;
	if (line >= projection.lineStarts.length) return projection.text.length;
	const sourceOffset = projection.lineStarts[line] + Math.max(0, column);
	let low = 0;
	let high = projection.offsets.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (projection.offsets[mid] < sourceOffset) low = mid + 1;
		else high = mid;
	}
	return Math.min(low, projection.text.length);
}

/** Source position of a text boundary. */
export function sourcePositionOfTextOffset(
	projection: BlockSourceProjection,
	offset: number,
): SourcePosition {
	const index = Math.max(0, Math.min(offset, projection.text.length));
	return projection.positions[index];
}
