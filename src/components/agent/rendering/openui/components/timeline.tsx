/** biome-ignore-all lint/suspicious/noArrayIndexKey: read-only timeline items render in source order. */
"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { MarkdownText } from "../markdown-text";
import { BLOCK_CAPTION_CLASS, BLOCK_TITLE_CLASS } from "../styles";
import { optionalStringProp, stringProp } from "./shared";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function TimelineNode({ node }: { node: ElementNode }) {
	const title = optionalStringProp(node.props, "title");
	const items = Array.isArray(node.props.items)
		? node.props.items.filter(isRecord)
		: [];
	return (
		<div className="min-w-0 space-y-2">
			{title ? <div className={BLOCK_TITLE_CLASS}>{title}</div> : null}
			<ol className="space-y-0">
				{items.map((item, index) => (
					<li
						key={`${String(item.title)}-${index}`}
						className="relative border-border/60 border-l pb-3 pl-4 last:pb-0"
					>
						<span
							className="absolute top-1.5 left-0 size-1.5 -translate-x-1/2 rounded-full bg-primary"
							aria-hidden
						/>
						<div className="text-sm font-medium">
							{String(item.title ?? "")}
						</div>
						{item.description ? (
							<div className="mt-0.5">
								<MarkdownText
									text={stringProp(item, "description")}
									className={BLOCK_CAPTION_CLASS}
								/>
							</div>
						) : null}
					</li>
				))}
			</ol>
		</div>
	);
}
