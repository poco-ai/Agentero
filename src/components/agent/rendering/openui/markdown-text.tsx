"use client";

import { useMemo } from "react";
import { prepareAgentMessageMarkdown } from "@/lib/agent/message-markdown";
import { cn } from "@/lib/core/utils";
import { MarkdownSurface } from "../markdown-surface";
import { useOpenUiSource } from "./source-context";

/**
 * Markdown inside a structured block. It deliberately disables OpenUI UI-block
 * rendering: `Text` is for prose, math, code, quotes and lists that Markdown
 * already models; another nested block would be ambiguous.
 */
export function MarkdownText({
	text,
	className,
}: {
	text: string;
	className?: string;
}) {
	const onOpenSource = useOpenUiSource();
	const content = useMemo(() => prepareAgentMessageMarkdown(text), [text]);
	return (
		<MarkdownSurface
			className={cn(
				"text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
				className,
			)}
			onOpenSource={onOpenSource}
		>
			{content}
		</MarkdownSurface>
	);
}
