"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { cn } from "@/lib/core/utils";
import { NodeChildren } from "../node-children";
import { gapClass } from "./shared";

export function StackNode({ node }: { node: ElementNode }) {
	return (
		<div className={cn("flex min-w-0 flex-col", gapClass(node.props.gap))}>
			<NodeChildren value={node.props.children} />
		</div>
	);
}
