/**
 * CommonMark 尖括号 destination（`![alt](<path>)`）必须原样解析成图片。
 *
 * `escapeStrayLessThan` 曾经把 destination 里的 `<` 当成 JSX 标签转义成
 * `&lt;`：url 带上尖括号（找不到文件），带空格的 destination 整段退化成普通
 * 段落。
 */

import { MarkdownPlugin } from "@platejs/markdown";
import { createSlateEditor } from "platejs";
import { describe, expect, it, vi } from "vitest";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import * as deserializeModule from "@/lib/markdown/deserialize";
import {
	escapeStrayLessThan,
	prepareMarkdownForDeserialize,
} from "@/lib/markdown/deserialize";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";
import * as remarkPlugins from "@/lib/markdown/remark-plugins";
import { markdownNeedsMdx } from "@/lib/markdown/remark-plugins";

function deserialize(source: string, options?: { throwOnError?: boolean }) {
	const editor = createSlateEditor({ plugins: MarkdownKit });
	return deserializeMarkdownBody(editor, source, options);
}

function findImageNode(value: unknown[]): Record<string, unknown> | null {
	for (const node of value) {
		if (!node || typeof node !== "object") continue;
		const n = node as Record<string, unknown>;
		if (n.type === "img" || n.type === "image") return n;
		if (Array.isArray(n.children)) {
			const found = findImageNode(n.children as unknown[]);
			if (found) return found;
		}
	}
	return null;
}

function imageUrl(source: string): string | undefined {
	const node = findImageNode(deserialize(source) as unknown[]);
	return node ? (node.url as string | undefined) : undefined;
}

