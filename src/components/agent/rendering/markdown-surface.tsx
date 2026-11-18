"use client";

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import type { ComponentProps } from "react";
import { memo } from "react";
import {
	type AllowedTags,
	defaultRemarkPlugins,
	type ExtraProps,
	type PluginConfig,
	Streamdown,
} from "streamdown";
import { MathCopy } from "@/components/markdown/math-copy";
import { cn } from "@/lib/core/utils";
import { remarkHighlightToHtml } from "@/lib/markdown/highlight-to-html";
import { AgentCitationLink } from "./agent-citation-link";
import { PlainCodeBlock } from "./plain-code-block";
import { PlainTable } from "./plain-table";

export type MarkdownSurfaceProps = ComponentProps<typeof Streamdown> & {
	/** Open a vault-relative source path from an inline citation pill. */
	onOpenSource?: (source: string) => void;
};

const streamdownMath = createMathPlugin({ singleDollarTextMath: true });
const streamdownPlugins: PluginConfig = {
	cjk,
	code,
	math: streamdownMath,
};

/**
 * Passing `remarkPlugins` replaces Streamdown's defaults, so keep gfm and
 * codeMeta ahead of the highlight transformer. Streamdown still appends the
 * CJK/math remark plugins from `streamdownPlugins` afterwards.
 */
const streamdownRemarkPlugins = [
	...Object.values(defaultRemarkPlugins),
	remarkHighlightToHtml,
];

/**
 * Models write `<u>` / `<mark>` inline HTML, but Streamdown's sanitize schema
 * has neither tag, so the default pipeline strips the tags and leaves bare text
 * (#1168). A non-empty `allowedTags` widens that schema and keeps the
 * raw → sanitize → harden pipeline, so allow the two presentational tags (the
 * default schema already covers sub/sup/kbd) and keep everything else
 * sanitized.
 */
const streamdownAllowedTags: AllowedTags = { u: [], mark: [] };

function MathSpan({
	node: _node,
	...props
}: ComponentProps<"span"> & ExtraProps) {
	const span = <span {...props} />;
	return props.className?.split(/\s+/).includes("katex") ? (
		<MathCopy>{span}</MathCopy>
	) : (
		span
	);
}

/**
 * Shared Streamdown surface for chat replies and Markdown inside OpenUI Text.
 * Callers prepare the source (citations, math normalization) before rendering;
 * this component only owns the plugin/code/table wiring. `==highlight==` is
 * rewritten to `<mark>` by the shared remark transformer, and `<u>` / `<mark>`
 * in model output render through the sanitized raw-HTML pipeline. Mermaid is
 * intercepted by `MessageResponse`'s code component because `components.code`
 * replaces Streamdown's built-in renderer (and therefore its `renderers` hook).
 */
export const MarkdownSurface = memo(
	({
		className,
		children,
		components,
		onOpenSource,
		...props
	}: MarkdownSurfaceProps) => {
		return (
			<Streamdown
				mode={props.isAnimating ? "streaming" : "static"}
				className={cn(
					"w-full min-w-0 select-text text-base leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
					className,
				)}
				components={{
					span: MathSpan,
					a: (linkProps) => (
						<AgentCitationLink {...linkProps} onOpenSource={onOpenSource} />
					),
					code: PlainCodeBlock,
					table: PlainTable,
					...components,
				}}
				linkSafety={{ enabled: false }}
				plugins={streamdownPlugins}
				allowedTags={streamdownAllowedTags}
				remarkPlugins={streamdownRemarkPlugins}
				{...props}
			>
				{children}
			</Streamdown>
		);
	},
);

MarkdownSurface.displayName = "MarkdownSurface";
