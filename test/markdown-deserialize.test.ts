import { MarkdownPlugin } from "@platejs/markdown";
import { createSlateEditor, createSlatePlugin, KEYS, NodeApi } from "platejs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import {
	escapeStrayLessThan,
	escapeStrayMdxBraces,
	prepareMarkdownForDeserialize,
	preserveExtraBlankLines,
} from "@/lib/markdown/deserialize";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";

const ParagraphPlugin = createSlatePlugin({
	key: KEYS.p,
	node: { isElement: true },
});

const ZWSP = "\u200B";

describe("preserveExtraBlankLines", () => {
	it("rewrites extra blanks into Plate empty-paragraph placeholders", () => {
		expect(preserveExtraBlankLines("A\n\n\n\nB\n")).toBe(
			`A\n\n${ZWSP}\n\n${ZWSP}\n\nB\n`,
		);
		expect(preserveExtraBlankLines("A\n\nB\n")).toBe("A\n\nB\n");
	});

	it("does not touch blanks inside fenced code or math", () => {
		const code = "```\nA\n\n\n\nB\n```\n";
		expect(preserveExtraBlankLines(code)).toBe(code);
		const math = "$$\nA\n\n\n\nB\n$$\n";
		expect(preserveExtraBlankLines(math)).toBe(math);
	});

	it("leaves existing ZWSP placeholders alone", () => {
		const already = `A\n\n${ZWSP}\n\n${ZWSP}\n\nB\n`;
		expect(preserveExtraBlankLines(already)).toBe(already);
	});
});

describe("prepareMarkdownForDeserialize", () => {
	it("preserves extra blank paragraphs through Plate deserialize", () => {
		const editor = createSlateEditor({ plugins: MarkdownKit });
		const value = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize(prepareMarkdownForDeserialize("A\n\n\n\nB\n"));
		// remark drops the ZWSP glyph but keeps the empty paragraph nodes.
		const texts = value.map((node) => {
			const child = node.children?.[0] as { text?: string } | undefined;
			return child?.text ?? "";
		});
		expect(texts).toEqual(["A", "", "", "B"]);
		const roundTrip = createSlateEditor({
			plugins: MarkdownKit,
			value,
		})
			.getApi(MarkdownPlugin)
			.markdown.serialize();
		expect(roundTrip).toBe(`A\n\n${ZWSP}\n\n${ZWSP}\n\nB\n`);
	});

	it("escapes an unclosed block-math fence", () => {
		const source = "before\n$$\nbad _ {\n\nafter\n# heading";

		// The repaired `$$` is no longer a math fence, so the stray `{` is prose
		// and gets entity-escaped for MDX (remark decodes it back to `{`).
		expect(prepareMarkdownForDeserialize(source)).toBe(
			"before\n\\$$\nbad _ &#123;\n\nafter\n# heading",
		);
	});

	it("only repairs the unmatched fence", () => {
		const source = "$$\nvalid\n$$\n\n$$\nunclosed";

		expect(prepareMarkdownForDeserialize(source)).toBe(
			"$$\nvalid\n$$\n\n\\$$\nunclosed",
		);
	});

	it("leaves paired fences and inline math unchanged", () => {
		const source = "inline $x$ and\n$$\nE=mc^2\n$$";

		expect(prepareMarkdownForDeserialize(source)).toBe(source);
	});

	it("ignores math-looking lines inside fenced code", () => {
		const source = "```\n$$\nnot math\n```\n\n$$\nunclosed";

		expect(prepareMarkdownForDeserialize(source)).toBe(
			"```\n$$\nnot math\n```\n\n\\$$\nunclosed",
		);
	});

	it("ignores indented code that looks like a math fence", () => {
		const source = "    $$\n    not math";

		expect(prepareMarkdownForDeserialize(source)).toBe(source);
	});

	it("skips the blank/math passes when their syntax is absent", () => {
		// No double newline and no `$$`: both full scans are skipped, output is
		// byte-identical to the input.
		expect(prepareMarkdownForDeserialize("A\nB")).toBe("A\nB");
		expect(prepareMarkdownForDeserialize("A\n \nB")).toBe("A\n \nB");
		expect(prepareMarkdownForDeserialize("plain title")).toBe("plain title");
	});

	it("keeps Markdown after an invalid unclosed equation parseable", () => {
		const editor = createSlateEditor({
			plugins: [ParagraphPlugin, MarkdownPlugin],
			value: [{ type: "p", children: [{ text: "" }] }],
		});
		const source = "before\n$$\nbad _ {\n\nafter\n# heading";
		const value = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize(prepareMarkdownForDeserialize(source));

		expect(value).toMatchObject([
			{ type: "p", children: [{ text: "before\n$$\nbad _ {" }] },
			{ type: "p", children: [{ text: "after" }] },
			{ type: "h1", children: [{ text: "heading" }] },
		]);
	});
});

