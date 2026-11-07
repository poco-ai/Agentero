"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { PlainCodeBlockView } from "../../plain-code-block";
import { optionalStringProp, stringProp } from "./shared";

export function CodeNode({ node }: { node: ElementNode }) {
	return (
		<PlainCodeBlockView
			code={stringProp(node.props, "code")}
			language={optionalStringProp(node.props, "language") ?? "text"}
		/>
	);
}
