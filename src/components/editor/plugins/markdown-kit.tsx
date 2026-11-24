import {
	BaseFootnoteDefinitionPlugin,
	BaseFootnoteReferencePlugin,
} from "@platejs/footnote";
import {
	type DeserializeMdOptions,
	defaultRules,
	MarkdownPlugin,
	type MdDecoration,
	type MdImage,
	type MdRules,
} from "@platejs/markdown";
import { getPluginType, KEYS } from "platejs";
import { MarkdownPastePlugin } from "@/components/editor/plugins/markdown-paste-plugin";
import { obsidianCalloutRules } from "@/lib/markdown/callout";
import { columnsRules } from "@/lib/markdown/columns";
import { htmlRules } from "@/lib/markdown/html";
import { readImageAlt } from "@/lib/markdown/image";
import { imageGroupRules } from "@/lib/markdown/image-group";
import { MARKDOWN_REMARK_PLUGINS } from "@/lib/markdown/remark-plugins";
import {
	paragraphMarkdownRule,
	texDelimiterMarkdownRules,
} from "@/lib/markdown/serialize";
import { researchTableRules } from "@/lib/research-table/markdown";
import { wikiLinkRules } from "@/lib/wiki/wikilink-model";

/**
 * Markdown 图片的 alt 补齐。
 *
 * 上游 @platejs/markdown 的 `defaultRules.img.deserialize` 只把 alt 写进
 * `caption`，节点上没有 `alt` 字段；渲染层读的是 `element.alt`，于是
 * `<img alt="">` 恒空、选中图片时的源码提示也退化成 `![](url)`。这是上游
 * 的能力缺口，这里在反序列化后补一个 `alt`。
 *
 * `caption` 原样保留：上游 `img.serialize` 与 image-group 的序列化都从
 * `caption` 取 alt，删掉它会让存回磁盘的 Markdown 丢掉 alt 文字。
 *
 * `caption` 是落盘真源，`alt` 只是展示侧的镜像。任何写 alt 的路径（例如
 * 将来的「编辑 alt」）必须同时更新 `caption`，否则界面显示新值、落盘仍是
 * 旧值，静默丢字。
 */
export const imgMarkdownRule: NonNullable<MdRules["img"]> = {
	...defaultRules.img,
	deserialize: (
		mdastNode: MdImage,
		deco: MdDecoration,
		options: DeserializeMdOptions,
	) => {
		const node = defaultRules.img?.deserialize?.(mdastNode, deco, options);
		// 上游没返回节点时不抛错：规则里抛出的异常不会被
		// deserializeMarkdownBody 的 onError 兜住（它只兜 MDX 解析错误），
		// 一抛整篇文档都打不开。退化成一张空图，让上层照常处理。
		if (!node) {
			// 兜底必须带上 mdast 里的原始信息：空 url / 空 alt 会让用户原文
			// 里的图片地址和说明永久丢失，比抛错更难发现。
			const alt = mdastNode.alt ?? "";
			return {
				// 上游用 getPluginType 解析插件类型；没有 editor 时用固定类型。
				type: options.editor
					? getPluginType(options.editor, KEYS.img)
					: KEYS.img,
				url: mdastNode.url ?? "",
				caption: [{ text: alt }],
				alt,
				children: [{ text: "" }],
				...(mdastNode.title ? { title: mdastNode.title } : {}),
			};
		}
		return { ...node, alt: readImageAlt(node) };
	},
};

export const MarkdownKit = [
	BaseFootnoteReferencePlugin.configure({
		options: {
			triggerQuery: (editor) => {
				const { selection } = editor;
				if (!selection || !editor.api.isCollapsed()) return true;
				const start = editor.api.before(selection, {
					distance: 2,
					unit: "character",
				});
				if (!start) return true;
				return (
					editor.api.string({
						anchor: start,
						focus: selection.anchor,
					}) !== "[["
				);
			},
		},
	}),
	BaseFootnoteDefinitionPlugin,
	MarkdownPlugin.configure({
		options: {
			plainMarks: [KEYS.suggestion, KEYS.comment],
			remarkPlugins: MARKDOWN_REMARK_PLUGINS,
			rules: {
				p: paragraphMarkdownRule,
				...texDelimiterMarkdownRules,
				...researchTableRules,
				...wikiLinkRules,
				...obsidianCalloutRules,
				...imageGroupRules,
				...columnsRules,
				...htmlRules,
				img: imgMarkdownRule,
			},
		},
	}),
	MarkdownPastePlugin,
];
