"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { stringProp } from "./shared";

export function TextNode({ node }: { node: ElementNode }) {
	const text = stringProp(node.props, "text");
	const variant = stringProp(node.props, "variant") || "body";
	if (variant === "code") {
		return (
			<pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-sm whitespace-pre-wrap">
				<code>{text}</code>
			</pre>
		);
	}
	if (variant === "heading") {
		return (
			<p className="font-heading text-base font-semibold whitespace-pre-wrap">
				{text}
			</p>
		);
	}
	if (variant === "caption") {
		return (
			<p className="text-xs text-muted-foreground whitespace-pre-wrap">
				{text}
			</p>
		);
	}
	return <p className="text-sm leading-relaxed whitespace-pre-wrap">{text}</p>;
}
