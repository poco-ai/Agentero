/** biome-ignore-all lint/suspicious/noArrayIndexKey: read-only metadata rows render in source order. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { Fragment } from "react";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function KeyValueNode({ node }: { node: ElementNode }) {
	const items = Array.isArray(node.props.items)
		? node.props.items.filter(isRecord)
		: [];
	return (
		<dl className="grid grid-cols-[minmax(0,auto)_1fr] items-baseline gap-x-4 gap-y-1.5 text-sm">
			{items.map((item, index) => (
				<Fragment key={`${String(item.label)}-${index}`}>
					<dt className="text-muted-foreground">{String(item.label ?? "")}</dt>
					<dd className="min-w-0 text-right font-medium break-words tabular-nums">
						{String(item.value ?? "")}
					</dd>
				</Fragment>
			))}
		</dl>
	);
}
