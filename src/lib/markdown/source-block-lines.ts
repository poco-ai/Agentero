import { markdownLanguage } from "@codemirror/lang-markdown";
import { Text } from "@codemirror/state";
import { frontmatterLineOffset } from "@/lib/markdown/selection-source-lines";
import { splitFrontmatter } from "./frontmatter";

/**
 * Best-effort anchors for the projection. GFM lists become one Plate block
 * per item, whereas tables, quotes, fenced code and equations are whole blocks.
 * Positions are in the original source, including blank lines and properties.
 */
export function sourceBlockLines(markdown: string): number[] {
	const normalized = markdown.replace(/\r\n?/g, "\n");
	const { frontmatter, body } = splitFrontmatter(normalized);
	const offset = frontmatterLineOffset(frontmatter);
	const doc = Text.of(body.split("\n"));
	const tree = markdownLanguage.parser.parse(body);
	const lines: number[] = [];
	let lastEnd = 0;
	let mathUntil = 0;
	const equationFences: number[] = [];
	if (body.includes("$$")) {
		for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
			if (node.name !== "Paragraph") continue;
			const first = doc.lineAt(node.from).number;
			const last = doc.lineAt(node.to).number;
			for (let line = first; line <= last; line += 1) {
				if (/^ {0,3}\$\$[ \t]*$/.test(doc.line(line).text))
					equationFences.push(line);
			}
		}
	}
	const push = (line: number) => {
		if (lines.at(-1) !== offset + line) lines.push(offset + line);
	};
	let equation = 0;
	for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
		const start = doc.lineAt(node.from).number;
		const end = doc.lineAt(node.to).number;
		let first = Math.max(start, mathUntil + 1);
		if (first > end) continue;
		// Plate preserves each extra blank paragraph beyond the ordinary separator.
		for (let line = lastEnd + 2; line < first; line += 1) push(line);
		lastEnd = Math.max(lastEnd, end);

		// A standalone math fence may interrupt a paragraph in remark even
		// though CommonMark's tree includes both in one Paragraph.
		while (
			equation + 1 < equationFences.length &&
			equationFences[equation] <= end
		) {
			const opening = equationFences[equation];
			if (first < opening) push(first);
			push(opening);
			mathUntil = equationFences[equation + 1];
			lastEnd = Math.max(lastEnd, mathUntil);
			first = mathUntil + 1;
			equation += 2;
		}
		if (first > end) continue;

		if (
			node.name === "LinkReference" &&
			!doc.line(first).text.trimStart().startsWith("[^")
		) {
			// Definitions participate in parsing, but Plate has no display block.
			continue;
		}
		if (node.name !== "BulletList" && node.name !== "OrderedList") {
			push(first);
			continue;
		}
		node.cursor().iterate((child) => {
			if (child.name === "ListItem") push(doc.lineAt(child.from).number);
		});
	}
	return lines.length ? lines : [Math.min(offset + 1, doc.lines + offset)];
}

/** Whitespace between blocks maps to the block immediately above it. */
export function blockAtSourceLine(
	lines: readonly number[],
	line: number,
): number {
	let low = 0;
	let high = lines.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (lines[mid] <= line) low = mid + 1;
		else high = mid;
	}
	return Math.max(0, low - 1);
}
