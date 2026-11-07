"use client";

import type { ComponentProps, ComponentPropsWithoutRef } from "react";
import { createContext, memo, useContext } from "react";
import { type Streamdown, useIsCodeFenceIncomplete } from "streamdown";
import { prepareAgentMessageMarkdown } from "@/lib/agent/message-markdown";
import {
	AGENT_OPENUI_BLOCKS_ENABLED,
	isOpenUiLanguage,
} from "@/lib/agent/openui/config";
import {
	normalizeOpenUiTags,
	protectOpenUiBlocks,
} from "@/lib/agent/openui/parse";
import { MarkdownSurface } from "./markdown-surface";
import { OpenUiBlock } from "./openui/openui-block";
import { OpenUiSourceProvider, useOpenUiSource } from "./openui/source-context";
import {
	extractLanguage,
	extractText,
	PlainCodeBlock,
} from "./plain-code-block";

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
	/** Open a vault-relative source path from an inline citation pill. */
	onOpenSource?: (source: string) => void;
	/**
	 * Opt in to read-only OpenUI Lang blocks. Only assistant reply surfaces
	 * enable this; user messages, reasoning and tool output stay plain Markdown.
	 */
	enableOpenUiBlocks?: boolean;
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
	const onOpenSource = useOpenUiSource();
	const isIncomplete = useIsCodeFenceIncomplete();
	if (openUiEnabled && "data-block" in props) {
		const language = extractLanguage(props.className);
		if (isOpenUiLanguage(language)) {
			const source = extractText(props.children).replace(/\n$/, "");
			return (
				<OpenUiBlock
					source={source}
					streaming={isIncomplete}
					onOpenSource={onOpenSource}
				/>
			);
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
				<OpenUiSourceProvider onOpenSource={onOpenSource}>
					<MarkdownSurface
						className={className}
						components={{ code: AgentCodeBlock }}
						onOpenSource={onOpenSource}
						{...props}
					>
						{content}
					</MarkdownSurface>
				</OpenUiSourceProvider>
			</OpenUiCodeContext.Provider>
		);
	},
);

MessageResponse.displayName = "MessageResponse";
