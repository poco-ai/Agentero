"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { OpenUiTable } from "../markdown-table";
import { optionalStringProp, stringList, stringMatrix } from "./shared";

export function TableNode({ node }: { node: ElementNode }) {
	return (
		<OpenUiTable
			columns={stringList(node.props.columns)}
			rows={stringMatrix(node.props.rows)}
			caption={optionalStringProp(node.props, "caption")}
		/>
	);
}
