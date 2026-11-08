"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { clamp, numberProp, stringProp } from "./shared";

export function ProgressNode({ node }: { node: ElementNode }) {
	const value = numberProp(node.props, "value") ?? 0;
	const max = numberProp(node.props, "max") ?? 100;
	const percent = max > 0 ? clamp((value / max) * 100, 0, 100) : 0;
	const label = stringProp(node.props, "label");
	return (
		<div className="min-w-0 space-y-1.5">
			<div className="flex items-baseline justify-between gap-3 text-xs">
				<span className="min-w-0 truncate text-muted-foreground">{label}</span>
				<span className="shrink-0 font-medium tabular-nums text-foreground">
					{Math.round(percent)}%
				</span>
			</div>
			<div
				className="h-1.5 overflow-hidden rounded-full bg-muted"
				role="progressbar"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={max}
				aria-valuenow={value}
			>
				<div
					className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
					style={{ width: `${percent}%` }}
				/>
			</div>
		</div>
	);
}
