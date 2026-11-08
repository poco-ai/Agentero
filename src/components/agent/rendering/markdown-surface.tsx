"use client";

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import type { ComponentProps } from "react";
import { memo } from "react";
import { type PluginConfig, Streamdown } from "streamdown";
import { cn } from "@/lib/core/utils";
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
 * Shared Streamdown surface for chat replies and Markdown inside OpenUI Text.
 * Callers prepare the source (citations, math normalization) before rendering;
 * this component only owns the plugin/code/table wiring. Mermaid is intercepted
 * by `MessageResponse`'s code component because `components.code` replaces
 * Streamdown's built-in renderer (and therefore its `renderers` hook).
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
					a: (linkProps) => (
						<AgentCitationLink {...linkProps} onOpenSource={onOpenSource} />
					),
					code: PlainCodeBlock,
					table: PlainTable,
					...components,
				}}
				linkSafety={{ enabled: false }}
				plugins={streamdownPlugins}
				{...props}
			>
				{children}
			</Streamdown>
		);
	},
);

MarkdownSurface.displayName = "MarkdownSurface";
