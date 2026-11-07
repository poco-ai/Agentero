"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { optionalStringProp } from "./shared";

export function DividerNode({ node }: { node: ElementNode }) {
	const label = optionalStringProp(node.props, "label");
	return (
		<div className="flex items-center gap-3 py-1">
			<div className="h-px flex-1 bg-border" />
			{label ? (
				<span className="text-xs text-muted-foreground">{label}</span>
			) : null}
			<div className="h-px flex-1 bg-border" />
		</div>
	);
}
