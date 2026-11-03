"use client";

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { ComponentProps } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { prepareAgentMessageMarkdown } from "@/lib/agent/message-markdown";
import { cn } from "@/lib/core/utils";
import { AgentCitationLink } from "./agent-citation-link";
import { PlainCodeBlock } from "./plain-code-block";
import { PlainTable } from "./plain-table";

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
	/** Open a vault-relative source path from an inline citation pill. */
	onOpenSource?: (source: string) => void;
};

/**
 * KaTeX via Streamdown. Default `@streamdown/math` turns single-dollar off
 * (`singleDollarTextMath: false`), so common agent math like `$\pi_\theta$`
 * rendered as raw text. Enable `$…$` for inline and keep `$$…$$` for display.
 */
const streamdownMath = createMathPlugin({ singleDollarTextMath: true });
const streamdownPlugins = {
	cjk,
	code,
	math: streamdownMath,
	mermaid,
};

export const MessageResponse = memo(
	({ className, children, onOpenSource, ...props }: MessageResponseProps) => {
		const content =
			typeof children === "string"
				? prepareAgentMessageMarkdown(children)
				: children;
		return (
			<Streamdown
				// Streamdown's default `mode="streaming"` runs `remend` on every
				// render. remend truncates a TeX `<` comparison (`x_{<n}`) as an
				// unclosed HTML tag, so KaTeX gets `…x_{` and fails (#584). That
				// repair only makes sense while text is still arriving; settled
				// messages render statically with the math source intact.
				mode={props.isAnimating ? "streaming" : "static"}
				className={cn(
					// Keep the renderer's height content-driven. `size-full` sets
					// height: 100%, which can clip later blocks in auto-sized embeds.
					"w-full min-w-0 select-text text-base leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
					className,
				)}
				components={{
					a: (linkProps) => (
						<AgentCitationLink {...linkProps} onOpenSource={onOpenSource} />
					),
					code: PlainCodeBlock,
					table: PlainTable,
				}}
				linkSafety={{ enabled: false }}
				plugins={streamdownPlugins}
				{...props}
			>
				{content}
			</Streamdown>
		);
	},
);

MessageResponse.displayName = "MessageResponse";
