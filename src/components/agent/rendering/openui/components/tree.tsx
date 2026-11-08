/** biome-ignore-all lint/suspicious/noArrayIndexKey: read-only tree items render in source order. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { cn } from "@/lib/core/utils";
import { BLOCK_TITLE_CLASS } from "../styles";
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
			{title ? <div className={BLOCK_TITLE_CLASS}>{title}</div> : null}
			<ul className="space-y-0.5 text-sm">
				{items.map((item, index) => {
					const depth =
						typeof item.depth === "number" && item.depth >= 0
							? Math.floor(item.depth)
							: 0;
					return (
						<li
							key={`${String(item.label)}-${index}`}
							className="flex min-w-0 items-start gap-2 leading-relaxed"
							style={{ paddingLeft: `${depth * 1.25}rem` }}
						>
							<span
								className={cn(
									"mt-1.5 size-1 shrink-0 rounded-full",
									depth === 0 ? "bg-foreground/55" : "bg-muted-foreground/45",
								)}
								aria-hidden
							/>
							<span className="min-w-0">{String(item.label ?? "")}</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
