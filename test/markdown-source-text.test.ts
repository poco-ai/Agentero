import { undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { describe, expect, it } from "vitest";
import {
	blockAtSourceLine,
	sourceBlockLines,
} from "@/lib/markdown/source-block-lines";
import { readSourceDocument, sourceDocument } from "@/lib/markdown/source-text";

describe("Markdown source text", () => {
	it("preserves untouched line endings, including mixed breaks, after an edit and undo", () => {
		const raw = "---\r\ntitle: test\n---\r\n\r\n# Body\rLast line";
		const { doc, endings } = sourceDocument(raw);
		let state = EditorState.create({ doc, extensions: [basicSetup, endings] });
		expect(readSourceDocument(state)).toBe(raw);
		const secondBreak = doc.indexOf("\n", doc.indexOf("\n") + 1);
		state = state.update({
			changes: { from: secondBreak, to: secondBreak + 1 },
		}).state;
		expect(readSourceDocument(state)).toBe(raw.replace("test\n", "test"));
		expect(
			undo({
				state,
				dispatch: (tr) => {
					state = tr.state;
				},
			}),
		).toBe(true);
		expect(readSourceDocument(state)).toBe(raw);
		state = state.update({
			changes: { from: state.doc.length, insert: "\n\nnew" },
		}).state;
		expect(readSourceDocument(state)).toBe(`${raw}\r\n\r\nnew`);
	});

	it("anchors raw source blocks past properties, nested lists, a table and an equation", () => {
		const raw = [
			"---",
			"title: Note",
			"---",
			"",
			"# Heading",
			"",
			"- Outer",
			"  - Inner",
			"- Last",
			"",
			"| A | B |",
			"| --- | --- |",
			"| a | b |",
			"",
			"$$",
			"x ^ 2",
			"$$",
			"",
			"```md",
			"# literal",
			"$$",
			"```",
			"",
			"Tail",
		].join("\n");
		const lines = sourceBlockLines(raw);
		expect(lines).toEqual([5, 7, 8, 9, 11, 15, 19, 24]);
		expect(blockAtSourceLine(lines, 2)).toBe(0);
		expect(blockAtSourceLine(lines, 8)).toBe(2);
		expect(blockAtSourceLine(lines, 13)).toBe(4);
		expect(blockAtSourceLine(lines, 17)).toBe(5);
		expect(blockAtSourceLine(lines, 21)).toBe(6);
		expect(blockAtSourceLine(lines, 24)).toBe(7);
	});
	it("keeps headings aligned after reference definitions and adjacent math", () => {
		const raw =
			"Intro\n$$\nx+1\n$$\n\n[foo]: https://example.com\n\n# Target\n\nAfter";
		const lines = sourceBlockLines(raw);
		expect(lines).toEqual([1, 2, 8, 10]);
		expect(blockAtSourceLine(lines, 8)).toBe(2);
	});
});
