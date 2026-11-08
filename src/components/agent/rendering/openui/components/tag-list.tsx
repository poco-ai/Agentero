"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { stringList } from "./shared";
import { TagBadge } from "./tone-badge";

export function TagListNode({ node }: { node: ElementNode }) {
	return (
		<div className="flex flex-wrap gap-1.5">
			{stringList(node.props.tags).map((tag) => (
				<TagBadge key={tag}>{tag}</TagBadge>
			))}
		</div>
	);
}
