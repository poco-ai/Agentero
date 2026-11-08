"use client";

import { ArrowUpRight } from "lucide-react";
import { isOpenUiSourceTarget } from "@/lib/agent/openui/source";
import { cn } from "@/lib/core/utils";
import { useOpenUiSource } from "../source-context";
import { BLOCK_CAPTION_CLASS, SOURCE_LINK_CLASS } from "../styles";

/**
 * Clickable source target for a block. A non-path label (e.g. the model writes
 * "Table 3, Section 4.2") stays as muted text instead of becoming a link that
 * fails deep in the vault path resolver.
 */
export function SourceReference({
	source,
	actionLabel,
	className,
	showUnopenableText = true,
}: {
	source: string;
	actionLabel: string;
	className?: string;
	showUnopenableText?: boolean;
}) {
	const onOpenSource = useOpenUiSource();
	if (!source) return null;
	if (!isOpenUiSourceTarget(source)) {
		if (!showUnopenableText) return null;
		return (
			<span className={cn("block break-words", BLOCK_CAPTION_CLASS, className)}>
				{source}
			</span>
		);
	}
	if (!onOpenSource) return null;
	return (
		<button
			type="button"
			className={cn(SOURCE_LINK_CLASS, className)}
			onClick={() => onOpenSource(source)}
		>
			{actionLabel}
			<ArrowUpRight className="size-3" aria-hidden />
		</button>
	);
}
