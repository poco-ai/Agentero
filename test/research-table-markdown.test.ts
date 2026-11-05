import { MarkdownPlugin } from "@platejs/markdown";
import { createSlateEditor, createSlatePlugin } from "platejs";
import remarkDirective from "remark-directive";
import { expect, it } from "vitest";
import { deserializeMarkdownBody } from "../src/lib/markdown/deserialize-md";
import {
	RESEARCH_TABLE_KEY,
	remarkResearchTable,
	researchTableRules,
	safeTableReference,
} from "../src/lib/research-table/markdown";

it("round trips a table reference through actual Plate Markdown serialization", () => {
	const source = '::research-table{path="data/循环结果.table.json"}';
	const editor = createSlateEditor({
		plugins: [
			createSlatePlugin({ key: "p", node: { isElement: true } }),
			createSlatePlugin({
				key: RESEARCH_TABLE_KEY,
				node: { isElement: true, isVoid: true },
			}),
			MarkdownPlugin.configure({
				options: {
					remarkPlugins: [remarkDirective, remarkResearchTable],
					rules: researchTableRules,
				},
			}),
		],
	});
	const value = deserializeMarkdownBody(editor, source);
	expect(value[0]).toMatchObject({
		type: RESEARCH_TABLE_KEY,
		tablePath: "data/循环结果.table.json",
	});
	const serialized = editor
		.getApi(MarkdownPlugin)
		.markdown.serialize({ value });
	expect(deserializeMarkdownBody(editor, serialized)).toEqual(value);
});

it("rejects references outside ordinary Vault data paths", () => {
	for (const path of [
		"../data/a.table.json",
		"/data/a.table.json",
		"C:/a.table.json",
		".agentero/a.table.json",
		"data/../a.table.json",
		"data/a.table.json\u0000",
		"data\\a.table.json",
	])
		expect(safeTableReference(path)).toBe(false);
	expect(safeTableReference("data/批次 A.table.json")).toBe(true);
});