describe("escapeStrayLessThan", () => {
	it("escapes a `<` that would crash the MDX JSX tokenizer", () => {
		expect(escapeStrayLessThan("网络（<0.5B，NPU）上")).toBe(
			"网络（&lt;0.5B，NPU）上",
		);
		expect(escapeStrayLessThan("p<0.05 <3 a<-1 x<=2")).toBe(
			"p&lt;0.05 &lt;3 a&lt;-1 x&lt;=2",
		);
		expect(escapeStrayLessThan("尾随 <")).toBe("尾随 &lt;");
		expect(escapeStrayLessThan("broken closing </3 tag")).toBe(
			"broken closing &lt;/3 tag",
		);
	});

	it("keeps supported tags, comments and spaced comparisons intact", () => {
		const tags = '<div class="x">a</div> <u>b</u> <br> <!-- note --> a < b';
		expect(escapeStrayLessThan(tags)).toBe(tags);
	});

	it("escapes tags the editor does not support", () => {
		expect(escapeStrayLessThan("<> <!-- note --> </span>")).toBe(
			"&lt;> <!-- note --> &lt;/span>",
		);
		expect(escapeStrayLessThan("follow <Constraints> and <Workflow>.")).toBe(
			"follow &lt;Constraints> and &lt;Workflow>.",
		);
		expect(escapeStrayLessThan("As an <AI Paper Analyst>, go")).toBe(
			"As an &lt;AI Paper Analyst>, go",
		);
		expect(escapeStrayLessThan("\\<Constraints>")).toBe("\\<Constraints>");
	});

	it("leaves placeholder tags inside code and preserves raw html", () => {
		const fenced = "```yaml\n- <Short title>\n```\nuse `<input>.pdf <output>`";
		expect(escapeStrayLessThan(fenced)).toBe(fenced);
		const raw = [
			'<div align="center">',
			'  <img src="assets/logo.png" width="200" />',
			"  <b>Title</b>",
			"</div>",
		].join("\n");
		expect(escapeStrayLessThan(raw)).toBe(raw);
		expect(escapeStrayLessThan('<p align="center"><b>x</b></p>')).toBe(
			'<p align="center"><b>x</b></p>',
		);
		expect(
			escapeStrayLessThan('<callout variant="warning">\n\nBody\n\n</callout>'),
		).toBe('<callout variant="warning">\n\nBody\n\n</callout>');
	});

	it("escapes an unclosed supported tag so the rest of the note survives", () => {
		expect(escapeStrayLessThan("<div>hello\n\nafter")).toBe(
			"&lt;div>hello\n\nafter",
		);
		expect(escapeStrayLessThan("<div>\n<Constraints>\n</div>")).toBe(
			"<div>\n&lt;Constraints>\n</div>",
		);
	});

	it("leaves code fences, block math and inline code/math untouched", () => {
		const source = [
			"```",
			"a<0.5",
			"```",
			"$$",
			"x<0.5",
			"$$",
			"code `<0.5` and math $a<0.5$ stay",
		].join("\n");
		expect(escapeStrayLessThan(source)).toBe(source);
	});

	it("ignores an indented code-looking line only via fences, math still tracked", () => {
		// Fenced code lines are skipped even when they contain `$$`.
		const source = "```\n$$\n```\noutside <0.5";
		expect(escapeStrayLessThan(source)).toBe("```\n$$\n```\noutside &lt;0.5");
	});
});

describe("#533 note truncated at prose `<` comparison", () => {
	const ISSUE_BODY = `## Problem Definition

**目标问题**：在单个紧凑网络（<0.5B，可跑在手机 NPU 上）内统一支持 T2I 生成与指令式图像编辑，并保持可接受的延迟（$1024\\times1024$ < 1s）。

**为什么重要**：
- 服务端统一模型（FLUX、BAGEL 等）动辄 4B–12B，端侧不可部署；

**已有路线及其瓶颈**：
1. **InstructPix2Pix 式通道拼接**：破坏预训练 T2I 模型的生成先验。
2. **大模型上下文范式**：统一但需要大 backbone，端侧放不下。
`;

	function deserialize(source: string) {
		return createSlateEditor({ plugins: MarkdownKit })
			.getApi(MarkdownPlugin)
			.markdown.deserialize(prepareMarkdownForDeserialize(source));
	}

	function allText(nodes: unknown[]): string {
		return (
			JSON.stringify(nodes)
				.match(/"text":"[^"]*"/g)
				?.join(" ") ?? ""
		);
	}

	it("keeps every block after the paragraph containing `<0.5B`", () => {
		const flat = allText(deserialize(ISSUE_BODY));
		expect(flat).toContain("<0.5B");
		expect(flat).toContain("Problem Definition");
		expect(flat).toContain("为什么重要");
		expect(flat).toContain("InstructPix2Pix");
		expect(flat).toContain("大模型上下文范式");
	});

	it("keeps the note after an unsupported prose tag", () => {
		const source = [
			"use `<input>.pdf <output>` here",
			"",
			"## Workflow",
			"",
			"As an <AI Paper Analyst>, follow <Constraints>.",
			"",
			"tail",
		].join("\n");
		const flat = allText(deserialize(source));
		expect(flat).toContain("<output>");
		expect(flat).toContain("Workflow");
		expect(flat).toContain("<AI Paper Analyst>");
		expect(flat).toContain("tail");
	});

	it("round-trips: the escaped `<` survives a serialize → deserialize cycle", () => {
		const value = deserialize("A（<0.5B）x\n\nafter");
		const serialized = createSlateEditor({ plugins: MarkdownKit, value })
			.getApi(MarkdownPlugin)
			.markdown.serialize();
		expect(allText(deserialize(serialized))).toContain("<0.5B");
	});
});

