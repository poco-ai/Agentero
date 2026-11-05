import wikiLink from "@flowershow/remark-wiki-link";
import { remarkMdx, remarkMention } from "@platejs/markdown";
import remarkDirective from "remark-directive";
import remarkEmoji from "remark-emoji";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkObsidianCallout } from "@/lib/markdown/callout";
import { remarkColumns } from "@/lib/markdown/columns";
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
 */
export function markdownNeedsMdx(source: string): boolean {
	return /<[A-Za-z/]/.test(source);
}

/**
 * Pick the deserialize-time remark plugins a document actually needs.
 *
 * `remarkMdx` tokenizes JSX, `remarkEmoji` scans the whole text for `:shortcodes:`
 * and `remarkMath` parses `$…$`; on a plain note (the common case) they are pure
 * overhead. Each plugin is dropped only when its trigger syntax is absent, so
 * parsing behavior is unchanged. Serialization still uses the full pipeline.
 */
export function selectMarkdownRemarkPluginsForDeserialize(
	source: string,
): RemarkPluginList {
	const hasMath = source.includes("$");
	const hasWiki = source.includes("[[");
	const hasMdxTag = markdownNeedsMdx(source);
	const hasColon = source.includes(":");
	const plugins: unknown[] = [];
	if (hasMath) plugins.push(remarkMath);
	plugins.push(remarkGfm);
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
