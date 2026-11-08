/** biome-ignore-all lint/suspicious/noArrayIndexKey: read-only model output is rendered in source order. */
"use client";

import { isElementNode } from "@openuidev/lang-core";
import { Fragment } from "react";
import { useOpenUiRenderNode } from "./node-context";

export function NodeChildren({ value }: { value: unknown }) {
	const render = useOpenUiRenderNode();
	const nodes = Array.isArray(value) ? value.filter(isElementNode) : [];
	return (
		<>
			{nodes.map((node, index) => (
				<Fragment key={`${node.statementId ?? node.typeName}-${index}`}>
					{render(node)}
				</Fragment>
			))}
		</>
	);
}