describe("markdown 尖括号 destination", () => {
	it("预处理不得把 destination 里的尖括号转义成实体", () => {
		expect(prepareMarkdownForDeserialize("![a](<b.png>)")).toBe(
			"![a](<b.png>)",
		);
		expect(prepareMarkdownForDeserialize("![a](<my file.png>)")).toBe(
			"![a](<my file.png>)",
		);
		expect(escapeStrayLessThan("![a](<b.png>)")).toBe("![a](<b.png>)");
		expect(escapeStrayLessThan("![a](<my file.png>)")).toBe(
			"![a](<my file.png>)",
		);
	});

	it("![a](<b.png>) 解析出的 url 是 b.png", () => {
		const node = findImageNode(deserialize("![a](<b.png>)") as unknown[]);
		expect(node).not.toBeNull();
		expect(node?.url).toBe("b.png");
	});

	it("![a](<my file.png>) 仍是图片节点，url 是 my file.png", () => {
		const node = findImageNode(deserialize("![a](<my file.png>)") as unknown[]);
		expect(node).not.toBeNull();
		expect(node?.url).toBe("my file.png");
	});

	it("destination 的路径段是 HTML void 元素名时 url 也不被改坏", () => {
		// Plate 的 htmlToJsx 会把 `<source/x.png>` 当 void 标签补成
		// `<source/x.png />`，那会把 url 改成一个不存在的文件。
		expect(imageUrl("![a](<source/fig1.png>)")).toBe("source/fig1.png");
		expect(imageUrl("![a](<source/fig with space.png>)")).toBe(
			"source/fig with space.png",
		);
		// 笔记里另有真标签时 MDX 打开，htmlToJsx 仍会跑，实体盾必须挡住它。
		expect(
			imageUrl('<div align="center">x</div>\n\n![a](<source/fig1.png>)'),
		).toBe("source/fig1.png");
	});

	it("destination 里的实体与特殊字符解回原样", () => {
		expect(imageUrl("![a](<a&b.png>)")).toBe("a&b.png");
		expect(imageUrl("![a](<{x}.png>)")).toBe("{x}.png");
		expect(imageUrl("![a](</abs/x.png>)")).toBe("/abs/x.png");
	});

	it("remarkMdx 在尖括号 destination 上不抛错", () => {
		expect(() =>
			deserialize("![a](<my file.png>)", { throwOnError: true }),
		).not.toThrow();
		expect(() =>
			deserialize("![a](<source/fig1.png>)", { throwOnError: true }),
		).not.toThrow();
	});

	it("尖括号 destination 前后普通文本都还在", () => {
		const value = deserialize("![a](<b.png>)\n\ntail") as unknown[];
		const flat = JSON.stringify(value);
		expect(flat).toContain("tail");
		expect(findImageNode(value)).not.toBeNull();
	});

	it("链接的尖括号 destination 也能解析", () => {
		const value = deserialize("[t](<my file.md>)") as unknown[];
		expect(JSON.stringify(value)).toContain("my file.md");
	});

	it("序列化再解析，url 不变", () => {
		const editor = createSlateEditor({ plugins: MarkdownKit });
		const value = deserializeMarkdownBody(editor, "![a](<my file.png>)");
		const serialized = createSlateEditor({ plugins: MarkdownKit, value })
			.getApi(MarkdownPlugin)
			.markdown.serialize();
		expect(serialized).toContain("<my file.png>");
		const reparsed = deserializeMarkdownBody(
			createSlateEditor({ plugins: MarkdownKit }),
			serialized,
		);
		expect(findImageNode(reparsed as unknown[])?.url).toBe("my file.png");
	});

	it("正文里的标签仍要转义，不能被当成 destination", () => {
		expect(escapeStrayLessThan("follow <Constraints> and <Workflow>.")).toBe(
			"follow &lt;Constraints> and &lt;Workflow>.",
		);
		expect(escapeStrayLessThan("As an <AI Paper Analyst>, go")).toBe(
			"As an &lt;AI Paper Analyst>, go",
		);
		expect(escapeStrayLessThan("use `<input>.pdf <output>`")).toBe(
			"use `<input>.pdf <output>`",
		);
		expect(escapeStrayLessThan('<div align="center">x</div>')).toBe(
			'<div align="center">x</div>',
		);
	});

	it("没有配对 label 的 ](<...>) 是正文，不是 destination", () => {
		expect(escapeStrayLessThan("see the list](<Constraints>)")).toBe(
			"see the list](&lt;Constraints>)",
		);
	});

	it("被转义的 \\[ 不是 label 开头", () => {
		expect(escapeStrayLessThan("\\[not a link](<x.png>)")).toBe(
			"\\[not a link](&lt;x.png>)",
		);
	});

	it("destination 与标题之间没有空白时不是 resource", () => {
		expect(escapeStrayLessThan('![a](<b.png>"t")')).toBe('![a](&lt;b.png>"t")');
		expect(escapeStrayLessThan('![a](<b.png> "t")')).toBe('![a](<b.png> "t")');
	});

	it("destination 的 < 不该把整篇笔记拉进 MDX 管线", () => {
		// MDX 会关掉缩进代码块与 HTML 注释，destination 的 < 不是标签。
		expect(markdownNeedsMdx("![a](<b.png>)")).toBe(false);
		expect(markdownNeedsMdx("![a](b.png)")).toBe(false);
		expect(markdownNeedsMdx('<div align="center">x</div>')).toBe(true);
	});

	it("带 destination 的笔记里缩进代码块仍是代码块", () => {
		const value = deserialize("![a](<b.png>)\n\n    indented code\n");
		const types = (value as { type?: string }[]).map((node) => node.type);
		expect(types).toContain("code_block");
	});

	it("带 destination 的笔记里 HTML 注释不消失", () => {
		const value = deserialize("![a](<b.png>)\n\n<!-- c -->\n");
		expect(JSON.stringify(value)).toContain("<!-- c -->");
	});

	it("destination 内容里的转义尖括号也不该拉起 MDX", () => {
		// `\<` 是 destination 内容的一部分，不是标签；探针视图要抹掉整段。
		expect(markdownNeedsMdx("![a](<b\\<c.png>)")).toBe(false);
		const indented = deserialize("![a](<b\\<c.png>)\n\n    indented code\n");
		expect(
			(indented as { type?: string }[]).map((node) => node.type),
		).toContain("code_block");
		const comment = deserialize("![a](<b\\<c.png>)\n\n<!-- c -->\n");
		expect(JSON.stringify(comment)).toContain("<!-- c -->");
	});

	it("纯文本笔记不建字面量掩码", () => {
		// 掩码是 O(全文) 的扫描，纯文本笔记（绝大多数）必须走短路。
		const spy = vi.spyOn(deserializeModule, "buildLiteralMask");
		try {
			expect(markdownNeedsMdx("a".repeat(112 * 1024))).toBe(false);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("代码区里的 < 不是标签，不该拉起 MDX", () => {
		// 代码围栏里贴 Markdown 示例是很常见的写法，里面的 `<` 不是标签。
		expect(markdownNeedsMdx("```\n![a](<b.png>)\n```\n")).toBe(false);
		expect(markdownNeedsMdx("use `<b.png>` here")).toBe(false);
		expect(markdownNeedsMdx("$a<b$ here")).toBe(false);
		const indented = deserialize(
			"```\n![a](<b.png>)\n```\n\n    indented code",
		);
		expect((indented as { type?: string }[]).map((node) => node.type)).toEqual([
			"code_block",
			"code_block",
		]);
		const comment = deserialize("```\n![a](<b.png>)\n```\n\n<!-- c -->");
		expect(JSON.stringify(comment)).toContain("<!-- c -->");
	});

	it("一次反序列化只判一次 MDX 需求", () => {
		// MDX 判定要扫全文，算两遍就是双倍成本。
		// `markdownNeedsMdx` 由 `deserialize-md.ts` 跨模块调用，spy 拦得住；
		// `buildLiteralMask` 由 `remark-plugins.ts` 跨模块调用，spy 也拦得住
		// （`deserialize.ts` 内部那几次是本地调用，spy 看不见，不参与计数）。
		const mdxSpy = vi.spyOn(remarkPlugins, "markdownNeedsMdx");
		const maskSpy = vi.spyOn(deserializeModule, "buildLiteralMask");
		try {
			deserialize("![a](<b.png>)\n\ntext");
			expect(mdxSpy).toHaveBeenCalledTimes(1);
			expect(maskSpy).toHaveBeenCalledTimes(1);

			mdxSpy.mockClear();
			maskSpy.mockClear();
			deserialize("plain text only");
			expect(mdxSpy).toHaveBeenCalledTimes(1);
			// 纯文本走短路，一次掩码都不建。
			expect(maskSpy).not.toHaveBeenCalled();
		} finally {
			mdxSpy.mockRestore();
			maskSpy.mockRestore();
		}
	});

	it("暂不支持：> 与 ) 之间换行的 destination", () => {
		// micromark 接受（`markdownLineEndingOrSpace`），这里只认空格与 tab，
		// 所以 `<` 照旧转义，url 带上尖括号——与修复前一致。
		expect(escapeStrayLessThan("![a](<b.png>\n)")).toBe("![a](&lt;b.png>\n)");
	});

	it("不合法 resource 的写法不触发 MDX 报错", () => {
		expect(() =>
			deserialize('![a](<b.png>"t")', { throwOnError: true }),
		).not.toThrow();
		expect(() =>
			deserialize("\\[not a link](<x.png>)", { throwOnError: true }),
		).not.toThrow();
	});

	it("代码里的 ](<...>) 是文本，不改写", () => {
		const source = "```\n![a](<b.png>)\n```";
		expect(escapeStrayLessThan(source)).toBe(source);
		const inline = "use `![a](<b.png>)` here";
		expect(escapeStrayLessThan(inline)).toBe(inline);
	});
});
