"use client";

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import type { ComponentProps, ComponentPropsWithoutRef } from "react";
import { createContext, memo, useContext } from "react";
import {
	type PluginConfig,
	Streamdown,
	useIsCodeFenceIncomplete,
} from "streamdown";
import { MermaidCodeRenderer } from "@/components/markdown/mermaid-diagram";
import { prepareAgentMessageMarkdown } from "@/lib/agent/message-markdown";
import {
	AGENT_OPENUI_BLOCKS_ENABLED,
	isOpenUiLanguage,
} from "@/lib/agent/openui/config";
import {
	normalizeOpenUiTags,
	protectOpenUiBlocks,
} from "@/lib/agent/openui/parse";
import { cn } from "@/lib/core/utils";
import { AgentCitationLink } from "./agent-citation-link";
import { OpenUiBlock } from "./openui/openui-block";
import {
	extractLanguage,
	extractText,
	PlainCodeBlock,
} from "./plain-code-block";
import { PlainTable } from "./plain-table";

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
	/** Open a vault-relative source path from an inline citation pill. */
	onOpenSource?: (source: string) => void;
	/**
	 * Opt in to read-only OpenUI Lang blocks. Only assistant reply surfaces
	 * enable this; user messages, reasoning and tool output stay plain Markdown.
	 */
	enableOpenUiBlocks?: boolean;
};

/**
 * KaTeX via Streamdown. Default `@streamdown/math` turns single-dollar off
 * (`singleDollarTextMath: false`), so common agent math like `$\pi_\theta$`
 * rendered as raw text. Enable `$…$` for inline and keep `$$…$$` for display.
 */
const streamdownMath = createMathPlugin({ singleDollarTextMath: true });
const streamdownPlugins: PluginConfig = {
	cjk,
	code,
	math: streamdownMath,
	// Mermaid owns its block chrome (theme-aware colors, source toggle) instead
	// of Streamdown's default diagram card.
	renderers: [{ language: "mermaid", component: MermaidCodeRenderer }],
};

const OpenUiCodeContext = createContext(false);

type AgentCodeProps = ComponentPropsWithoutRef<"code"> & { node?: unknown };

/**
 * Streamdown's `components.code` replaces its built-in code renderer, so the
 * `renderers` hook never sees fenced blocks here. Intercept OpenUI fences in
 * the code component instead; every other language keeps the existing
 * {@link PlainCodeBlock} chrome. `useIsCodeFenceIncomplete` is the same signal
 * Streamdown's custom renderers receive.
 */
function AgentCodeBlock(props: AgentCodeProps) {
	const openUiEnabled = useContext(OpenUiCodeContext);
	const isIncomplete = useIsCodeFenceIncomplete();
	if (openUiEnabled && "data-block" in props) {
		const language = extractLanguage(props.className);
		if (isOpenUiLanguage(language)) {
			const source = extractText(props.children).replace(/\n$/, "");
			return <OpenUiBlock source={source} streaming={isIncomplete} />;
		}
	}
	return <PlainCodeBlock {...props} />;
}

export const MessageResponse = memo(
	({
		className,
		children,
		onOpenSource,
		enableOpenUiBlocks = false,
		...props
	}: MessageResponseProps) => {
		const openUiEnabled = AGENT_OPENUI_BLOCKS_ENABLED && enableOpenUiBlocks;
		let content = children;
		if (typeof children === "string") {
			if (openUiEnabled) {
				// Keep model-authored block source away from Markdown preprocessors
				// (math / bare-link / wikilink rewrites). The source is also what
				// the fallback and message copy show.
				const protectedBlocks = protectOpenUiBlocks(
					normalizeOpenUiTags(children),
				);
				content = protectedBlocks.restore(
					prepareAgentMessageMarkdown(protectedBlocks.text),
				);
			} else {
				content = prepareAgentMessageMarkdown(children);
			}
		}
		return (
			<OpenUiCodeContext.Provider value={openUiEnabled}>
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
						code: AgentCodeBlock,
						table: PlainTable,
					}}
					linkSafety={{ enabled: false }}
					plugins={streamdownPlugins}
					{...props}
				>
					{content}
				</Streamdown>
			</OpenUiCodeContext.Provider>
		);
	},
);

MessageResponse.displayName = "MessageResponse";
