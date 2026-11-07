/** biome-ignore-all lint/suspicious/noArrayIndexKey: read-only timeline items render in source order. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { optionalStringProp, stringProp } from "./shared";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function TimelineNode({ node }: { node: ElementNode }) {
	const title = optionalStringProp(node.props, "title");
	const items = Array.isArray(node.props.items)
		? node.props.items.filter(isRecord)
		: [];
	return (
		<div className="min-w-0 space-y-2">
			{title ? <div className="text-sm font-medium">{title}</div> : null}
			<ol className="relative space-y-3 border-border border-l pl-4">
				{items.map((item, index) => (
					<li
						key={`${String(item.title)}-${index}`}
						className="relative min-w-0"
					>
						<span className="absolute top-1.5 -left-[1.28rem] size-2 rounded-full bg-primary" />
						<div className="text-sm font-medium">
							{String(item.title ?? "")}
						</div>
						{item.description ? (
							<p className="mt-0.5 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
								{stringProp(item, "description")}
							</p>
						) : null}
					</li>
				))}
			</ol>
		</div>
	);
}
