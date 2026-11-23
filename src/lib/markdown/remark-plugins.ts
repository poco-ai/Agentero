import wikiLink from "@flowershow/remark-wiki-link";
import { remarkMdx, remarkMention } from "@platejs/markdown";
import remarkDirective from "remark-directive";
import remarkEmoji from "remark-emoji";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { findAngleDestinations } from "@/lib/markdown/angle-destination";
import { remarkObsidianCallout } from "@/lib/markdown/callout";
import { remarkColumns } from "@/lib/markdown/columns";
import { buildLiteralMask } from "@/lib/markdown/deserialize";
import { remarkHighlightMark } from "@/lib/markdown/highlight";
import { remarkPreserveHtml } from "@/lib/markdown/html";
import { remarkImageGroup } from "@/lib/markdown/image-group";
import { remarkResearchTable } from "@/lib/research-table/markdown";
import { remarkWikiLinkLiteralPaths } from "@/lib/wiki/wikilink-model";

/**
 * Full remark pipeline for Markdown. Used as the MarkdownPlugin default (so
 * serialization always sees every compiler) and as the deserialize fallback.
 */
export const MARKDOWN_REMARK_PLUGINS = [
	remarkMath,
	remarkGfm,
	remarkHighlightMark,
	[wikiLink, { aliasDivider: "|" }],
	// After flowershow: keep vault `_` paths literal (no `\_` on save).
	remarkWikiLinkLiteralPaths,
	// biome-ignore lint/suspicious/noExplicitAny: remark-emoji's plugin type is incompatible with Plate's remark plugin type
	remarkEmoji as any,
	remarkMdx,
	remarkMention,
	remarkObsidianCallout,
	remarkImageGroup,
	remarkDirective,
	remarkResearchTable,
	remarkColumns,
	remarkPreserveHtml,
];

type RemarkPluginList = typeof MARKDOWN_REMARK_PLUGINS;

/**
 * True when `remarkMdx` is needed to parse the source: an HTML/JSX-looking
 * `<name` or `</name`. After `prepareMarkdownForDeserialize` escapes stray `<`,
 * a remaining match is one of the editor's supported HTML tags.
 *
 * 不是标签的 `<` 不算 MDX 需求：
 * - 尖括号 destination（`![a](<b.png>)`）的 `<` 只是 destination 的开始；
 * - 代码围栏、行内代码、行内公式里的 `<` 是文本。
 *
 * 算进去会让整篇笔记走 MDX 管线，而 MDX 会关掉缩进代码块与 HTML 注释
 * （`micromark-extension-mdx-md` 的 `disable` 列表）。
 *
 * 已知缺口（上游既有，与本改动无关）：4 空格缩进的代码块不在字面量区里，它里面的
 * `<` 仍会算进 MDX 判定，于是整篇笔记走 MDX 管线、缩进代码块降级成正文。
 * origin/main 基线上同样如此——缩进代码块本来就不在 `buildLiteralMask` 的字面量区，
 * 要修得改 `buildLiteralMask` 的全局行为，影响面比这个改动大得多，不在本轮范围。
 */
export function markdownNeedsMdx(source: string): boolean {
	// 纯文本笔记（绝大多数）直接返回：不建字面量掩码，也就不扫 destination。
	if (!source.includes("<")) return false;
	const mask = buildLiteralMask(source);
	return hasMdxTag(source, mask);
}

/**
 * 文档里有没有「真正的标签」：`<` 后面跟着字母或 `/`，而且这个 `<` 既不在
 * 字面量区（代码围栏、行内代码、行内公式）里，也不在尖括号 destination 里。
 *
 * 直接扫候选位置，不重建整篇文本：长文档上重建字符串比整条判定还贵。
 */
function hasMdxTag(source: string, mask: Uint8Array): boolean {
	const destinations = findAngleDestinations(
		source,
		(index) => mask[index] === 1,
	);
	let cursor = 0;
	for (const match of source.matchAll(/<[A-Za-z/]/g)) {
		const index = match.index ?? 0;
		if (mask[index] === 1) continue;
		while (
			cursor < destinations.length &&
			(destinations[cursor]?.end ?? -1) < index
		) {
			cursor += 1;
		}
		const current = destinations[cursor];
		if (current && index >= current.start && index <= current.end) continue;
		return true;
	}
	return false;
}

/**
 * Pick the deserialize-time remark plugins a document actually needs.
 *
 * `remarkMdx` tokenizes JSX, `remarkEmoji` scans the whole text for `:shortcodes:`
 * and `remarkMath` parses `$…$`; on a plain note (the common case) they are pure
 * overhead. Each plugin is dropped only when its trigger syntax is absent, so
 * parsing behavior is unchanged. Serialization still uses the full pipeline.
 *
 * `hasMdxTag` 是调用方已经算好的 MDX 需求：MDX 判定要扫全文，重复算就是双倍
 * 成本。不给就自己算一次。
 */
export function selectMarkdownRemarkPluginsForDeserialize(
	source: string,
	options?: { hasMdxTag?: boolean },
): RemarkPluginList {
	const hasMdxTag = options?.hasMdxTag ?? markdownNeedsMdx(source);
	const hasMath = source.includes("$");
	const hasWiki = source.includes("[[");
	const hasColon = source.includes(":");
	const plugins: unknown[] = [];
	if (hasMath) plugins.push(remarkMath);
	plugins.push(remarkGfm);
	// `==文字==` highlight (#1168/#1170). Skipped for documents without `==`:
	// the scanner is a cheap text-node walk, but the guard keeps plain notes on
	// the same minimal pipeline.
	if (source.includes("==")) plugins.push(remarkHighlightMark);
	if (hasWiki) {
		plugins.push([wikiLink, { aliasDivider: "|" }]);
		plugins.push(remarkWikiLinkLiteralPaths);
	}
	if (hasColon) {
		// biome-ignore lint/suspicious/noExplicitAny: remark-emoji's plugin type is incompatible with Plate's remark plugin type
		plugins.push(remarkEmoji as any);
	}
	if (hasMdxTag) plugins.push(remarkMdx);
	if (source.includes("@")) plugins.push(remarkMention);
	if (source.includes("[!")) plugins.push(remarkObsidianCallout);
	if (source.includes("!")) plugins.push(remarkImageGroup);
	if (hasColon) {
		plugins.push(remarkDirective);
		plugins.push(remarkResearchTable);
	}
	if (source.includes("::")) plugins.push(remarkColumns);
	plugins.push(remarkPreserveHtml);
	return plugins as RemarkPluginList;
}
