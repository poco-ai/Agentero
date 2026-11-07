import {
	BaseBlockquotePlugin,
	BaseBoldPlugin,
	BaseCodePlugin,
	BaseH1Plugin,
	BaseHighlightPlugin,
	BaseItalicPlugin,
	BaseStrikethroughPlugin,
	BaseSubscriptPlugin,
	BaseSuperscriptPlugin,
} from "@platejs/basic-nodes";
import { BaseCodeBlockPlugin, BaseCodeLinePlugin } from "@platejs/code-block";
import { BaseListPlugin } from "@platejs/list";
import { MarkdownPlugin } from "@platejs/markdown";
import { createSlateEditor, createSlatePlugin, KEYS } from "platejs";
import { describe, expect, it } from "vitest";

import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import {
	blockPointAtTextOffset,
	blockTextOffsetOfPoint,
	projectBlockSource,
	readBlockTextMap,
	sourceCaretToTextOffset,
	sourcePositionOfTextOffset,
} from "@/lib/markdown/block-caret-map";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";
import { bodyStartLineOfBlock } from "@/lib/markdown/selection-source-lines";

const plugins = [
	createSlatePlugin({ key: KEYS.p, node: { isElement: true } }),
	BaseH1Plugin,
	BaseBlockquotePlugin,
	BaseBoldPlugin,
	BaseItalicPlugin,
	BaseStrikethroughPlugin,
	BaseSubscriptPlugin,
	BaseSuperscriptPlugin,
	BaseHighlightPlugin,
	BaseCodePlugin,
	BaseListPlugin,
	BaseCodeBlockPlugin,
	BaseCodeLinePlugin,
	...MarkdownKit,
];

const samples = [
	"# Heading **bold** and _italic_",
	"Paragraph with **bold**, _it_, `code`, ~~strike~~, [link](https://x.com), [[Note|alias]] and H\\_2O.",
	"> Quote line one\n> continues **here**\n>\n> Second para",
	"- item one\n- item two with `code`\n  - nested item",
	"1. first\n2. second",
	"```ts\nconst x = 1;\n\nconst y = 2;\n```",
	"Term with footnote[^note].\n\n[^note]: Footnote text",
	"Term[^n].\n\n[^n]: first\n    second\n\n    third",
	"Sub ~x~ and super ^y^ and ==hi==.",
	"Escaped \\* star and \\_underscore\\_ and {brace} \\<tag\\>.",
	"a\n  b",
	"Trailing space entity&#x20;",
];

type Slice = {
	start: number;
	lines: string[];
};

function blockSlices(editor: ReturnType<typeof createSlateEditor>): Slice[] {
	const raw = editor.getApi(MarkdownPlugin).markdown.serialize();
	const lines = raw.replace(/\r\n?/g, "\n").split("\n");
	const starts = editor.children.map(
		(_, index) => bodyStartLineOfBlock(editor, index) ?? 1,
	);
	return starts.map((start, index) => ({
		start,
		lines: lines.slice(start - 1, (starts[index + 1] ?? lines.length + 1) - 1),
	}));
}

describe("block caret map", () => {
	it.each(samples)("maps every caret in %j", (markdown) => {
		const editor = createSlateEditor({ plugins });
		const value = deserializeMarkdownBody(editor, markdown || " ");
		const parsed = createSlateEditor({ plugins, value });
		const slices = blockSlices(parsed);
		expect(parsed.children).toHaveLength(slices.length);

		parsed.children.forEach((block, index) => {
			const plate = readBlockTextMap(block);
			const projection = projectBlockSource(slices[index].lines);
			expect(plate).not.toBeNull();
			expect(projection).not.toBeNull();
			if (!plate || !projection) return;
			expect(projection.text).toBe(plate.text);

			for (let offset = 0; offset <= plate.text.length; offset += 1) {
				const position = sourcePositionOfTextOffset(projection, offset);
				expect(
					sourceCaretToTextOffset(projection, position.line, position.column),
				).toBe(offset);
			}

			for (const leaf of plate.leaves) {
				for (let offset = 0; offset <= leaf.length; offset += 1) {
					const point = blockPointAtTextOffset(plate, leaf.start + offset);
					expect(point).not.toBeNull();
					if (!point) continue;
					expect(blockTextOffsetOfPoint(plate, point.path, point.offset)).toBe(
						leaf.start + offset,
					);
				}
			}
		});
	});

	it("leaves tables to the block fallback", () => {
		const markdown = "| A | B |\n| - | - |\n| 1 | 2 |";
		const editor = createSlateEditor({ plugins });
		const value = deserializeMarkdownBody(editor, markdown);
		const parsed = createSlateEditor({ plugins, value });
		const plate = readBlockTextMap(parsed.children[0]);
		const projection = projectBlockSource(markdown.split("\n"));
		expect(plate?.text).toBe("AB12");
		expect(projection?.text).not.toBe(plate?.text);
	});
});
