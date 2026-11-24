/**
 * Markdown 图片的 alt 必须在渲染时可见，且往返不变。
 *
 * 上游 @platejs/markdown 的 defaultRules.img.deserialize 把 alt 写进
 * `caption`，没有 `alt` 字段；渲染层（image-node.tsx）读的是 `element.alt`，
 * 于是 `<img alt="">` 恒空、选中图片时的源码提示也退化成 `![](url)`。
 * 编辑器的 `img` 规则补上 `alt`，`caption` 原样保留，序列化仍从 caption
 * 取 alt —— 存回磁盘的 Markdown 必须逐字不变。
 */
import { MarkdownPlugin } from "@platejs/markdown";
import { createSlateEditor } from "platejs";
import { Plate } from "platejs/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ImageElement } from "@/components/editor/nodes/block/image-node";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";
import { imageSourceText, readImageAlt } from "@/lib/markdown/image";
import { stripInlinePlaceholders } from "@/lib/markdown/serialize";

const ALT = "a caption";
/** 相对路径：图片链接必须能逐字往返回磁盘。 */
const FIGURE_URL = "source/fig1.png";
const SOURCE = `![${ALT}](${FIGURE_URL})\n`;
/**
 * 渲染用例的地址：远端链接在首帧就带上 src，SSR 才会输出 <img>。
 * alt 是同步写出的属性，与图片能否加载无关。
 */
const RENDER_URL = "https://example.com/fig1.png";

function deserialize(source: string) {
	const editor = createSlateEditor({ plugins: MarkdownKit });
	return deserializeMarkdownBody(editor, source);
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

/** Serialize a deserialized document the way the editor saves it. */
function reserialize(source: string): string {
	const plugins = MarkdownKit;
	const parser = createSlateEditor({ plugins });
	const value = deserializeMarkdownBody(parser, source);
	const editor = createSlateEditor({
		plugins,
		value,
		shouldNormalizeEditor: true,
	});
	return stripInlinePlaceholders(
		editor.getApi(MarkdownPlugin).markdown.serialize(),
	);
}

describe("Markdown 图片的 alt", () => {
	it("反序列化出的图片节点带 alt，同时保留 caption", () => {
		const node = findImageNode(deserialize(SOURCE));
		expect(node).not.toBeNull();
		expect(node?.alt).toBe(ALT);
		// caption 必须原样保留：上游 img.serialize 从 caption 取 alt。
		// alt 是 caption 的镜像，两者必须一致：只写一个字段就会静默丢字。
		expect(node?.caption).toEqual([{ text: node?.alt }]);
	});

	it("渲染到 <img> 上的 alt 是源码里的 alt 文字", () => {
		const editor = createSlateEditor({ plugins: MarkdownKit });
		const value = deserializeMarkdownBody(editor, `![${ALT}](${RENDER_URL})`);
		const node = findImageNode(value);
		expect(node).not.toBeNull();
		const html = renderToStaticMarkup(
			createElement(
				Plate,
				{ editor, initialValue: value },
				createElement(ImageElement, {
					element: node as never,
					attributes: {} as never,
				}),
			),
		);
		expect(html).toContain(`alt="${ALT}"`);
		expect(html).not.toContain('alt=""');
	});

	it("选中图片时的源码提示是 ![alt](url)", () => {
		const node = findImageNode(deserialize(SOURCE));
		expect(node).not.toBeNull();
		expect(readImageAlt(node ?? {})).toBe(ALT);
		expect(imageSourceText(node ?? {})).toBe(`![${ALT}](${FIGURE_URL})`);
	});

	it("往返不变：存回磁盘的 Markdown 与原文逐字相同", () => {
		expect(reserialize(SOURCE)).toBe(SOURCE);
	});

	it("往返不变：没有 alt 的图片也不会多出文字", () => {
		const source = `![](${FIGURE_URL})\n`;
		const node = findImageNode(deserialize(source));
		expect(node?.alt).toBe("");
		expect(node?.caption).toEqual([{ text: node?.alt }]);
		expect(reserialize(source)).toBe(source);
	});

	it("往返不变：图片组内的 alt 也保持不变", () => {
		const source = `![${ALT}](${FIGURE_URL})\n![second](${FIGURE_URL})\n`;
		const nodes = deserialize(source);
		// 相邻图片行折叠成一个图片组，组内每张图各自走 img 规则。
		expect(nodes.map((node) => (node as { type?: string }).type)).toContain(
			"image_group",
		);
		expect(reserialize(source)).toBe(source);
	});
});
