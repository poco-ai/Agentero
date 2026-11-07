"use client";

import type { ElementNode } from "@openuidev/lang-core";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/core/utils";
import { stringProp } from "./shared";

const TONE_CLASS = {
	neutral: "border-border bg-muted text-foreground",
	info: "border-primary/30 bg-primary/10 text-primary",
	success:
		"border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	warning:
		"border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
	danger: "border-destructive/35 bg-destructive/10 text-destructive",
} as const;

export function BadgeNode({ node }: { node: ElementNode }) {
	const tone = stringProp(node.props, "tone") || "neutral";
	return (
		<Badge
			variant="outline"
			className={cn(
				"h-5 rounded-md px-1.5 text-[11px]",
				TONE_CLASS[tone as keyof typeof TONE_CLASS] ?? TONE_CLASS.neutral,
			)}
		>
			{stringProp(node.props, "label")}
		</Badge>
	);
}
