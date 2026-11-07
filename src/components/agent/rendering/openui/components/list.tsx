/** biome-ignore-all lint/suspicious/noArrayIndexKey: read-only list items render in source order. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { booleanProp, stringList } from "./shared";

export function ListNode({ node }: { node: ElementNode }) {
	const items = stringList(node.props.items);
	const ordered = booleanProp(node.props, "ordered") === true;
	const className =
		"space-y-1 pl-5 text-sm leading-relaxed marker:text-muted-foreground";
	return ordered ? (
		<ol className={`${className} list-decimal`}>
			{items.map((item, index) => (
				<li key={`${index}-${item}`} className="whitespace-pre-wrap">
					{item}
				</li>
			))}
		</ol>
	) : (
		<ul className={`${className} list-disc`}>
			{items.map((item, index) => (
				<li key={`${index}-${item}`} className="whitespace-pre-wrap">
					{item}
				</li>
			))}
		</ul>
	);
}
