"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/core/utils";
import {
	type OpenUiTone,
	PILL_CLASS,
	TAG_PILL_CLASS,
	TONE_BADGE_CLASS,
} from "../styles";

/** One pill shape for block status, kinds and tones. */
export function ToneBadge({
	tone,
	children,
	className,
}: {
	tone: OpenUiTone;
	children: ReactNode;
	className?: string;
}) {
	return (
		<Badge
			variant="outline"
			className={cn(PILL_CLASS, TONE_BADGE_CLASS[tone], className)}
		>
			{children}
		</Badge>
	);
}

/** Neutral tag pill used by TagList and PaperCard. */
export function TagBadge({ children }: { children: ReactNode }) {
	return (
		<Badge variant="outline" className={cn(PILL_CLASS, TAG_PILL_CLASS)}>
			{children}
		</Badge>
	);
}
