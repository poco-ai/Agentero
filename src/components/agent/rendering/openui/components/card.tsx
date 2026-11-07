"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NodeChildren } from "../node-children";
import { stringProp } from "./shared";

export function CardNode({ node }: { node: ElementNode }) {
	return (
		<Card size="sm" className="w-full gap-2 py-3">
			<CardHeader className="px-3 pb-0">
				<CardTitle className="text-sm">
					{stringProp(node.props, "title")}
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-3 px-3">
				<NodeChildren value={node.props.children} />
			</CardContent>
		</Card>
	);
}
