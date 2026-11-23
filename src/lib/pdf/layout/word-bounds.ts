/**
 * Word under a caret in translated overlay text.
 *
 * `offset` is a caret position between characters, matching
 * `caretPositionFromPoint`. A caret sitting just after the last glyph of a
 * word still belongs to that word. Chinese, Japanese, and Korean use the `zh`
 * word segmenter; other text uses `en`.
 */

const CJK = /[\u3400-\u9fff\uF900-\uFAFF\u3040-\u30ff\uac00-\ud7af]/;

export type TextSpan = { start: number; end: number };

function segmenterLocale(text: string): string {
	return CJK.test(text) ? "zh" : "en";
}

function wordContaining(text: string, index: number): TextSpan | null {
	if (index < 0 || index >= text.length) return null;
	const segmenter = new Intl.Segmenter(segmenterLocale(text), {
		granularity: "word",
	});
	for (const part of segmenter.segment(text)) {
		const start = part.index;
		const end = start + part.segment.length;
		if (index < start) return null;
		if (index >= end) continue;
		if (!part.isWordLike || !part.segment.trim()) return null;
		return { start, end };
	}
	return null;
}

/** Word that contains `offset`, or the word ending at that caret. */
export function wordBoundsAt(text: string, offset: number): TextSpan | null {
	if (text.length === 0) return null;
	const caret = Math.min(Math.max(offset, 0), text.length);
	if (caret < text.length) {
		const direct = wordContaining(text, caret);
		if (direct) return direct;
	}
	if (caret === 0) return null;
	return wordContaining(text, caret - 1);
}

/** DOM range covering `[start, end)` inside `root`, across nested text nodes. */
export function rangeCoveringOffsets(
	root: HTMLElement,
	start: number,
	end: number,
): Range | null {
	if (end <= start) return null;
	const doc = root.ownerDocument;
	const range = doc.createRange();
	const showText = doc.defaultView?.NodeFilter?.SHOW_TEXT ?? 4;
	const walker = doc.createTreeWalker(root, showText);
	let seen = 0;
	let startSet = false;
	let node = walker.nextNode();
	while (node) {
		const length = node.textContent?.length ?? 0;
		const next = seen + length;
		if (!startSet && start < next) {
			range.setStart(node, start - seen);
			startSet = true;
		}
		if (startSet && end <= next) {
			range.setEnd(node, end - seen);
			return range.collapsed ? null : range;
		}
		seen = next;
		node = walker.nextNode();
	}
	return null;
}

function caretHit(
	root: HTMLElement,
	x: number,
	y: number,
): { node: Node; offset: number } | null {
	const doc = root.ownerDocument;
	const position = doc.caretPositionFromPoint?.(x, y);
	if (position && root.contains(position.offsetNode)) {
		return { node: position.offsetNode, offset: position.offset };
	}
	const legacy = (
		doc as Document & {
			caretRangeFromPoint?: (clientX: number, clientY: number) => Range | null;
		}
	).caretRangeFromPoint?.(x, y);
	if (legacy && root.contains(legacy.startContainer)) {
		return { node: legacy.startContainer, offset: legacy.startOffset };
	}
	return null;
}

function textOffsetAtPoint(
	root: HTMLElement,
	x: number,
	y: number,
): number | null {
	const hit = caretHit(root, x, y);
	if (!hit) return null;
	const range = root.ownerDocument.createRange();
	try {
		range.setStart(root, 0);
		range.setEnd(hit.node, hit.offset);
	} catch {
		return null;
	}
	return range.toString().length;
}

/** Word range under a client point, or null when the point is not on a word. */
export function wordRangeAtPoint(
	root: HTMLElement,
	x: number,
	y: number,
): Range | null {
	const offset = textOffsetAtPoint(root, x, y);
	if (offset == null) return null;
	const bounds = wordBoundsAt(root.textContent ?? "", offset);
	if (!bounds) return null;
	return rangeCoveringOffsets(root, bounds.start, bounds.end);
}