describe("escapeStrayMdxBraces", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function deserializeBody(source: string) {
		const editor = createSlateEditor({ plugins: MarkdownKit });
		const value = deserializeMarkdownBody(editor, source);
		return {
			value,
			text: value.map((node) => NodeApi.string(node as never)).join("\n"),
		};
	}

	it("turns prose braces into entities that MDX cannot see", () => {
		expect(escapeStrayMdxBraces("集合 {a,b} 与 } 收尾")).toBe(
			"集合 &#123;a,b&#125; 与 &#125; 收尾",
		);
	});

	it("drops the LaTeX backslash so the entity decodes to a literal brace", () => {
		expect(escapeStrayMdxBraces("\\max\\{\\rho_z\\}")).toBe(
			"\\max&#123;\\rho_z&#125;",
		);
	});

	it("leaves code fences, `$$` math, inline code and inline math untouched", () => {
		const source = [
			"```",
			"const x = { a: 1 };",
			"```",
			"$$",
			"\\max\\{\\rho_z\\}",
			"$$",
			"code `{x}` and math $\\{x\\}$ stay",
		].join("\n");
		expect(escapeStrayMdxBraces(source)).toBe(source);
	});

	it("is a no-op without braces", () => {
		expect(escapeStrayMdxBraces("plain $x$ text")).toBe("plain $x$ text");
	});

	it("keeps the literal braces visible after deserialize", () => {
		const { text } = deserializeBody("前文 $x$ 后文 \\max\\{\\rho_z\\} 收尾");
		expect(text).toContain("{");
		expect(text).toContain("}");
		expect(text).not.toContain("&#123;");
	});

	it("does not truncate a note whose LaTeX braces need MDX for a table break", () => {
		// `\(...\)` is editor math (normalized to `$…$` before deserialize), so
		// `\{` inside it never reaches acorn; before the normalization it was
		// plain text whose `{` threw. Plate's recovery then cut the source at
		// `$\rho<1$` and dropped the rest.
		const source = [
			"# title",
			"",
			"| a | b |",
			"| - | - |",
			"| x<br/>y | z |",
			"",
			"* 列表一",
			"* 列表二",
			"",
			"以及 \\(\\mathcal E^{t+1}\\le\\max\\{\\rho_z,\\rho_G\\}\\,\\mathcal E^t\\)。",
			"",
			"## after",
			"",
			"后面的内容应当完整保留。",
		].join("\n");
		const { value, text } = deserializeBody(source);
		expect(text).toContain("列表二");
		expect(text).toContain("后面的内容应当完整保留。");
		expect(JSON.stringify(value)).toContain("inline_equation");
		const inline = value
			.flatMap((node) => ("children" in node ? node.children : []))
			.find(
				(child) => (child as { type?: string }).type === "inline_equation",
			) as { texExpression?: string } | undefined;
		expect(inline?.texExpression).toBe(
			"\\mathcal E^{t+1}\\le\\max\\{\\rho_z,\\rho_G\\}\\,\\mathcal E^t",
		);
	});

	it("falls back to a no-MDX parse so content survives any MDX error", () => {
		// Escaped braces make this JSX attribute invalid on purpose: the first
		// parse throws and only a full no-MDX re-parse keeps every block.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const source =
			'<div style={{color:"red"}}>x</div>\n\nafter paragraph stays';
		const { text } = deserializeBody(source);
		expect(text).toContain("after paragraph stays");
		expect(warn).toHaveBeenCalled();
	});
});

describe("#1171 note TeX delimiters survive an edit", () => {
	const roundTrip = (source: string) => {
		const parser = createSlateEditor({ plugins: MarkdownKit });
		const value = deserializeMarkdownBody(parser, source);
		return createSlateEditor({ plugins: MarkdownKit, value })
			.getApi(MarkdownPlugin)
			.markdown.serialize();
	};

	it("writes bracket and paren formulas back with their own delimiters", () => {
		const source = `行内 \\(x^2\\) 后文\n\n\\[\n\\tilde{v}_l) = g\\phi(v)\n\\]\n\n$y$ 仍是美元公式\n`;
		expect(roundTrip(source)).toBe(source);
	});

	it("keeps bracket display math inside a blockquote", () => {
		expect(roundTrip(`> \\[\n> c^2\n> \\]\n`)).toBe(`> \\[\n> c^2\n> \\]\n`);
	});

	it("leaves delimiters in code literal and never leaks its markers", () => {
		const source = "```\n\\[x\\]\n```\n\n\\[\ny\n\\]\n";
		const value = deserializeMarkdownBody(
			createSlateEditor({ plugins: MarkdownKit }),
			source,
		);
		expect(JSON.stringify(value)).not.toMatch(/[\uE000\uE001]/);
		expect(roundTrip(source)).toBe(source);
	});
});
