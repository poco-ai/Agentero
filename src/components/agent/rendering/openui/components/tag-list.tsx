"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { Badge } from "@/components/ui/badge";
import { stringList } from "./shared";

export function TagListNode({ node }: { node: ElementNode }) {
	return (
		<div className="flex flex-wrap gap-1.5">
			{stringList(node.props.tags).map((tag) => (
				<Badge
					key={tag}
					variant="outline"
					className="h-5 rounded-md px-1.5 text-[11px]"
				>
					{tag}
				</Badge>
			))}
		</div>
	);
}
