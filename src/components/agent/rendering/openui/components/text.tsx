"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { MarkdownText } from "../markdown-text";
import { stringProp } from "./shared";

export function TextNode({ node }: { node: ElementNode }) {
	const markdown = stringProp(node.props, "markdown");
	const variant = stringProp(node.props, "variant") || "body";
	if (variant === "heading") {
		return (
			<div className="font-heading text-base font-semibold tracking-tight">
				<MarkdownText text={markdown} className="text-base" />
			</div>
		);
	}
	if (variant === "caption") {
		return (
			<MarkdownText text={markdown} className="text-xs text-muted-foreground" />
		);
	}
	return <MarkdownText text={markdown} />;
}
