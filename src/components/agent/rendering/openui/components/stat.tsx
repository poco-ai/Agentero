"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { Card, CardContent } from "@/components/ui/card";
import { optionalStringProp, stringProp } from "./shared";

export function StatNode({ node }: { node: ElementNode }) {
	const hint = optionalStringProp(node.props, "hint");
	return (
		<Card size="sm" className="min-w-36 gap-1">
			<CardContent>
				<div className="truncate text-xs text-muted-foreground">
					{stringProp(node.props, "label")}
				</div>
				<div className="mt-1 break-words font-heading text-2xl font-semibold leading-none tracking-tight tabular-nums">
					{stringProp(node.props, "value")}
				</div>
				{hint ? (
					<div className="mt-1.5 truncate text-xs text-muted-foreground">
						{hint}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
