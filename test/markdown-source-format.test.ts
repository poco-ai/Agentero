import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
	type MarkdownSourceFormat,
	sourceFormatKeymap,
	sourceFormatTransaction,
} from "@/lib/markdown/source-format";

function apply(
	doc: string,
	format: MarkdownSourceFormat,
	anchor: number,
	head = anchor,
) {
	const state = EditorState.create({ doc, selection: { anchor, head } });
	const transaction = sourceFormatTransaction(state, format);
	expect(transaction).not.toBeNull();
	const next = state.update(transaction ?? {}).state;
	return {
		doc: next.doc.toString(),
		from: next.selection.main.from,
		to: next.selection.main.to,
	};
}

describe("Markdown source formatting", () => {
	it("wraps and unwraps inline marks", () => {
		expect(apply("hello", "bold", 1, 4)).toEqual({
			doc: "h**ell**o",
			from: 3,
			to: 6,
		});
		expect(apply("h**ell**o", "bold", 3, 6)).toEqual({
			doc: "hello",
			from: 1,
			to: 4,
		});
		expect(apply("hello", "underline", 0, 5).doc).toBe("<u>hello</u>");
	});

	it("inserts an empty mark pair and keeps the caret between", () => {
		expect(apply("", "italic", 0)).toEqual({ doc: "**", from: 1, to: 1 });
	});

	it("nests an italic wrapper around bold instead of eating one star", () => {
		expect(apply("**bold**", "italic", 0, 8).doc).toBe("***bold***");
	});

	it("toggles and retargets heading prefixes on every selected line", () => {
		expect(apply("alpha\nbeta", "heading1", 0, 10).doc).toBe("# alpha\n# beta");
		expect(apply("## title", "heading2", 3).doc).toBe("title");
		expect(apply("# title", "heading2", 2).doc).toBe("## title");
	});

	it("replaces block prefixes while preserving indentation", () => {
		expect(apply("  - item", "heading1", 5).doc).toBe("  # item");
		expect(apply("> quote", "todoList", 2).doc).toBe("- [ ] quote");
		expect(apply("- item", "bulletList", 2).doc).toBe("item");
	});

	it("binds the formatting commands used by the toolbar shortcuts", () => {
		expect(sourceFormatKeymap).toEqual(
			expect.arrayContaining([
				{ key: "Mod-b", format: "bold" },
				{ key: "Mod-i", format: "italic" },
				{ key: "Mod-u", format: "underline" },
			]),
		);
	});
});
