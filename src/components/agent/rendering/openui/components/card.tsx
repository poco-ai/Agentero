"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NodeChildren } from "../node-children";
import { stringProp } from "./shared";

export function CardNode({ node }: { node: ElementNode }) {
	const title = stringProp(node.props, "title");
	return (
		<Card size="sm" className="w-full gap-2">
			{title ? (
				<CardHeader>
					<CardTitle className="break-words">{title}</CardTitle>
				</CardHeader>
			) : null}
			<CardContent className="flex flex-col gap-3">
				<NodeChildren value={node.props.children} />
			</CardContent>
		</Card>
	);
}
