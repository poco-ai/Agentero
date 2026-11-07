"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { optionalStringProp, stringProp } from "./shared";

export function QuoteNode({ node }: { node: ElementNode }) {
	const source = optionalStringProp(node.props, "source");
	return (
		<blockquote className="border-muted-foreground/30 border-l-2 pl-3 text-sm text-muted-foreground">
			<p className="leading-relaxed whitespace-pre-wrap">
				{stringProp(node.props, "text")}
			</p>
			{source ? <footer className="mt-1.5 text-xs">— {source}</footer> : null}
		</blockquote>
	);
}
