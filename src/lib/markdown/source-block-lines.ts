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
	for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
		if (node.name === "FencedCode" || node.name === "CodeBlock") continue;
		const first = doc.lineAt(node.from).number;
		const last = doc.lineAt(node.to).number;
		for (let line = first; line <= last; line += 1) {
			if (/^ {0,3}\$\$[ \t]*$/.test(doc.line(line).text))
				equationFences.push(line);
		}
	}
	const equationEnds = new Map<number, number>();
	for (let i = 1; i < equationFences.length; i += 2) {
		equationEnds.set(equationFences[i - 1], equationFences[i]);
	}
	const push = (line: number) => {
		if (lines.at(-1) !== offset + line) lines.push(offset + line);
	};
	for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
		const start = doc.lineAt(node.from).number;
		const end = doc.lineAt(node.to).number;
		if (start <= mathUntil) continue;
		// Plate preserves each extra blank paragraph beyond the ordinary separator.
		for (let line = lastEnd + 2; line < start; line += 1) push(line);
		mathUntil = equationEnds.get(start) ?? 0;
		lastEnd = Math.max(end, mathUntil);
		if (node.name !== "BulletList" && node.name !== "OrderedList") {
			push(start);
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
