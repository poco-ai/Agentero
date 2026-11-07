"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "@/lib/core/utils";
import { stringProp } from "./shared";

const TONES: Record<
	string,
	{ icon: ComponentType<{ className?: string }>; className: string }
> = {
	info: { icon: Info, className: "border-border bg-muted/40" },
	success: {
		icon: CircleCheck,
		className: "border-emerald-500/30 bg-emerald-500/10",
	},
	warning: {
		icon: TriangleAlert,
		className: "border-amber-500/35 bg-amber-500/10",
	},
	danger: {
		icon: CircleX,
		className: "border-destructive/35 bg-destructive/10",
	},
};

export function CalloutNode({ node }: { node: ElementNode }) {
	const tone = stringProp(node.props, "tone") || "info";
	const config = TONES[tone] ?? TONES.info;
	const Icon = config?.icon ?? Info;
	return (
		<div className={cn("rounded-lg border px-3 py-2.5", config?.className)}>
			<div className="flex items-center gap-2 text-sm font-medium">
				<Icon className="size-4 shrink-0" />
				<span className="min-w-0">{stringProp(node.props, "title")}</span>
			</div>
			<p className="mt-1.5 text-sm text-muted-foreground whitespace-pre-wrap">
				{stringProp(node.props, "body")}
			</p>
		</div>
	);
}
