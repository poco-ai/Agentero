/** biome-ignore-all lint/suspicious/noArrayIndexKey: read-only tree items render in source order. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { optionalStringProp } from "./shared";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function TreeNode({ node }: { node: ElementNode }) {
	const title = optionalStringProp(node.props, "title");
	const items = Array.isArray(node.props.items)
		? node.props.items.filter(isRecord)
		: [];
	return (
		<div className="min-w-0 space-y-1.5">
			{title ? <div className="text-sm font-medium">{title}</div> : null}
			<ul className="space-y-1 text-sm">
				{items.map((item, index) => {
					const depth =
						typeof item.depth === "number" && item.depth >= 0
							? Math.floor(item.depth)
							: 0;
					return (
						<li
							key={`${String(item.label)}-${index}`}
							className="relative leading-relaxed"
							style={{ paddingLeft: `${depth * 1.25}rem` }}
						>
							{depth > 0 ? (
								<span className="absolute top-2 -left-2 h-px w-1.5 bg-border" />
							) : null}
							<span className="text-muted-foreground">•</span>{" "}
							{String(item.label ?? "")}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
